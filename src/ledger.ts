import { constants } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile, cleanupStaleAtomicTempFiles } from "./atomic-file.js";
import { readTextRetry } from "./fs-retry.js";

/**
 * Minimal work ledger: which tasks exist and which run (one attempt by one
 * agent) currently owns each of them. Restart recovery reconciles the
 * runtime slots against this ledger before it touches any workspace.
 *
 *   <dir>/ledger.json  tasks / runs / agents, replaced atomically
 *   <dir>/ledger.lock  short-lived advisory lock around read-modify-write
 */

export const LEDGER_FILE = "ledger.json";
export const LEDGER_LOCK_FILE = "ledger.lock";

export const taskStatuses = [
  "todo",
  "ready",
  "in_progress",
  "validating",
  "blocked",
  "done",
] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const runPhases = [
  "ready",
  "leased",
  "running",
  "blocked-on-dep",
  "waiting-quota",
  "done",
  "failed",
] as const;
export const runPhaseSchema = z.enum(runPhases);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  status: taskStatusSchema,
  priority: z.number().int().default(50),
  depends_on: z.array(z.string()).default([]),
  recommended_agent: z.string().min(1).default("worker"),
  attempts: z.number().int().nonnegative().default(0),
  active_run_id: z.string().nullable().default(null),
  last_error: z.string().nullable().default(null),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type Task = z.infer<typeof taskSchema>;

export const runSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(["running", "validating", "completed", "blocked", "released"]),
  phase: runPhaseSchema.default("running"),
  started_at: z.string().min(1),
  updated_at: z.string().min(1),
  completed_at: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  /**
   * Set once the worker result has been submitted and awaits
   * reconciliation. While set, heartbeat recovery must not reclaim the run
   * merely because the worker process has already exited.
   */
  result_id: z.string().nullable().default(null),
});
export type Run = z.infer<typeof runSchema>;

export const agentSchema = z.object({
  name: z.string().min(1),
  available: z.boolean().default(true),
  unavailable_reason: z.string().nullable().default(null),
});
export type Agent = z.infer<typeof agentSchema>;

