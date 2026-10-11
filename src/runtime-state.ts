import { constants } from "node:fs";
import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type AtomicWriteOptions,
  atomicWriteFile,
  cleanupStaleAtomicTempFiles,
} from "./atomic-file.js";
import { readTextRetry } from "./fs-retry.js";
import { isProcessAlive } from "./process.js";

/**
 * Runtime state file: what the orchestrator process is doing right now.
 *
 * Everything lives in one "state directory" the caller chooses (the demo
 * and the dashboard take it from AGENT_RUNTIME_DIR). Nothing in this module
 * assumes a project layout around it.
 *
 *   <dir>/runtime.json   this file's schema (single writer, atomic replace)
 *   <dir>/runtime.lock   pid lock held for the orchestrator's lifetime
 *   <dir>/runtime.log    append-only text log (tail shown in the dashboard)
 */

export const RUNTIME_FILE = "runtime.json";
export const RUNTIME_LOCK_FILE = "runtime.lock";
export const RUNTIME_LOG_FILE = "runtime.log";
const HISTORY_LIMIT = 200;

export const inFlightEntrySchema = z.object({
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  agent: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  last_started_at: z.string().min(1),
  last_outcome: z.enum(["quota", "error", "timeout", "aborted"]).nullable(),
  child_pid: z.number().int().nullable().optional(),
  heartbeat_at: z.string().nullable().optional(),
});
export type InFlightEntry = z.infer<typeof inFlightEntrySchema>;

/**
 * One worker slot: a single detached worker, the isolated workspace it
 * writes into, and the task/run it owns. Controller-owned: workers never
 * write this record themselves.
 */
export const workerSlotSchema = z.object({
  slot_id: z.string().min(1),
  /** Identifies the controller cycle that created the slot workspace. */
  controller_id: z.string().min(1),
  worker: z.string().min(1),
  /** Workspace directory; relative paths resolve against the state directory. */
  workspace_path: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  /**
   * Durable process identity of the worker. For a detached worker this is
   * the runner pid, alive independently of the orchestrator that launched it.
   */
  pid: z.number().int().nullable(),
  /** Durable worker job directory (prompt, output files, heartbeat, result). */
  job_dir: z.string().min(1).optional(),
  started_at: z.string().min(1),
  heartbeat_at: z.string().min(1),
  status: z.enum(["starting", "running", "completed", "failed", "crashed"]),
});
export type WorkerSlot = z.infer<typeof workerSlotSchema>;

function normalizedSlotPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** Rejects ambiguous ownership: duplicate slot, workspace, task or run. */
export const workerSlotsSchema = z
  .array(workerSlotSchema)
  .superRefine((slots, context) => {
    const slotIds = new Set<string>();
    const workspaces = new Set<string>();
    const taskIds = new Set<string>();
    const runIds = new Set<string>();
    for (const [index, slot] of slots.entries()) {
      if (slotIds.has(slot.slot_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "slot_id"],
          message: `Duplicate worker slot id: ${slot.slot_id}`,
        });
      }
      slotIds.add(slot.slot_id);

      const path = normalizedSlotPath(slot.workspace_path);
      if (workspaces.has(path)) {
        context.addIssue({
          code: "custom",
          path: [index, "workspace_path"],
          message: `Duplicate worker workspace ownership: ${slot.workspace_path}`,
        });
      }
      workspaces.add(path);

      if (taskIds.has(slot.task_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "task_id"],
          message: `Duplicate worker task ownership: ${slot.task_id}`,
        });
      }
      taskIds.add(slot.task_id);

      if (runIds.has(slot.run_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "run_id"],
          message: `Duplicate worker run ownership: ${slot.run_id}`,
        });
      }
      runIds.add(slot.run_id);
    }
  });

export const cooldownSchema = z.object({
  agent: z.string().min(1),
  until: z.string().min(1),
  reason: z.string(),
});
export type Cooldown = z.infer<typeof cooldownSchema>;

