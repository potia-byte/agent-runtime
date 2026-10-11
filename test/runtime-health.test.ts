import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { durableWorkerPaths } from "../src/durable-worker.js";
import {
  addTasks,
  claimTask,
  readLedger,
  releaseTask,
  updateLedger,
} from "../src/ledger.js";
import {
  boundedOwnerPids,
  classifySlotLiveness,
  cleanupCrashedWorkerSlots,
  cleanupOwnedProcesses,
  findOwnedCleanupCandidates,
  type LocalProcess,
  recoverOrchestratorRestart,
  recoverOrchestratorRestartWithGrace,
  runnerFailureFingerprint,
} from "../src/runtime-health.js";
import {
  initialRuntimeState,
  type RuntimeState,
  readRuntimeState,
  type WorkerSlot,
} from "../src/runtime-state.js";
import { buildSlot, cleanupTempDirs, makeTempDir } from "./support.js";

const ROOT = process.platform === "win32" ? "C:\\project" : "/project";
const OTHER_ROOT =
  process.platform === "win32" ? "C:\\other project" : "/other-project";
const SEP = process.platform === "win32" ? "\\" : "/";
const HEARTBEAT_INTERVAL_MS = 5_000;
const AT = "2026-01-10T00:00:00.000Z";
const workerProcesses: ChildProcess[] = [];

function startWorker(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  workerProcesses.push(child);
  return child;
}

async function waitForSpawn(child: ChildProcess): Promise<number> {
  if (child.pid) return child.pid;
  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("Worker fixture did not receive a pid.");
  return child.pid;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) =>
    child.once("exit", () => resolvePromise()),
  );
}

afterEach(async () => {
  for (const child of workerProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForExit(child);
  }
  await cleanupTempDirs();
});

function processEntry(
  pid: number,
  parentPid: number,
  commandLine: string,
): LocalProcess {
  return { pid, parentPid, commandLine };
}

/** Slot whose workspace follows the default `<controller>-<slot>` identity. */
function slotFor(
  slotId: string,
  overrides: Partial<WorkerSlot> = {},
): WorkerSlot {
  return buildSlot({
    slot_id: slotId,
    controller_id: "cycle-1",
    workspace_path: `workspaces/cycle-1-${slotId}`,
    task_id: `TASK-${slotId}`,
    run_id: `RUN-${slotId}`,
    started_at: AT,
    heartbeat_at: AT,
    ...overrides,
  });
}

async function makeWorkspace(dir: string, slot: WorkerSlot): Promise<string> {
  const path = join(dir, slot.workspace_path);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "output.txt"), "work in progress");
  return path;
}

function runtimeWith(slots: WorkerSlot[]): RuntimeState {
  return { ...initialRuntimeState(), slots };
}

async function seedTasks(dir: string, ids: string[]) {
  await addTasks(
    dir,
    ids.map((id) => ({ id, title: id, description: `Recover ${id}` })),
  );
  return Promise.all(ids.map((id) => claimTask(dir, id, "worker-a")));
}

/** Slot bound to a real claimed run in the ledger. */
function boundSlot(
  slotId: string,
  run: { id: string; task_id: string },
  overrides: Partial<WorkerSlot> = {},
): WorkerSlot {
  return slotFor(slotId, {
    task_id: run.task_id,
    run_id: run.id,
    ...overrides,
  });
}

