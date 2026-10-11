import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  durableResultExists,
  durableWorkerAlive,
  removeDurableWorkerJob,
} from "./durable-worker.js";
import { removeRetry } from "./fs-retry.js";
import {
  type Ledger,
  type Run,
  type Task,
  transitionRunPhase,
  updateLedger,
  readLedger,
} from "./ledger.js";
import { isProcessAlive as defaultIsProcessAlive } from "./process.js";
import {
  readRuntimeState,
  type RuntimeState,
  type WorkerSlot,
  workerSlotsSchema,
  writeRuntimeState,
} from "./runtime-state.js";

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_SLOT_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_OWNER_PIDS = 32;

/** Directory (inside the state directory) that holds managed workspaces. */
export const WORKSPACES_DIRECTORY = "workspaces";

/** What a leftover process was classified as; "playwright" or "web-server" by default. */
export type OwnedProcessKind = string;

export interface LocalProcess {
  pid: number;
  parentPid: number;
  commandLine: string;
}

export interface CleanupCandidate extends LocalProcess {
  kind: OwnedProcessKind;
  ownerPid: number;
}

export interface RuntimeCleanupResult {
  phase: "preflight" | "teardown";
  inspected: number;
  staleOwnerPids: number[];
  liveOwnerPids: number[];
  eligible: CleanupCandidate[];
  terminatedPids: number[];
  failedPids: number[];
  retainedOwnerPids: number[];
  error: string | null;
}

export type ProcessClassifier = (
  root: string,
  commandLine: string,
) => OwnedProcessKind | null;

export interface RuntimeCleanupOptions {
  /** Only processes whose command line mentions this path are candidates. */
  root: string;
  ownerPids: number[];
  phase: RuntimeCleanupResult["phase"];
  timeoutMs?: number;
  listProcesses?: () => Promise<LocalProcess[]>;
  terminateProcessTree?: (pid: number, timeoutMs: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  /** Replaces the default Playwright / dev-server classifier. */
  classify?: ProcessClassifier;
}

export interface WorkerSlotCrashCleanupResult {
  runtime: RuntimeState;
  crashedSlots: WorkerSlot[];
  freedSlotIds: WorkerSlot["slot_id"][];
  cleanupErrors: Partial<Record<WorkerSlot["slot_id"], string>>;
}

export interface WorkerSlotCrashCleanupOptions {
  /** Runtime state directory (holds runtime.json, ledger.json, workspaces/). */
  stateDir: string;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Releases a slot workspace. Defaults to deleting the directory, but only
   * when it lies inside `<stateDir>/workspaces`.
   */
  removeWorkspace?: (path: string) => void | Promise<void>;
  persistRuntime?: (runtime: RuntimeState) => Promise<void>;
  beforeCleanup?: (slot: WorkerSlot) => Promise<void>;
  afterCleanup?: (slot: WorkerSlot) => Promise<void>;
  onCleanupFailure?: (slot: WorkerSlot, error: string) => Promise<void>;
  /** Keep ownership while a successful worker result is still being reconciled. */
  isReclaimable?: (slot: WorkerSlot) => boolean;
}

export interface OrchestratorRestartRecoveryResult
  extends WorkerSlotCrashCleanupResult {
  recoveredTaskIds: string[];
  failedTaskIds: string[];
  liveSlotIds: WorkerSlot["slot_id"][];
  orphanedSlotIds: WorkerSlot["slot_id"][];
}

export interface OrchestratorRestartRecoveryOptions
  extends WorkerSlotCrashCleanupOptions {
  runtime?: RuntimeState;
  updateCanonicalState?: <T>(
    mutate: (ledger: Ledger) => T | Promise<T>,
  ) => Promise<T>;
  validateWorkspaceOwnership?: (slot: WorkerSlot) => boolean | Promise<boolean>;
}

function execFileBounded(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(stdout);
      },
    );
  });
}

