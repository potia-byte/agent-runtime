import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableWorkerPaths } from "../src/durable-worker.js";
import { type Ledger, ledgerSchema } from "../src/ledger.js";
import { classifyProcessOutcome } from "../src/quota.js";
import {
  initialRuntimeState,
  type RuntimeState,
  type WorkerSlot,
  writeRuntimeState,
} from "../src/runtime-state.js";

/**
 * Synthetic demo state: four worker slots showing every liveness verdict
 * the dashboard can display, one provider paused on quota, and a task list.
 * Nothing here is copied from a real run.
 *
 *   A  alive     real child process, fresh heartbeat (refreshed while the
 *                demo is up)
 *   B  hung      real child process, but its heartbeat is ten minutes old
 *   C  dead      pid of a process that has already exited
 *   D  finished  result.json already on disk, runner gone
 */

export interface DemoState {
  dir: string;
  /** Stops the helper processes and the heartbeat refresher. */
  stop(): Promise<void>;
}

const MINUTE = 60_000;

function idleChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function pidOf(child: ChildProcess): Promise<number> {
  if (child.pid !== undefined) return child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("child has no pid");
  return child.pid;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = await pidOf(child);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

function jobDir(dir: string, name: string): string {
  const path = join(dir, "workers", name);
  mkdirSync(path, { recursive: true });
  return path;
}

export async function buildDemoState(dir: string): Promise<DemoState> {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const children: ChildProcess[] = [];

  const aliveChild = idleChild();
  const hungChild = idleChild();
  children.push(aliveChild, hungChild);
  const [alivePid, hungPid, deadPid] = await Promise.all([
    pidOf(aliveChild),
    pidOf(hungChild),
    exitedPid(),
  ]);

  // A: fresh heartbeat, kept fresh by the refresher below.
  const jobA = jobDir(dir, "run-demo-A");
  const heartbeatA = durableWorkerPaths(jobA).heartbeat;
  writeFileSync(heartbeatA, String(now));
  const refresher = setInterval(() => {
    try {
      writeFileSync(heartbeatA, String(Date.now()));
    } catch {
      // Directory already removed during shutdown.
    }
  }, 1000);
  refresher.unref();

  // B: alive pid, heartbeat ten minutes old -> "hung".
  const jobB = jobDir(dir, "run-demo-B");
  const heartbeatB = durableWorkerPaths(jobB).heartbeat;
  writeFileSync(heartbeatB, String(now - 10 * MINUTE));
  const old = new Date(now - 10 * MINUTE);
  utimesSync(heartbeatB, old, old);

  // C: pid no longer exists.
  const jobC = jobDir(dir, "run-demo-C");
  writeFileSync(durableWorkerPaths(jobC).heartbeat, String(now - MINUTE));

  // D: finished while nobody was watching.
  const jobD = jobDir(dir, "run-demo-D");
  writeFileSync(
    durableWorkerPaths(jobD).result,
    JSON.stringify({
      exit_code: 0,
      signal: null,
      timed_out: false,
      aborted: false,
      spawn_error: null,
      finished_at: iso(-2 * MINUTE),
    }),
  );

  const slot = (
    id: string,
    taskId: string,
    pid: number,
    job: string,
    status: WorkerSlot["status"],
    worker: string,
  ): WorkerSlot => ({
    slot_id: id,
    controller_id: "demo",
    worker,
    workspace_path: join("workspaces", `demo-${id}`),
    task_id: taskId,
    run_id: `run-${taskId}`,
    pid,
    job_dir: job,
    started_at: iso(-20 * MINUTE),
    heartbeat_at: iso(-30_000),
    status,
  });

  const slots: WorkerSlot[] = [
    slot("A", "T-101", alivePid, jobA, "running", "worker-a"),
    slot("B", "T-102", hungPid, jobB, "running", "worker-b"),
    slot("C", "T-103", deadPid, jobC, "running", "worker-c"),
    slot("D", "T-104", deadPid, jobD, "running", "worker-a"),
  ];

  // The pause reason comes from the real classifier applied to a typical
  // provider refusal, not from a hard-coded label.
  const refusal = {
    exitCode: 1,
    stdout: "",
    stderr: "Error: 429 Too Many Requests - usage limit reached",
    timedOut: false,
  };
  const outcome = classifyProcessOutcome(refusal);

  const runtime: RuntimeState = {
    ...initialRuntimeState(),
    status: "running",
    pid: process.pid,
    started_at: iso(-45 * MINUTE),
    in_flight: [
      {
        task_id: "T-101",
        run_id: "run-T-101",
        agent: "worker-a",
        attempts: 1,
        last_started_at: iso(-20 * MINUTE),
        last_outcome: null,
      },
    ],
    slots,
    cooldowns: [
      {
        agent: "worker-b",
        until: iso(25 * MINUTE),
        reason: `${outcome} limit: provider refused the request`,
      },
    ],
    history: [
      { at: iso(-45 * MINUTE), message: "runtime started" },
      { at: iso(-20 * MINUTE), message: "launched 4 detached workers" },
      {
        at: iso(-12 * MINUTE),
        message: `worker-b refused (${outcome}); cooling down for 30 min`,
      },
      {
        at: iso(-2 * MINUTE),
        message: "slot D finished; result awaiting reconciliation",
      },
    ],
  };
  await writeRuntimeState(dir, runtime);

  const task = (
    id: string,
    title: string,
    status: Ledger["tasks"][number]["status"],
    extra: Partial<Ledger["tasks"][number]> = {},
  ) => ({
    id,
    title,
    description: `Synthetic demo task ${id}.`,
    status,
    priority: 50,
    depends_on: [],
    recommended_agent: "worker-a",
    attempts: status === "todo" || status === "ready" ? 0 : 1,
    active_run_id: null,
    last_error: null,
    created_at: iso(-60 * MINUTE),
    updated_at: iso(-10 * MINUTE),
    ...extra,
  });
  const run = (
    taskId: string,
    agent: string,
    status: Ledger["runs"][number]["status"],
    phase: Ledger["runs"][number]["phase"],
  ) => ({
    id: `run-${taskId}`,
    task_id: taskId,
    agent,
    status,
    phase,
    started_at: iso(-20 * MINUTE),
    updated_at: iso(-5 * MINUTE),
    completed_at: status === "completed" ? iso(-5 * MINUTE) : null,
    result: null,
    result_id: null,
  });

  const ledger = ledgerSchema.parse({
    schema_version: 1,
    agents: [
      { name: "worker-a" },
      { name: "worker-b" },
      { name: "worker-c" },
      {
        name: "worker-d",
        available: false,
        unavailable_reason: "binary not installed on this host",
      },
    ],
    tasks: [
      task("T-100", "Prepare sample dataset", "done"),
      task("T-101", "Summarise changelog", "in_progress", {
        active_run_id: "run-T-101",
      }),
      task("T-102", "Extract entities", "in_progress", {
        active_run_id: "run-T-102",
        recommended_agent: "worker-b",
      }),
      task("T-103", "Generate fixtures", "in_progress", {
        active_run_id: "run-T-103",
        recommended_agent: "worker-c",
      }),
      task("T-104", "Validate output schema", "in_progress", {
        active_run_id: "run-T-104",
      }),
      task("T-105", "Publish report", "todo", { depends_on: ["T-104"] }),
      task("T-106", "Rebuild index", "blocked", {
        last_error: "Crash recovery failed for worker slot X: workspace busy.",
      }),
    ],
    runs: [
      run("T-100", "worker-a", "completed", "done"),
      run("T-101", "worker-a", "running", "running"),
      run("T-102", "worker-b", "running", "running"),
      run("T-103", "worker-c", "running", "running"),
      run("T-104", "worker-a", "running", "running"),
    ],
    updated_at: iso(0),
  });
  writeFileSync(join(dir, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

  writeFileSync(
    join(dir, "runtime.log"),
    [
      `${iso(-45 * MINUTE)} runtime started pid=${process.pid}`,
      `${iso(-20 * MINUTE)} launched slots A B C D`,
      `${iso(-12 * MINUTE)} worker-b: ${refusal.stderr}`,
      `${iso(-12 * MINUTE)} classified as ${outcome}; cooldown 30 min`,
    ].join("\n") + "\n",
  );

  return {
    dir,
    async stop() {
      clearInterval(refresher);
      for (const child of children) child.kill();
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
              } else {
                child.once("exit", () => resolve());
              }
            }),
        ),
      );
    },
  };
}