describe("leftover process cleanup", () => {
  it("selects only stale-owner descendants that are Playwright runs or dev servers", () => {
    const processes = [
      processEntry(
        201,
        100,
        `node "${ROOT}${SEP}node_modules${SEP}playwright${SEP}cli.js" test`,
      ),
      processEntry(
        202,
        201,
        `node "${ROOT}${SEP}node_modules${SEP}vite${SEP}bin${SEP}vite.js"`,
      ),
      processEntry(
        203,
        999,
        `node "${ROOT}${SEP}node_modules${SEP}playwright${SEP}cli.js" test`,
      ),
      processEntry(
        204,
        100,
        `node "${OTHER_ROOT}${SEP}node_modules${SEP}vite${SEP}bin${SEP}vite.js"`,
      ),
      processEntry(
        205,
        100,
        `node "${ROOT}${SEP}scripts${SEP}unrelated-worker.js"`,
      ),
    ];

    expect(findOwnedCleanupCandidates(ROOT, processes, [100])).toEqual([
      expect.objectContaining({ pid: 201, ownerPid: 100, kind: "playwright" }),
      expect.objectContaining({ pid: 202, ownerPid: 100, kind: "web-server" }),
    ]);
  });

  it("accepts a custom classifier instead of the default one", () => {
    const processes = [
      processEntry(301, 100, `node "${ROOT}${SEP}jobs${SEP}my-job.js"`),
      processEntry(
        302,
        100,
        `node "${ROOT}${SEP}node_modules${SEP}vite${SEP}bin${SEP}vite.js"`,
      ),
    ];
    const found = findOwnedCleanupCandidates(
      ROOT,
      processes,
      [100],
      (_root, commandLine) => (commandLine.includes("my-job") ? "job" : null),
    );
    expect(found).toEqual([
      expect.objectContaining({ pid: 301, kind: "job", ownerPid: 100 }),
    ]);
  });

  it("leaves live owners and unrelated processes untouched", async () => {
    const terminate = vi.fn(async () => undefined);
    const result = await cleanupOwnedProcesses({
      root: ROOT,
      ownerPids: [100, 999],
      phase: "preflight",
      isProcessAlive: (pid) => pid === 100,
      listProcesses: async () => [
        processEntry(
          201,
          100,
          `node "${ROOT}${SEP}node_modules${SEP}playwright${SEP}cli.js" test`,
        ),
        processEntry(
          202,
          999,
          `node "${OTHER_ROOT}${SEP}node_modules${SEP}vite${SEP}bin${SEP}vite.js"`,
        ),
      ],
      terminateProcessTree: terminate,
    });

    expect(terminate).not.toHaveBeenCalled();
    expect(result.liveOwnerPids).toEqual([100]);
    expect(result.eligible).toEqual([]);
    expect(result.retainedOwnerPids).toEqual([100]);
  });

  it("terminates eligible trees and retains only owners whose cleanup failed", async () => {
    const terminate = vi.fn(async (pid: number) => {
      if (pid === 202) throw new Error("access denied");
    });
    const result = await cleanupOwnedProcesses({
      root: ROOT,
      ownerPids: [100, 101],
      phase: "teardown",
      isProcessAlive: () => false,
      listProcesses: async () => [
        processEntry(
          201,
          100,
          `node "${ROOT}${SEP}node_modules${SEP}playwright${SEP}cli.js" test`,
        ),
        processEntry(
          202,
          101,
          `node "${ROOT}${SEP}node_modules${SEP}vite${SEP}bin${SEP}vite.js"`,
        ),
      ],
      terminateProcessTree: terminate,
    });

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(result.terminatedPids).toEqual([201]);
    expect(result.failedPids).toEqual([202]);
    expect(result.retainedOwnerPids).toEqual([101]);
  });

  it("reports a process-listing failure without terminating anything", async () => {
    const terminate = vi.fn(async () => undefined);
    const result = await cleanupOwnedProcesses({
      root: ROOT,
      ownerPids: [100],
      phase: "teardown",
      isProcessAlive: () => false,
      listProcesses: async () => {
        throw new Error("ps unavailable");
      },
      terminateProcessTree: terminate,
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(result.error).toBe("process-list: ps unavailable");
    expect(result.retainedOwnerPids).toEqual([100]);
  });

  it("bounds and deterministically orders persisted owner pids", () => {
    expect(boundedOwnerPids([3, -1, 2, 3, 1])).toEqual([1, 2, 3]);
    expect(
      boundedOwnerPids(Array.from({ length: 40 }, (_, index) => index + 1)),
    ).toEqual(Array.from({ length: 32 }, (_, index) => index + 9));
  });
});

describe.sequential("slot crash cleanup", () => {
  it("rejects ambiguous duplicate slot and workspace ownership before cleanup", async () => {
    const dir = await makeTempDir();
    const stale = slotFor("duplicate", { pid: 100, status: "running" });
    const live = slotFor("duplicate", {
      worker: "worker-b",
      task_id: "LIVE",
      run_id: "RUN-LIVE",
      pid: 200,
    });
    const remove = vi.fn(async () => undefined);

    await expect(
      cleanupCrashedWorkerSlots(runtimeWith([stale, live]), {
        stateDir: dir,
        isProcessAlive: (pid) => pid === 200,
        removeWorkspace: remove,
        persistRuntime: async () => undefined,
      }),
    ).rejects.toThrow(/Duplicate worker (slot id|workspace ownership)/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("detects one killed owner within one heartbeat and removes only its workspace", async () => {
    const dir = await makeTempDir();
    const workerA = startWorker();
    const workerB = startWorker();
    const [pidA, pidB] = await Promise.all([
      waitForSpawn(workerA),
      waitForSpawn(workerB),
    ]);
    const now = new Date().toISOString();
    const slotA = slotFor("A", {
      pid: pidA,
      started_at: now,
      heartbeat_at: now,
    });
    const slotB = slotFor("B", {
      pid: pidB,
      started_at: now,
      heartbeat_at: now,
    });
    const pathA = await makeWorkspace(dir, slotA);
    const pathB = await makeWorkspace(dir, slotB);

    const killedAt = Date.now();
    workerA.kill();
    await waitForExit(workerA);
    const result = await cleanupCrashedWorkerSlots(
      runtimeWith([slotA, slotB]),
      { stateDir: dir, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS },
    );

    expect(Date.now() - killedAt).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS);
    expect(result.crashedSlots).toEqual([
      expect.objectContaining({ slot_id: "A", status: "crashed" }),
    ]);
    expect(result.freedSlotIds).toEqual(["A"]);
    expect(result.cleanupErrors).toEqual({});
    expect(result.runtime.slots).toEqual([slotB]);
    expect((await readRuntimeState(dir)).slots).toEqual([slotB]);

    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(true);
    expect(workerB.exitCode).toBeNull();
    expect(workerB.signalCode).toBeNull();
  });

  it("retains a crashed slot when its workspace cleanup fails", async () => {
    const dir = await makeTempDir();
    const crashed = slotFor("A", { pid: 100 });
    const persisted: RuntimeState[] = [];

    const result = await cleanupCrashedWorkerSlots(runtimeWith([crashed]), {
      stateDir: dir,
      isProcessAlive: () => false,
      removeWorkspace: () => {
        throw new Error("workspace busy");
      },
      persistRuntime: async (next) => {
        persisted.push(next);
      },
    });

    expect(result.freedSlotIds).toEqual([]);
    expect(result.cleanupErrors).toEqual({ A: "workspace busy" });
    expect(result.runtime.slots).toEqual([
      expect.objectContaining({ slot_id: "A", status: "crashed" }),
    ]);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.slots[0]?.status).toBe("crashed");
  });

  it("does not reclaim an exited slot while result reconciliation owns the run", async () => {
    const dir = await makeTempDir();
    const slot = slotFor("A", { pid: 100 });
    const result = await cleanupCrashedWorkerSlots(runtimeWith([slot]), {
      stateDir: dir,
      isProcessAlive: () => false,
      isReclaimable: () => false,
      removeWorkspace: vi.fn(),
      persistRuntime: async () => undefined,
    });

    expect(result.crashedSlots).toEqual([]);
    expect(result.freedSlotIds).toEqual([]);
    expect(result.runtime.slots).toEqual([slot]);
  });

  it("refuses to delete a workspace outside the managed directory", async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir("agent-runtime-outside-");
    await writeFile(join(outside, "precious.txt"), "do not delete");
    const slot = slotFor("A", { pid: 100, workspace_path: outside });

    const result = await cleanupCrashedWorkerSlots(runtimeWith([slot]), {
      stateDir: dir,
      isProcessAlive: () => false,
      persistRuntime: async () => undefined,
    });

    expect(result.freedSlotIds).toEqual([]);
    expect(result.cleanupErrors.A).toMatch(/outside managed directory/);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });
});

describe.sequential("orchestrator restart recovery", () => {
  it("recovers a failed slot: removes its workspace and requeues the task", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-FAILED-SLOT"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("A", run, { pid: null, status: "failed" });
    const path = await makeWorkspace(dir, slot);
    const persisted: RuntimeState[] = [];

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      persistRuntime: async (next) => {
        persisted.push(structuredClone(next));
      },
    });

    expect(result.freedSlotIds).toEqual(["A"]);
    expect(result.recoveredTaskIds).toEqual(["TASK-FAILED-SLOT"]);
    expect(result.runtime.slots).toEqual([]);
    expect(persisted[0]?.slots[0]).toMatchObject({
      slot_id: "A",
      status: "crashed",
    });
    expect(existsSync(path)).toBe(false);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === run.task_id)).toMatchObject({
      status: "ready",
      active_run_id: null,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "failed",
      status: "released",
    });
  }, 15_000);

  it("does not reclaim a successfully exited worker before its result is bound", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-EXITED-PENDING-RECONCILE"]);
    if (!run) throw new Error("missing run");
    // The controller marks a slot "completed" and clears its pid the instant
    // the child exits successfully, strictly before result binding runs.
    const slot = boundSlot("A", run, { pid: null, status: "completed" });
    const remove = vi.fn(async () => undefined);

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      // Observed 500ms after the heartbeat: "worker just finished", well
      // inside one heartbeat interval, not "abandoned long ago".
      now: () => new Date(Date.parse(AT) + 500),
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.recoveredTaskIds).toEqual([]);
    expect(result.freedSlotIds).toEqual([]);
    expect(result.runtime.slots[0]).toMatchObject({
      slot_id: "A",
      status: "completed",
      run_id: run.id,
    });
    const ledger = await readLedger(dir);
    expect(
      ledger.tasks.find((task) => task.id === "TASK-EXITED-PENDING-RECONCILE"),
    ).toMatchObject({ status: "in_progress", active_run_id: run.id });
  });

  it("keeps a slot whose run has a submitted result even with a dead pid", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-RESULT-SUBMITTED"]);
    if (!run) throw new Error("missing run");
    await updateLedger(dir, (ledger) => {
      const stored = ledger.runs.find((candidate) => candidate.id === run.id);
      if (stored) stored.result_id = "result-1";
    });
    const slot = boundSlot("A", run, { pid: 4242, status: "running" });
    const remove = vi.fn(async () => undefined);

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      isProcessAlive: () => false,
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.runtime.slots).toEqual([slot]);
  });

  it("still reclaims a genuinely crashed worker (not merely a dead pid on a completed slot)", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-GENUINELY-CRASHED"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("A", run, { pid: 4242, status: "running" });

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      isProcessAlive: () => false,
      removeWorkspace: async () => undefined,
      persistRuntime: async () => undefined,
    });

    expect(result.recoveredTaskIds).toEqual(["TASK-GENUINELY-CRASHED"]);
    const ledger = await readLedger(dir);
    expect(
      ledger.tasks.find((task) => task.id === "TASK-GENUINELY-CRASHED"),
    ).toMatchObject({ status: "ready" });
  });

  it("frees stale owned slots, preserves live work, and blocks failed cleanup", async () => {
    const dir = await makeTempDir();
    const runs = await seedTasks(dir, ["TASK-1", "TASK-2", "TASK-3"]);
    const slots = runs.map((run, index) =>
      boundSlot(`slot-${index + 1}`, run, {
        workspace_path: `workspaces/cycle-1-slot-${index + 1}`,
        pid: 101 + index,
        status: "running",
      }),
    );

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith(slots),
      now: () => new Date("2026-01-10T00:01:00.000Z"),
      isProcessAlive: (pid) => pid === 102,
      removeWorkspace: (path) => {
        if (path.endsWith("slot-3")) throw new Error("workspace busy");
      },
      persistRuntime: async () => undefined,
    });

    expect(result.recoveredTaskIds).toEqual(["TASK-1"]);
    expect(result.failedTaskIds).toEqual(["TASK-3"]);
    expect(result.liveSlotIds).toEqual(["slot-2"]);
    expect(result.freedSlotIds).toEqual(["slot-1"]);
    expect(result.runtime.slots.map((slot) => slot.slot_id)).toEqual([
      "slot-2",
      "slot-3",
    ]);
    expect(result.runtime.slots[0]).toBe(slots[1]);
    expect(result.runtime.slots[1]?.status).toBe("crashed");

    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === "TASK-1")).toMatchObject({
      status: "ready",
      active_run_id: null,
    });
    expect(ledger.tasks.find((t) => t.id === "TASK-2")).toMatchObject({
      status: "in_progress",
      active_run_id: runs[1]?.id,
    });
    expect(ledger.tasks.find((t) => t.id === "TASK-3")).toMatchObject({
      status: "blocked",
      active_run_id: runs[2]?.id,
    });
    expect(ledger.runs.find((r) => r.id === runs[0]?.id)).toMatchObject({
      phase: "failed",
      status: "released",
    });
    expect(ledger.runs.find((r) => r.id === runs[1]?.id)).toMatchObject({
      phase: "running",
      status: "running",
    });
    expect(ledger.runs.find((r) => r.id === runs[2]?.id)).toMatchObject({
      phase: "failed",
      status: "blocked",
    });
  });

  it("retains a stale orphaned slot instead of silently dropping it", async () => {
    const dir = await makeTempDir();
    const slot = slotFor("orphan-1", {
      task_id: "MISSING",
      run_id: "run-missing",
      pid: 999,
    });

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      isProcessAlive: () => false,
      persistRuntime: async () => undefined,
    });

    expect(result.orphanedSlotIds).toEqual(["orphan-1"]);
    expect(result.freedSlotIds).toEqual([]);
    expect(result.runtime.slots).toEqual([
      expect.objectContaining({ slot_id: "orphan-1", status: "crashed" }),
    ]);
    expect(result.cleanupErrors["orphan-1"]).toBe(
      "canonical task/run ownership mismatch",
    );
  });

  it("fails and durably retains a persisted failed slot when cleanup fails", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-FAILED"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("slot-failed", run, {
      workspace_path: "workspaces/cycle-1-slot-failed",
      status: "failed",
    });

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      removeWorkspace: () => {
        throw new Error("workspace busy");
      },
      persistRuntime: async () => undefined,
    });

    expect(result.failedTaskIds).toEqual(["TASK-FAILED"]);
    expect(result.runtime.slots).toEqual([
      expect.objectContaining({ slot_id: "slot-failed", status: "crashed" }),
    ]);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === run.task_id)).toMatchObject({
      status: "blocked",
      active_run_id: run.id,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "failed",
      status: "blocked",
    });
  });

  it("defines completed-slot restart as failed recovery and safe requeue", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-COMPLETED"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("slot-completed", run, {
      workspace_path: "workspaces/cycle-1-slot-completed",
      status: "completed",
    });

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      removeWorkspace: async () => undefined,
      persistRuntime: async () => undefined,
    });

    expect(result.recoveredTaskIds).toEqual(["TASK-COMPLETED"]);
    expect(result.runtime.slots).toEqual([]);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === run.task_id)).toMatchObject({
      status: "ready",
      active_run_id: null,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "failed",
      status: "released",
    });
  });

  it("reclaims a fresh pid-less slot after one bounded heartbeat grace", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-PIDLESS"]);
    if (!run) throw new Error("missing run");
    let now = new Date("2026-01-10T00:00:01.000Z");
    const slot = boundSlot("slot-pidless", run, {
      workspace_path: "workspaces/cycle-1-slot-pidless",
      pid: null,
      status: "starting",
    });
    const remove = vi.fn(async () => undefined);

    const result = await recoverOrchestratorRestartWithGrace({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      heartbeatIntervalMs: 5_000,
      now: () => now,
      wait: async (milliseconds) => {
        expect(milliseconds).toBe(5_000);
        now = new Date(now.getTime() + milliseconds);
        const ledger = await readLedger(dir);
        expect(
          ledger.tasks.find((task) => task.id === run.task_id),
        ).toMatchObject({ status: "in_progress", active_run_id: run.id });
      },
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(result.recoveredTaskIds).toEqual(["TASK-PIDLESS"]);
    expect(result.runtime.slots).toEqual([]);
  });

  it("reconciles a retained live slot on a later heartbeat after its pid exits", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-LIVE-THEN-EXIT"]);
    if (!run) throw new Error("missing run");
    let alive = true;
    const slot = boundSlot("slot-live", run, {
      workspace_path: "workspaces/cycle-1-slot-live",
      pid: 321,
      status: "running",
    });
    const remove = vi.fn(async () => undefined);

    const result = await recoverOrchestratorRestartWithGrace({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      heartbeatIntervalMs: 10,
      isProcessAlive: () => alive,
      wait: async () => {
        expect(remove).not.toHaveBeenCalled();
      },
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.liveSlotIds).toEqual(["slot-live"]);
    expect(result.runtime.slots).toEqual([slot]);

    alive = false;
    const heartbeat = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: result.runtime,
      isProcessAlive: () => alive,
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(heartbeat.recoveredTaskIds).toEqual(["TASK-LIVE-THEN-EXIT"]);
    expect(heartbeat.runtime.slots).toEqual([]);
  });

  it("never removes a workspace whose recorded path does not match its identity", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-CORRUPT-PATH"]);
    if (!run) throw new Error("missing run");
    // controller "cycle-1", slot "A" => identity "cycle-1-A", but the record
    // points at some other directory that really exists.
    const slot = boundSlot("A", run, {
      workspace_path: "workspaces/someone-elses-work",
      status: "failed",
    });
    const path = await makeWorkspace(dir, slot);
    const remove = vi.fn(async () => undefined);

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.cleanupErrors.A).toBe(
      "durable workspace ownership mismatch",
    );
    expect(existsSync(path)).toBe(true);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === run.task_id)).toMatchObject({
      status: "blocked",
      active_run_id: run.id,
    });
  }, 15_000);

  it("retains a stale slot whose path is swapped with a live sibling", async () => {
    const dir = await makeTempDir();
    const runs = await seedTasks(dir, ["TASK-STALE", "TASK-LIVE"]);
    const [staleRun, liveRun] = runs;
    if (!staleRun || !liveRun) throw new Error("missing runs");
    const stale = boundSlot("A", staleRun, {
      workspace_path: "workspaces/cycle-1-B",
      status: "failed",
    });
    const live = boundSlot("B", liveRun, {
      workspace_path: "workspaces/cycle-1-A",
      pid: 202,
      status: "running",
    });
    const pathB = await makeWorkspace(dir, slotFor("B"));
    const pathA = await makeWorkspace(dir, slotFor("A"));

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([stale, live]),
      isProcessAlive: (pid) => pid === 202,
    });

    expect(result.cleanupErrors.A).toBe(
      "durable workspace ownership mismatch",
    );
    expect(result.runtime.slots).toEqual([
      expect.objectContaining({ slot_id: "A", status: "crashed" }),
      live,
    ]);
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === "TASK-STALE")?.status).toBe(
      "blocked",
    );
    expect(ledger.tasks.find((t) => t.id === "TASK-LIVE")?.status).toBe(
      "in_progress",
    );
  }, 15_000);

  it("retains a durable crashed slot when canonical recovery state cannot be written", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-1"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("slot-1", run, {
      workspace_path: "workspaces/cycle-1-slot-1",
      pid: 101,
    });
    const persisted: RuntimeState[] = [];
    const remove = vi.fn(async () => undefined);

    await expect(
      recoverOrchestratorRestart({
        stateDir: dir,
        runtime: runtimeWith([slot]),
        isProcessAlive: () => false,
        removeWorkspace: remove,
        persistRuntime: async (next) => {
          persisted.push(next);
        },
        updateCanonicalState: async () => {
          throw new Error("simulated canonical write failure");
        },
      }),
    ).rejects.toThrow("Canonical restart recovery could not be persisted");

    expect(remove).not.toHaveBeenCalled();
    expect(persisted.at(-1)?.slots).toEqual([
      expect.objectContaining({ slot_id: "slot-1", status: "crashed" }),
    ]);

    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === "TASK-1")).toMatchObject({
      status: "in_progress",
      active_run_id: run.id,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "running",
      status: "running",
    });
  });

  it("does not free a slot when the post-cleanup canonical write fails", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-1"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("slot-1", run, {
      workspace_path: "workspaces/cycle-1-slot-1",
      pid: 101,
    });
    const persisted: RuntimeState[] = [];
    const remove = vi.fn(async () => undefined);
    let canonicalWrites = 0;

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      isProcessAlive: () => false,
      removeWorkspace: remove,
      persistRuntime: async (next) => {
        persisted.push(next);
      },
      updateCanonicalState: async (mutate) => {
        canonicalWrites += 1;
        if (canonicalWrites === 2) {
          throw new Error("simulated post-cleanup state write failure");
        }
        return updateLedger(dir, mutate);
      },
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(result.freedSlotIds).toEqual([]);
    expect(result.runtime.slots).toEqual([
      expect.objectContaining({ slot_id: "slot-1", status: "crashed" }),
    ]);
    expect(result.cleanupErrors["slot-1"]).toContain(
      "post-cleanup state write failure",
    );
    expect(persisted.at(-1)?.slots).toEqual(result.runtime.slots);

    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === "TASK-1")).toMatchObject({
      status: "blocked",
      active_run_id: run.id,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "failed",
      status: "blocked",
    });
  });

  it("does not associate a stale old-run slot with a newer active run", async () => {
    const dir = await makeTempDir();
    const [oldRun] = await seedTasks(dir, ["TASK-REUSED"]);
    if (!oldRun) throw new Error("missing run");
    await releaseTask(dir, "TASK-REUSED");
    const newRun = await claimTask(dir, "TASK-REUSED", "worker-a");
    const slot = boundSlot("slot-old", oldRun, {
      workspace_path: "workspaces/cycle-1-slot-old",
      pid: 101,
    });
    const remove = vi.fn(async () => undefined);

    const result = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      isProcessAlive: () => false,
      removeWorkspace: remove,
      persistRuntime: async () => undefined,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.orphanedSlotIds).toEqual(["slot-old"]);
    expect(result.runtime.slots).toEqual([
      expect.objectContaining({ slot_id: "slot-old", status: "crashed" }),
    ]);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === oldRun.task_id)).toMatchObject({
      status: "in_progress",
      active_run_id: newRun.id,
    });
    expect(ledger.runs.find((r) => r.id === newRun.id)).toMatchObject({
      phase: "running",
      status: "running",
    });
  });

  it("rejects stale and live slots sharing one task before either is touched", async () => {
    const dir = await makeTempDir();
    const [oldRun] = await seedTasks(dir, ["TASK-SHARED"]);
    if (!oldRun) throw new Error("missing run");
    await releaseTask(dir, "TASK-SHARED");
    const liveRun = await claimTask(dir, "TASK-SHARED", "worker-a");
    const stale = boundSlot("slot-stale", oldRun, {
      workspace_path: "workspaces/cycle-1-slot-stale",
      pid: 101,
    });
    const live = boundSlot("slot-live", liveRun, {
      workspace_path: "workspaces/cycle-1-slot-live",
      pid: 202,
    });
    const remove = vi.fn(async () => undefined);

    await expect(
      recoverOrchestratorRestart({
        stateDir: dir,
        runtime: runtimeWith([stale, live]),
        isProcessAlive: (pid) => pid === 202,
        removeWorkspace: remove,
        persistRuntime: async () => undefined,
      }),
    ).rejects.toThrow("Duplicate worker task ownership");
    expect(remove).not.toHaveBeenCalled();
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === oldRun.task_id)).toMatchObject({
      status: "in_progress",
      active_run_id: liveRun.id,
    });
  });

  it("finishes a released recovery slot after final runtime persistence fails", async () => {
    const dir = await makeTempDir();
    const [oldRun] = await seedTasks(dir, ["TASK-RUNTIME-WRITE"]);
    if (!oldRun) throw new Error("missing run");
    const slot = boundSlot("slot-runtime-write", oldRun, {
      workspace_path: "workspaces/cycle-1-slot-runtime-write",
      pid: 101,
    });
    const path = await makeWorkspace(dir, slot);
    const persistedRuntimes: RuntimeState[] = [];
    let persistenceCalls = 0;

    expect(existsSync(path)).toBe(true);
    await expect(
      recoverOrchestratorRestart({
        stateDir: dir,
        runtime: runtimeWith([slot]),
        isProcessAlive: () => false,
        persistRuntime: async (next) => {
          persistenceCalls += 1;
          if (persistenceCalls === 1)
            persistedRuntimes.push(structuredClone(next));
          else throw new Error("simulated final runtime write failure");
        },
      }),
    ).rejects.toThrow("simulated final runtime write failure");
    expect(existsSync(path)).toBe(false);
    expect(persistedRuntimes[0]?.slots).toEqual([
      expect.objectContaining({
        slot_id: "slot-runtime-write",
        status: "crashed",
      }),
    ]);

    const newerRun = await claimTask(dir, "TASK-RUNTIME-WRITE", "worker-a");
    const retry = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: persistedRuntimes[0] ?? initialRuntimeState(),
      persistRuntime: async () => undefined,
    });

    expect(retry.freedSlotIds).toEqual(["slot-runtime-write"]);
    expect(retry.runtime.slots).toEqual([]);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === oldRun.task_id)).toMatchObject({
      status: "in_progress",
      active_run_id: newerRun.id,
    });
    expect(ledger.runs.find((r) => r.id === newerRun.id)).toMatchObject({
      phase: "running",
      status: "running",
    });
  });

  it("finishes cleanup after a crash between workspace removal and canonical release", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-AFTER-REMOVE"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("slot-after-remove", run, {
      workspace_path: "workspaces/cycle-1-slot-after-remove",
      status: "crashed",
    });
    // State left behind by a controller that died after "before cleanup"
    // and after removing the workspace, but before the canonical release.
    await updateLedger(dir, (ledger) => {
      const task = ledger.tasks.find((t) => t.id === run.task_id);
      const stored = ledger.runs.find((r) => r.id === run.id);
      if (!task || !stored) throw new Error("missing recovery fixture");
      stored.phase = "failed";
      stored.status = "blocked";
      stored.result = `Crash recovery pending for worker slot ${slot.slot_id}.`;
      task.status = "blocked";
      task.last_error = stored.result;
    });
    expect(existsSync(join(dir, slot.workspace_path))).toBe(false);

    const recovered = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      persistRuntime: async () => undefined,
    });

    expect(recovered.freedSlotIds).toEqual(["slot-after-remove"]);
    expect(recovered.runtime.slots).toEqual([]);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.find((t) => t.id === run.task_id)).toMatchObject({
      status: "ready",
      active_run_id: null,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "failed",
      status: "released",
    });
  });

  it("reclaims a stale slot left over from an already-done task without disturbing its finished run", async () => {
    const dir = await makeTempDir();
    const [run] = await seedTasks(dir, ["TASK-ALREADY-DONE"]);
    if (!run) throw new Error("missing run");
    const slot = boundSlot("slot-already-done", run, {
      workspace_path: "workspaces/cycle-1-slot-already-done",
      status: "crashed",
    });
    await updateLedger(dir, (ledger) => {
      const task = ledger.tasks.find((t) => t.id === run.task_id);
      const stored = ledger.runs.find((r) => r.id === run.id);
      if (!task || !stored) throw new Error("missing recovery fixture");
      stored.phase = "done";
      stored.status = "completed";
      stored.result = "Quality gate passed.";
      task.status = "done";
      task.active_run_id = null;
    });

    const recovered = await recoverOrchestratorRestart({
      stateDir: dir,
      runtime: runtimeWith([slot]),
      persistRuntime: async () => undefined,
    });

    expect(recovered.freedSlotIds).toEqual(["slot-already-done"]);
    expect(recovered.runtime.slots).toEqual([]);
    const ledger = await readLedger(dir);
    // The finished task/run comes through completely untouched.
    expect(ledger.tasks.find((t) => t.id === run.task_id)).toMatchObject({
      status: "done",
      active_run_id: null,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "done",
      status: "completed",
    });
  });
});