function parseWindowsProcesses(output: string): LocalProcess[] {
  if (!output.trim()) return [];
  const decoded = JSON.parse(output) as
    | Record<string, unknown>
    | Array<Record<string, unknown>>;
  return (Array.isArray(decoded) ? decoded : [decoded])
    .map((entry) => ({
      pid: Number(entry.ProcessId),
      parentPid: Number(entry.ParentProcessId),
      commandLine: String(entry.CommandLine ?? ""),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.pid) &&
        entry.pid > 0 &&
        Number.isInteger(entry.parentPid),
    );
}

function parsePosixProcesses(output: string): LocalProcess[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine: match[3] ?? "",
    }));
}

export async function listLocalProcesses(
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
): Promise<LocalProcess[]> {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    return parseWindowsProcesses(
      await execFileBounded(
        "powershell.exe",
        ["-NoProfile", "-Command", script],
        timeoutMs,
      ),
    );
  }
  return parsePosixProcesses(
    await execFileBounded("ps", ["-axo", "pid=,ppid=,command="], timeoutMs),
  );
}

function slotOwnerIsStale(
  slot: WorkerSlot,
  nowMs: number,
  heartbeatIntervalMs: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (slot.status === "crashed" || slot.status === "failed") {
    return true;
  }
  if (
    slot.status !== "starting" &&
    slot.status !== "running" &&
    slot.status !== "completed"
  ) {
    return false;
  }
  if (slot.pid !== null) {
    // A detached worker is identified by pid AND its runner heartbeat, so a
    // recycled pid never keeps a dead worker looking alive.
    return slot.job_dir
      ? !durableWorkerAlive(slot.job_dir, slot.pid, { isAlive })
      : !isAlive(slot.pid);
  }

  // A "completed" slot has its pid cleared and heartbeat_at refreshed the
  // instant its worker exits successfully, strictly before result binding
  // and completion reconciliation run -- reconciliation is typically well
  // inside one heartbeat interval away. Giving it the same
  // heartbeat-freshness grace as a live "running"/"starting" slot (instead
  // of treating "completed" as instantly stale) is what stops a dead pid
  // alone from reclaiming a worker that only just finished. A slot whose
  // heartbeat genuinely predates the interval -- an abandoned session from
  // a controller that is actually gone -- still becomes stale and
  // reclaimable.
  const heartbeatMs = Date.parse(slot.heartbeat_at);
  return (
    !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs >= heartbeatIntervalMs
  );
}

/** How a slot looks right now. Pure observation: nothing is modified. */
export type SlotLiveness =
  /** Result already on disk: finished work awaiting reconciliation. */
  | "finished"
  /** pid alive and its runner heartbeat is fresh. */
  | "alive"
  /** pid alive but the heartbeat is stale: hung, or a recycled pid. */
  | "hung"
  /** pid gone (or no pid and the heartbeat grace expired). */
  | "dead"
  /** Not a running slot (e.g. already marked crashed/failed/completed). */
  | "inactive";

/**
 * Read-only classification used by the dashboard. It reuses exactly the
 * predicates the recovery code applies, so what an operator sees is what
 * recovery would decide.
 */