export const ledgerSchema = z.object({
  schema_version: z.literal(1).default(1),
  tasks: z.array(taskSchema).default([]),
  runs: z.array(runSchema).default([]),
  agents: z.array(agentSchema).default([]),
  updated_at: z.string().default(() => new Date().toISOString()),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export function ledgerPaths(dir: string) {
  return {
    directory: dir,
    ledger: join(dir, LEDGER_FILE),
    lock: join(dir, LEDGER_LOCK_FILE),
  };
}

export function emptyLedger(now = new Date().toISOString()): Ledger {
  return { schema_version: 1, tasks: [], runs: [], agents: [], updated_at: now };
}

export async function readLedger(dir: string): Promise<Ledger> {
  let text: string;
  try {
    text = await readTextRetry(ledgerPaths(dir).ledger);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyLedger();
    }
    throw error;
  }
  return ledgerSchema.parse(JSON.parse(text));
}

async function writeLedger(dir: string, ledger: Ledger): Promise<void> {
  const target = ledgerPaths(dir);
  await mkdir(target.directory, { recursive: true });
  const parsed = ledgerSchema.parse(ledger);
  await cleanupStaleAtomicTempFiles(target.ledger).catch(() => undefined);
  await atomicWriteFile(
    target.ledger,
    `${JSON.stringify(parsed, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const target = ledgerPaths(dir);
  await mkdir(target.directory, { recursive: true });

  for (let attempt = 0; attempt < 80; attempt += 1) {
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
      return async () => {
        await handle.close();
        await unlink(target.lock).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(target.lock).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 60_000) {
        await unlink(target.lock).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(
    "Ledger is busy. Retry after the other writer finishes its update.",
  );
}

/**
 * Serialized read-modify-write of the ledger. The mutation runs under an
 * advisory lock; the result is validated and written atomically.
 */
export async function updateLedger<T>(
  dir: string,
  mutate: (ledger: Ledger) => T | Promise<T>,
): Promise<T> {
  const release = await acquireLock(dir);
  try {
    const ledger = await readLedger(dir);
    const result = await mutate(ledger);
    ledger.updated_at = new Date().toISOString();
    await writeLedger(dir, ledger);
    return result;
  } finally {
    await release();
  }
}

export const runPhaseTransitions: Readonly<
  Record<RunPhase, readonly RunPhase[]>
> = {
  ready: ["leased"],
  leased: ["running", "blocked-on-dep", "failed"],
  running: ["blocked-on-dep", "waiting-quota", "done", "failed"],
  "blocked-on-dep": ["ready", "failed"],
  "waiting-quota": ["running", "failed"],
  done: [],
  failed: [],
};

export function transitionRunPhase(run: Run, nextPhase: RunPhase): void {
  if (!runPhaseTransitions[run.phase].includes(nextPhase)) {
    throw new Error(
      `Invalid run phase transition for ${run.id}: ${run.phase} -> ${nextPhase}.`,
    );
  }
  run.phase = nextPhase;
}

export interface NewTask {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  depends_on?: string[];
  recommended_agent?: string;
}

function taskById(ledger: Ledger, taskId: string): Task {
  const task = ledger.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}

function dependenciesDone(ledger: Ledger, task: Task): boolean {
  return task.depends_on.every(
    (dependency) => taskById(ledger, dependency).status === "done",
  );
}

/** Adds tasks; those with all dependencies done start "ready", else "todo". */
export async function addTasks(
  dir: string,
  tasks: NewTask[],
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateLedger(dir, (ledger) => {
    const createdAt = now().toISOString();
    for (const input of tasks) {
      if (ledger.tasks.some((task) => task.id === input.id)) {
        throw new Error(`Duplicate task id: ${input.id}`);
      }
      ledger.tasks.push(
        taskSchema.parse({
          id: input.id,
          title: input.title,
          description: input.description ?? "",
          priority: input.priority ?? 50,
          depends_on: input.depends_on ?? [],
          recommended_agent: input.recommended_agent ?? "worker",
          status: "todo",
          created_at: createdAt,
          updated_at: createdAt,
        }),
      );
    }
    for (const task of ledger.tasks) {
      if (task.status === "todo" && dependenciesDone(ledger, task)) {
        task.status = "ready";
      }
    }
  });
}

let runCounter = 0;

/** Claims a ready task for an agent and returns the new run. */
export async function claimTask(
  dir: string,
  taskId: string,
  agent: string,
  now: () => Date = () => new Date(),
): Promise<Run> {
  return updateLedger(dir, (ledger) => {
    const task = taskById(ledger, taskId);
    if (task.status !== "ready") {
      throw new Error(`Task ${taskId} is ${task.status}, not ready.`);
    }
    const startedAt = now().toISOString();
    runCounter += 1;
    const run: Run = runSchema.parse({
      id: `run-${Date.now()}-${process.pid}-${runCounter}`,
      task_id: taskId,
      agent,
      status: "running",
      phase: "running",
      started_at: startedAt,
      updated_at: startedAt,
    });
    ledger.runs.push(run);
    task.status = "in_progress";
    task.active_run_id = run.id;
    task.attempts += 1;
    task.updated_at = startedAt;
    return run;
  });
}

/** Releases an owned task for another attempt (its run is failed/released). */
export async function releaseTask(
  dir: string,
  taskId: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  await updateLedger(dir, (ledger) => {
    const task = taskById(ledger, taskId);
    if (
      task.status !== "in_progress" &&
      task.status !== "validating" &&
      task.status !== "blocked"
    ) {
      throw new Error(
        `Task ${taskId} cannot be released while ${task.status}.`,
      );
    }
    const releasedAt = now().toISOString();
    if (task.active_run_id) {
      const run = ledger.runs.find(
        (candidate) => candidate.id === task.active_run_id,
      );
      if (!run) throw new Error(`Task ${task.id} has no active run.`);
      if (run.phase !== "failed") transitionRunPhase(run, "failed");
      run.status = "released";
      run.updated_at = releasedAt;
      run.completed_at = releasedAt;
      run.result = "Released for another attempt.";
    }
    task.active_run_id = null;
    task.status = dependenciesDone(ledger, task) ? "ready" : "todo";
    task.updated_at = releasedAt;
  });
}
