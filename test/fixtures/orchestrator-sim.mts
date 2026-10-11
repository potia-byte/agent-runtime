// A separate process that plays the orchestrator: it launches two real
// detached workers through the production API, persists their runner pids
// into runtime.json, releases them, and then just waits. The test kills it
// with SIGKILL (no cleanup runs) to prove the workers outlive it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchDurableWorker, releaseDurableWorker } from "../../src/durable-worker.js";
import {
  initialRuntimeState,
  type WorkerSlot,
  writeRuntimeState,
} from "../../src/runtime-state.js";

const [dir, runA, runB, script] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const now = () => new Date().toISOString();

const slots: WorkerSlot[] = [];
for (const [slotId, taskId, runId] of [
  ["A", "TASK-A", runA],
  ["B", "TASK-B", runB],
] as const) {
  const workspace = join("workspaces", `sim-${slotId}`);
  mkdirSync(join(dir, workspace), { recursive: true });
  const launched = await launchDurableWorker({
    stateDir: dir,
    runId: "run-sim",
    slotId,
    command: process.execPath,
    args: [script],
    input: slotId,
    cwd: join(dir, workspace),
    timeoutMs: 60_000,
  });
  slots.push({
    slot_id: slotId,
    controller_id: "sim",
    worker: "sim-worker",
    workspace_path: workspace,
    task_id: taskId,
    run_id: runId,
    pid: launched.pid,
    job_dir: launched.jobDir,
    started_at: now(),
    heartbeat_at: now(),
    status: "running",
  });
}
// The pids are durable BEFORE any worker is allowed to start.
await writeRuntimeState(dir, {
  ...initialRuntimeState(),
  status: "running",
  pid: process.pid,
  slots,
});
for (const slot of slots) {
  if (slot.job_dir) releaseDurableWorker(slot.job_dir);
}
setInterval(() => undefined, 1000);