export function classifySlotLiveness(
  slot: WorkerSlot,
  options: {
    now?: () => Date;
    heartbeatIntervalMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): SlotLiveness {
  if (durableResultExists(slot.job_dir)) return "finished";
  if (slot.status !== "starting" && slot.status !== "running") {
    return "inactive";
  }
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (slot.pid !== null && isAlive(slot.pid)) {
    if (!slot.job_dir) return "alive";
    return durableWorkerAlive(slot.job_dir, slot.pid, { isAlive })
      ? "alive"
      : "hung";
  }
  if (slot.pid !== null) return "dead";
  const interval = Math.max(
    1,
    options.heartbeatIntervalMs ?? DEFAULT_SLOT_HEARTBEAT_INTERVAL_MS,
  );
  return slotOwnerIsStale(
    slot,
    (options.now?.() ?? new Date()).getTime(),
    interval,
    isAlive,
  )
    ? "dead"
    : "alive";
}

function managedWorkspacesDirectory(stateDir: string): string {
  return resolve(stateDir, WORKSPACES_DIRECTORY);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Default workspace remover: deletes the directory, but refuses anything
 * that is not strictly inside `<stateDir>/workspaces` so a corrupted slot
 * record can never point recovery at an arbitrary path.
 */
function defaultRemoveWorkspace(
  stateDir: string,
): (path: string) => Promise<void> {
  return async (path) => {
    const target = resolve(stateDir, path);
    if (!isInside(managedWorkspacesDirectory(stateDir), target)) {
      throw new Error(`workspace outside managed directory: ${path}`);
    }
    await removeRetry(target);
  };
}

/**
 * Reconciles the worker slots once per controller heartbeat. A dead worker
 * is marked crashed before its own managed workspace is removed; only
 * successfully cleaned slots are then freed. Live sibling slots retain the
 * same object and are never passed to the workspace remover.
 */
export async function cleanupCrashedWorkerSlots(
  runtime: RuntimeState,
  options: WorkerSlotCrashCleanupOptions,
): Promise<WorkerSlotCrashCleanupResult> {
  // Cleanup is destructive, so reject ambiguous ownership even when a caller
  // provides an in-memory runtime that did not pass through persistence.
  workerSlotsSchema.parse(runtime.slots);
  const resolvedWorkspaces = new Set<string>();
  for (const slot of runtime.slots) {
    const path = resolve(options.stateDir, slot.workspace_path)
      .replaceAll("\\", "/")
      .toLowerCase();
    if (resolvedWorkspaces.has(path)) {
      throw new Error(
        `Duplicate resolved worker workspace ownership: ${slot.workspace_path}`,
      );
    }
    resolvedWorkspaces.add(path);
  }
  const now = options.now?.() ?? new Date();
  const heartbeatIntervalMs = Math.max(
    1,
    options.heartbeatIntervalMs ?? DEFAULT_SLOT_HEARTBEAT_INTERVAL_MS,
  );
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const staleSlotIds = new Set(
    runtime.slots
      .filter(
        (slot) =>
          // A detached worker that already recorded its result is finished
          // work awaiting reconciliation, never a crash -- even when its
          // runner (and the orchestrator that launched it) are long gone.
          !durableResultExists(slot.job_dir) &&
          (options.isReclaimable?.(slot) ?? true) &&
          slotOwnerIsStale(slot, now.getTime(), heartbeatIntervalMs, isAlive),
      )
      .map((slot) => slot.slot_id),
  );

  if (staleSlotIds.size === 0) {
    return {
      runtime,
      crashedSlots: [],
      freedSlotIds: [],
      cleanupErrors: {},
    };
  }

  const detectedAt = now.toISOString();
  const crashedRuntime: RuntimeState = {
    ...runtime,
    slots: runtime.slots.map((slot) =>
      staleSlotIds.has(slot.slot_id)
        ? { ...slot, status: "crashed", heartbeat_at: detectedAt }
        : slot,
    ),
  };
  const persist =
    options.persistRuntime ??
    ((next: RuntimeState) => writeRuntimeState(options.stateDir, next));
  await persist(crashedRuntime);

  const remove =
    options.removeWorkspace ?? defaultRemoveWorkspace(options.stateDir);
  const freedSlotIds: WorkerSlot["slot_id"][] = [];
  const cleanupErrors: Partial<Record<WorkerSlot["slot_id"], string>> = {};
  for (const slot of crashedRuntime.slots) {
    if (!staleSlotIds.has(slot.slot_id)) continue;
    try {
      await options.beforeCleanup?.(slot);
      await remove(slot.workspace_path);
      await removeDurableWorkerJob(slot.job_dir);
      await options.afterCleanup?.(slot);
      freedSlotIds.push(slot.slot_id);
    } catch (error) {
      let message = (error as Error).message;
      try {
        await options.onCleanupFailure?.(slot, message);
      } catch (recordError) {
        message = `${message}; canonical recovery update failed: ${(recordError as Error).message}`;
      }
      cleanupErrors[slot.slot_id] = message;
    }
  }

  const freed = new Set(freedSlotIds);
  const nextRuntime: RuntimeState = {
    ...crashedRuntime,
    slots: crashedRuntime.slots.filter((slot) => !freed.has(slot.slot_id)),
  };
  await persist(nextRuntime);

  return {
    runtime: nextRuntime,
    crashedSlots: crashedRuntime.slots.filter((slot) =>
      staleSlotIds.has(slot.slot_id),
    ),
    freedSlotIds,
    cleanupErrors,
  };
}

type CanonicalSlotOwner = {
  task: Task;
  run: Run;
  state: "active" | "released" | "done";
};

function canonicalSlotOwner(
  ledger: Ledger,
  slot: WorkerSlot,
): CanonicalSlotOwner | null {
  const task = ledger.tasks.find((candidate) => candidate.id === slot.task_id);
  const run = ledger.runs.find(
    (candidate) =>
      candidate.id === slot.run_id && candidate.task_id === slot.task_id,
  );
  if (!task || !run) return null;
  // A run that reached "done" completed successfully -- its slot is stale
  // bookkeeping, not an ownership conflict. Reporting this as a genuine
  // (terminal) owner, rather than null, lets the workspace actually be
  // reclaimed instead of being retained forever as "orphaned crashed".
  if (run.phase === "done") return { task, run, state: "done" };
  const releasedRecovery =
    run.phase === "failed" &&
    run.status === "released" &&
    run.result ===
      `Recovered stale worker slot ${slot.slot_id} after orchestrator restart.`;
  if (releasedRecovery) return { task, run, state: "released" };
  if (task.active_run_id !== slot.run_id) return null;
  const active =
    (task.status === "in_progress" || task.status === "validating") &&
    run.phase !== "failed";
  const recoveryPending =
    task.status === "blocked" &&
    run.phase === "failed" &&
    run.status === "blocked" &&
    run.result?.startsWith("Crash recovery") === true;
  if (!active && !recoveryPending) return null;
  return { task, run, state: "active" };
}

function failRecoveredRun(run: Run): void {
  if (run.phase === "failed") return;
  if (run.phase === "ready") transitionRunPhase(run, "leased");
  transitionRunPhase(run, "failed");
}

/**
 * Default ownership proof for a slot workspace: it must sit directly in the
 * managed directory and be named `<controller_id>-<slot_id>`. A corrupted
 * record that points at a sibling slot, or at an arbitrary path, fails this
 * check and is retained instead of deleted.
 */
export function hasDurableWorkspaceIdentity(
  stateDir: string,
  slot: WorkerSlot,
): boolean {
  const name = `${slot.controller_id}-${slot.slot_id}`;
  const managedDirectory = managedWorkspacesDirectory(stateDir);
  const recordedPath = resolve(stateDir, slot.workspace_path);
  return (
    dirname(recordedPath).toLowerCase() === managedDirectory.toLowerCase() &&
    basename(recordedPath).toLowerCase() === name.toLowerCase()
  );
}

/**
 * Startup reconciliation for the orchestrator. Canonical ownership is
 * inspected before any workspace is removed. Stale slots with a matching
 * open run are failed explicitly and either requeued after successful
 * cleanup or left blocked with their crashed slot intact when cleanup is
 * unrecoverable. Live slots and unmatched/orphaned slots are never removed.
 */
export async function recoverOrchestratorRestart(
  options: OrchestratorRestartRecoveryOptions,
): Promise<OrchestratorRestartRecoveryResult> {
  const runtime = options.runtime ?? (await readRuntimeState(options.stateDir));
  const ledgerBefore = await readLedger(options.stateDir);
  const persist =
    options.persistRuntime ??
    ((next: RuntimeState) => writeRuntimeState(options.stateDir, next));
  const ownedBySlotId = new Map(
    runtime.slots.map((slot) => [
      slot.slot_id,
      canonicalSlotOwner(ledgerBefore, slot),
    ]),
  );
  const slotByPath = new Map(
    runtime.slots.map((slot) => [
      resolve(options.stateDir, slot.workspace_path),
      slot,
    ]),
  );
  const remove =
    options.removeWorkspace ?? defaultRemoveWorkspace(options.stateDir);
  const validateWorkspaceOwnership =
    options.validateWorkspaceOwnership ??
    ((slot: WorkerSlot) => hasDurableWorkspaceIdentity(options.stateDir, slot));
  const updateCanonical =
    options.updateCanonicalState ??
    (<T>(mutate: (ledger: Ledger) => T | Promise<T>) =>
      updateLedger(options.stateDir, mutate));
  const recoveredTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  const cleanup = await cleanupCrashedWorkerSlots(runtime, {
    stateDir: options.stateDir,
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.isProcessAlive
      ? { isProcessAlive: options.isProcessAlive }
      : {}),
    persistRuntime: persist,
    isReclaimable: (slot) => {
      const owner = ownedBySlotId.get(slot.slot_id);
      // Once a worker result has been submitted, reconciliation still needs
      // the active run. Do not let heartbeat recovery reclaim that slot
      // merely because the worker process has already exited.
      return (
        !owner ||
        owner.state === "released" ||
        owner.state === "done" ||
        !owner.run.result_id
      );
    },
    removeWorkspace: async (path) => {
      const slot = slotByPath.get(resolve(options.stateDir, path));
      if (!slot || !ownedBySlotId.get(slot.slot_id)) {
        throw new Error("canonical task/run ownership mismatch");
      }
      await remove(path);
    },
    beforeCleanup: async (slot) => {
      if (!ownedBySlotId.get(slot.slot_id)) {
        throw new Error("canonical task/run ownership mismatch");
      }
      if (!(await validateWorkspaceOwnership(slot))) {
        throw new Error("durable workspace ownership mismatch");
      }
      await updateCanonical((ledger) => {
        const owner = canonicalSlotOwner(ledger, slot);
        if (!owner) throw new Error("canonical task/run ownership mismatch");
        if (owner.state === "released" || owner.state === "done") return;
        const recoveredAt = (options.now?.() ?? new Date()).toISOString();
        failRecoveredRun(owner.run);
        owner.run.status = "blocked";
        owner.run.updated_at = recoveredAt;
        owner.run.completed_at = recoveredAt;
        owner.run.result = `Crash recovery pending for worker slot ${slot.slot_id}.`;
        owner.task.status = "blocked";
        owner.task.last_error = owner.run.result;
        owner.task.updated_at = recoveredAt;
      });
    },
    afterCleanup: async (slot) => {
      await updateCanonical((ledger) => {
        const owner = canonicalSlotOwner(ledger, slot);
        if (!owner) throw new Error("canonical task/run ownership mismatch");
        if (owner.state === "released" || owner.state === "done") return;
        const recoveredAt = (options.now?.() ?? new Date()).toISOString();
        owner.run.status = "released";
        owner.run.updated_at = recoveredAt;
        owner.run.completed_at = recoveredAt;
        owner.run.result = `Recovered stale worker slot ${slot.slot_id} after orchestrator restart.`;
        owner.task.active_run_id = null;
        owner.task.status = owner.task.depends_on.every(
          (dependency) =>
            ledger.tasks.find((candidate) => candidate.id === dependency)
              ?.status === "done",
        )
          ? "ready"
          : "todo";
        owner.task.last_error = owner.run.result;
        owner.task.updated_at = recoveredAt;
        recoveredTaskIds.push(owner.task.id);
      });
    },
    onCleanupFailure: async (slot, error) => {
      await updateCanonical((ledger) => {
        const owner = canonicalSlotOwner(ledger, slot);
        if (!owner || owner.state === "released") return;
        const recoveredAt = (options.now?.() ?? new Date()).toISOString();
        failRecoveredRun(owner.run);
        owner.run.status = "blocked";
        owner.run.updated_at = recoveredAt;
        owner.run.completed_at = recoveredAt;
        owner.run.result = `Crash recovery failed for worker slot ${slot.slot_id}: ${error}.`;
        owner.task.status = "blocked";
        owner.task.last_error = owner.run.result;
        owner.task.updated_at = recoveredAt;
        failedTaskIds.push(owner.task.id);
      });
    },
  });

  const unresolvedCanonicalWrites = Object.entries(
    cleanup.cleanupErrors,
  ).filter(([, message]) =>
    message?.includes("canonical recovery update failed:"),
  );
  if (unresolvedCanonicalWrites.length > 0) {
    throw new Error(
      `Canonical restart recovery could not be persisted: ${unresolvedCanonicalWrites
        .map(([slotId, message]) => `${slotId}: ${message}`)
        .join("; ")}`,
    );
  }

  const crashedIds = new Set(cleanup.crashedSlots.map((slot) => slot.slot_id));
  const orphanedSlotIds = cleanup.crashedSlots
    .filter((slot) => !ownedBySlotId.get(slot.slot_id))
    .map((slot) => slot.slot_id);

  return {
    ...cleanup,
    recoveredTaskIds,
    failedTaskIds,
    liveSlotIds: runtime.slots
      .filter((slot) => !crashedIds.has(slot.slot_id))
      .map((slot) => slot.slot_id),
    orphanedSlotIds,
  };
}

export interface OrchestratorRestartGraceRecoveryOptions
  extends OrchestratorRestartRecoveryOptions {
  wait?: (milliseconds: number) => Promise<void>;
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

/**
 * Performs startup reconciliation and one bounded follow-up heartbeat later.
 * The second observation prevents a fresh pid-less slot from surviving a fast
 * restart forever, while still giving a genuinely live recorded PID a full
 * grace period and another liveness check before it can be reclaimed.
 */
export async function recoverOrchestratorRestartWithGrace(
  options: OrchestratorRestartGraceRecoveryOptions,
): Promise<OrchestratorRestartRecoveryResult> {
  const first = await recoverOrchestratorRestart(options);
  const needsFollowUp = first.runtime.slots.some(
    (slot) => slot.status === "starting" || slot.status === "running",
  );
  if (!needsFollowUp) return first;

  const heartbeatIntervalMs = Math.max(
    1,
    options.heartbeatIntervalMs ?? DEFAULT_SLOT_HEARTBEAT_INTERVAL_MS,
  );
  await (
    options.wait ??
    ((milliseconds) =>
      new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, milliseconds),
      ))
  )(heartbeatIntervalMs);

  const second = await recoverOrchestratorRestart({
    ...options,
    runtime: first.runtime,
  });
  return {
    ...second,
    crashedSlots: [...first.crashedSlots, ...second.crashedSlots],
    freedSlotIds: mergeUnique(first.freedSlotIds, second.freedSlotIds),
    cleanupErrors: { ...first.cleanupErrors, ...second.cleanupErrors },
    recoveredTaskIds: mergeUnique(
      first.recoveredTaskIds,
      second.recoveredTaskIds,
    ),
    failedTaskIds: mergeUnique(first.failedTaskIds, second.failedTaskIds),
    liveSlotIds: second.liveSlotIds,
    orphanedSlotIds: mergeUnique(first.orphanedSlotIds, second.orphanedSlotIds),
  };
}