export const runtimeStateSchema = z.object({
  schema_version: z.literal(1).default(1),
  status: z.enum(["idle", "running", "stopped"]).default("idle"),
  pid: z.number().int().nullable().default(null),
  started_at: z.string().nullable().default(null),
  updated_at: z.string().default(() => new Date().toISOString()),
  in_flight: z.array(inFlightEntrySchema).default([]),
  slots: workerSlotsSchema.default([]),
  cooldowns: z.array(cooldownSchema).default([]),
  history: z
    .array(z.object({ at: z.string(), message: z.string() }))
    .default([]),
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export function runtimePaths(dir: string) {
  return {
    directory: dir,
    runtime: join(dir, RUNTIME_FILE),
    lock: join(dir, RUNTIME_LOCK_FILE),
    log: join(dir, RUNTIME_LOG_FILE),
  };
}

export function initialRuntimeState(
  now = new Date().toISOString(),
): RuntimeState {
  return {
    schema_version: 1,
    status: "idle",
    pid: null,
    started_at: null,
    updated_at: now,
    in_flight: [],
    slots: [],
    cooldowns: [],
    history: [],
  };
}

/** Reads and validates the runtime file; a missing file is an idle state. */
export async function readRuntimeState(dir: string): Promise<RuntimeState> {
  let text: string;
  try {
    text = await readTextRetry(runtimePaths(dir).runtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return initialRuntimeState();
    }
    throw error;
  }
  return runtimeStateSchema.parse(JSON.parse(text));
}

export async function writeRuntimeState(
  dir: string,
  state: RuntimeState,
  options?: AtomicWriteOptions,
): Promise<void> {
  const target = runtimePaths(dir);
  await mkdir(target.directory, { recursive: true });
  // Structural validation before anything touches the canonical file.
  workerSlotsSchema.parse(state.slots);
  const trimmed: RuntimeState = {
    ...state,
    history: state.history.slice(-HISTORY_LIMIT),
    updated_at: new Date().toISOString(),
  };
  // Best-effort: stale-temp housekeeping must never fail the real write.
  await cleanupStaleAtomicTempFiles(target.runtime, {
    ...(options?.now ? { now: options.now } : {}),
  }).catch(() => undefined);
  await atomicWriteFile(
    target.runtime,
    `${JSON.stringify(trimmed, null, 2)}\n`,
    { mode: 0o600, ...options },
  );
}

export async function appendRuntimeLog(
  dir: string,
  message: string,
): Promise<void> {
  const target = runtimePaths(dir);
  await mkdir(target.directory, { recursive: true });
  await appendFile(target.log, `${new Date().toISOString()} ${message}\n`, {
    encoding: "utf8",
  });
}

export async function readRuntimeLogTail(
  dir: string,
  lines = 20,
): Promise<string[]> {
  try {
    const content = await readFile(runtimePaths(dir).log, "utf8");
    return content.split("\n").filter(Boolean).slice(-lines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Guards against a second concurrent orchestrator. Unlike the short-lived
 * ledger lock (mtime staleness window), this lock is held for the whole
 * process lifetime, so staleness is decided by whether the recorded pid is
 * still alive, not by elapsed time.
 */
export async function acquireRuntimeLock(
  dir: string,
): Promise<() => Promise<void>> {
  const target = runtimePaths(dir);
  await mkdir(target.directory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(
        target.lock,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(
        `${process.pid}\n${new Date().toISOString()}\n`,
        "utf8",
      );
      await handle.close();
      return async () => {
        await unlink(target.lock).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target.lock, "utf8").catch(() => "");
      const pid = Number.parseInt(existing.split("\n")[0] ?? "", 10);
      if (!Number.isInteger(pid)) {
        throw new Error(
          `Runtime lock inconsistency: ${target.lock} does not contain a valid pid. Inspect it before retrying.`,
        );
      }
      if (!isProcessAlive(pid)) {
        await unlink(target.lock).catch(() => undefined);
        continue;
      }
      const runtimePid = await readFile(target.runtime, "utf8")
        .then((content) => (JSON.parse(content) as { pid?: unknown }).pid)
        .catch(() => undefined);
      if (typeof runtimePid === "number" && runtimePid !== pid) {
        throw new Error(
          `Runtime lock inconsistency: lock pid ${pid} does not match runtime pid ${String(runtimePid)}. Inspect both files before retrying.`,
        );
      }
      throw new Error(
        `Runtime is already running (pid ${pid}). Stop it first, or delete ${target.lock} if that process is actually gone.`,
      );
    }
  }

  throw new Error("Could not acquire the runtime lock.");
}