describe("classifySlotLiveness", () => {
  async function jobDirWithHeartbeat(
    ageMs: number | null,
    result = false,
  ): Promise<string> {
    const jobDir = await makeTempDir("agent-runtime-job-");
    const paths = durableWorkerPaths(jobDir);
    await writeFile(paths.job, "{}");
    if (ageMs !== null) {
      await writeFile(paths.heartbeat, String(Date.now()));
      const at = new Date(Date.now() - ageMs);
      await utimes(paths.heartbeat, at, at);
      // Backdate job.json too so only the heartbeat decides.
      await utimes(paths.job, at, at);
    }
    if (result) await writeFile(paths.result, "{}");
    return jobDir;
  }

  it("distinguishes alive, hung, dead, finished and inactive slots", async () => {
    const freshDir = await jobDirWithHeartbeat(500);
    const staleDir = await jobDirWithHeartbeat(60_000);
    const doneDir = await jobDirWithHeartbeat(60_000, true);
    const alive = (pid: number) => pid !== 404;

    expect(
      classifySlotLiveness(
        slotFor("A", { pid: process.pid, job_dir: freshDir }),
        { isProcessAlive: alive },
      ),
    ).toBe("alive");
    expect(
      classifySlotLiveness(
        slotFor("B", { pid: process.pid, job_dir: staleDir }),
        { isProcessAlive: alive },
      ),
    ).toBe("hung");
    expect(
      classifySlotLiveness(slotFor("C", { pid: 404, job_dir: freshDir }), {
        isProcessAlive: alive,
      }),
    ).toBe("dead");
    expect(
      classifySlotLiveness(slotFor("D", { pid: 404, job_dir: doneDir }), {
        isProcessAlive: alive,
      }),
    ).toBe("finished");
    expect(
      classifySlotLiveness(slotFor("E", { pid: null, status: "crashed" })),
    ).toBe("inactive");
  });

  it("applies the heartbeat grace to a pid-less starting slot", () => {
    const slot = slotFor("A", { pid: null, status: "starting" });
    const at = Date.parse(AT);
    expect(
      classifySlotLiveness(slot, { now: () => new Date(at + 1_000) }),
    ).toBe("alive");
    expect(
      classifySlotLiveness(slot, { now: () => new Date(at + 60_000) }),
    ).toBe("dead");
  });
});

describe("runner failure fingerprints", () => {
  it("groups recurring failures despite changing paths, ports, pids, hashes, and timestamps", () => {
    const first = runnerFailureFingerprint(
      "2026-01-01T01:02:03.000Z Error: EADDRINUSE port 5173 pid 1122 at C:\\work\\server-a.ts commit abcdef123",
    );
    const second = runnerFailureFingerprint(
      "2026-09-08T09:10:11.123Z Error: address already in use port 4173 pid 9988 at D:\\other\\server-b.ts commit fedcba987",
    );

    expect(first.split(":", 1)[0]).toBe("port-in-use");
    expect(second.split(":", 1)[0]).toBe("port-in-use");
    expect(first).toBe(second);
  });
});