async function terminateLocalProcessTree(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  if (process.platform === "win32") {
    await execFileBounded(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      timeoutMs,
    );
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function normalizedPath(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
}

/**
 * Default classifier for leftover test infrastructure: Playwright runs and
 * Vite/tsx dev servers whose command line mentions the project root.
 */
export function classifyTestProcess(
  root: string,
  commandLine: string,
): OwnedProcessKind | null {
  const command = commandLine.replace(/\\/g, "/").toLowerCase();
  if (!command.includes(normalizedPath(root))) return null;
  if (/\bplaywright(?:\.cmd|\.js)?\b.*\b(?:test|show-report)\b/.test(command)) {
    return "playwright";
  }
  if (
    /(?:\/|\b)(?:vite|vite\.js|tsx)(?:\s|\/|$)/.test(command) &&
    /(?:\bdev(?::(?:web|server|staging))?\b|apps\/(?:web|server)|vite)/.test(
      command,
    )
  ) {
    return "web-server";
  }
  return null;
}

function ownerFor(
  candidate: LocalProcess,
  owners: Set<number>,
  byPid: Map<number, LocalProcess>,
): number | null {
  const visited = new Set<number>([candidate.pid]);
  let parentPid = candidate.parentPid;
  for (let depth = 0; depth < 64 && parentPid > 0; depth += 1) {
    if (owners.has(parentPid)) return parentPid;
    if (visited.has(parentPid)) return null;
    visited.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) return null;
    parentPid = parent.parentPid;
  }
  return null;
}

export function findOwnedCleanupCandidates(
  root: string,
  processes: LocalProcess[],
  staleOwnerPids: number[],
  classify: ProcessClassifier = classifyTestProcess,
): CleanupCandidate[] {
  const owners = new Set(staleOwnerPids);
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  return processes
    .map((entry): CleanupCandidate | null => {
      const kind = classify(root, entry.commandLine);
      if (!kind) return null;
      const ownerPid = ownerFor(entry, owners, byPid);
      return ownerPid === null ? null : { ...entry, kind, ownerPid };
    })
    .filter((entry): entry is CleanupCandidate => entry !== null)
    .sort((left, right) => left.pid - right.pid);
}

export function boundedOwnerPids(ownerPids: number[]): number[] {
  return [
    ...new Set(ownerPids.filter((pid) => Number.isInteger(pid) && pid > 0)),
  ]
    .sort((left, right) => left - right)
    .slice(-MAX_OWNER_PIDS);
}

export async function cleanupOwnedProcesses(
  options: RuntimeCleanupOptions,
): Promise<RuntimeCleanupResult> {
  const timeoutMs = Math.max(
    100,
    options.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
  const ownerPids = boundedOwnerPids(options.ownerPids);
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const liveOwnerPids = ownerPids.filter((pid) => isAlive(pid));
  const staleOwnerPids = ownerPids.filter(
    (pid) => !liveOwnerPids.includes(pid),
  );
  const empty: RuntimeCleanupResult = {
    phase: options.phase,
    inspected: 0,
    staleOwnerPids,
    liveOwnerPids,
    eligible: [],
    terminatedPids: [],
    failedPids: [],
    retainedOwnerPids: liveOwnerPids,
    error: null,
  };
  if (staleOwnerPids.length === 0) return empty;

  let processes: LocalProcess[];
  try {
    processes = await (
      options.listProcesses ?? (() => listLocalProcesses(timeoutMs))
    )();
  } catch (error) {
    return {
      ...empty,
      retainedOwnerPids: ownerPids,
      error: `process-list: ${(error as Error).message}`,
    };
  }

  const eligible = findOwnedCleanupCandidates(
    options.root,
    processes,
    staleOwnerPids,
    options.classify,
  );
  const terminate = options.terminateProcessTree ?? terminateLocalProcessTree;
  const terminatedPids: number[] = [];
  const failedPids: number[] = [];
  for (const candidate of eligible) {
    try {
      await terminate(candidate.pid, timeoutMs);
      terminatedPids.push(candidate.pid);
    } catch {
      failedPids.push(candidate.pid);
    }
  }
  const failedOwners = new Set(
    eligible
      .filter((candidate) => failedPids.includes(candidate.pid))
      .map((candidate) => candidate.ownerPid),
  );
  return {
    phase: options.phase,
    inspected: processes.length,
    staleOwnerPids,
    liveOwnerPids,
    eligible,
    terminatedPids,
    failedPids,
    retainedOwnerPids: boundedOwnerPids([...liveOwnerPids, ...failedOwners]),
    error: null,
  };
}

export function runnerFailureFingerprint(source: string): string {
  const normalized = source
    .toLowerCase()
    .replace(/\beaddrinuse\b/g, "address already in use")
    .replace(/[a-f0-9]{7,64}/g, "<hash>")
    .replace(/\b(?:pid|port|line|attempt)\s*[=:]?\s*\d+\b/g, "$1=<n>")
    .replace(
      /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g,
      "<timestamp>",
    )
    .replace(/[a-z]:\\[^\r\n:]+/gi, "<path>")
    .replace(/\/(?:[^\s/:]+\/)+[^\s/:]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  const category = /eaddrinuse|address already in use/.test(normalized)
    ? "port-in-use"
    : /playwright.*web server.*timed out|timed out.*web server/.test(normalized)
      ? "playwright-web-server-timeout"
      : /browser.*(?:closed|launch)|failed to launch/.test(normalized)
        ? "browser-launch"
        : /teardown|did not exit|process.*(?:hang|still running)/.test(
              normalized,
            )
          ? "runner-teardown"
          : "runner-error";
  return `${category}:${normalized.slice(0, 240) || "empty"}`;
}
