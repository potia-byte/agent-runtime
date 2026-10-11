import { type Agent, type Run, readLedger, type Task } from "../ledger.js";
import { isProcessAlive } from "../process.js";
import { classifySlotLiveness, type SlotLiveness } from "../runtime-health.js";
import {
  readRuntimeLogTail,
  readRuntimeState,
  type WorkerSlot,
} from "../runtime-state.js";

/**
 * Read-only views over the two state files (runtime.json, ledger.json).
 * Every function re-reads from disk, so the dashboard shows what is on disk
 * right now and never caches anything.
 */

export interface StatusSnapshot {
  runtime_status: "RUNNING" | "STOPPED";
  pid: number | null;
  started_at: string | null;
  updated_at: string;
  current_task: { id: string; title: string; agent: string } | null;
  in_flight_count: number;
  worker_count: number;
  last_successful_task: string | null;
  last_message: string | null;
}

export async function getStatusSnapshot(dir: string): Promise<StatusSnapshot> {
  const [runtime, ledger] = await Promise.all([
    readRuntimeState(dir),
    readLedger(dir),
  ]);
  const isAlive = runtime.pid !== null && isProcessAlive(runtime.pid);
  const inFlightEntry = runtime.in_flight[0] ?? null;
  const inFlightTask = inFlightEntry
    ? ledger.tasks.find((task) => task.id === inFlightEntry.task_id)
    : undefined;
  const lastDoneTask = [...ledger.tasks]
    .filter((task) => task.status === "done")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  return {
    runtime_status: isAlive ? "RUNNING" : "STOPPED",
    pid: runtime.pid,
    started_at: runtime.started_at,
    updated_at: runtime.updated_at,
    current_task:
      inFlightEntry && inFlightTask
        ? {
            id: inFlightTask.id,
            title: inFlightTask.title,
            agent: inFlightEntry.agent,
          }
        : null,
    in_flight_count: runtime.in_flight.length,
    worker_count: runtime.slots.length,
    last_successful_task: lastDoneTask?.id ?? null,
    last_message: runtime.history.at(-1)?.message ?? null,
  };
}

export interface WorkerView {
  slot_id: string;
  worker: string;
  task_id: string;
  run_id: string;
  pid: number | null;
  status: WorkerSlot["status"];
  liveness: SlotLiveness;
  started_at: string;
  heartbeat_at: string;
  workspace_path: string;
}

export async function getWorkers(
  dir: string,
  options: { now?: () => Date; isProcessAlive?: (pid: number) => boolean } = {},
): Promise<WorkerView[]> {
  const runtime = await readRuntimeState(dir);
  return runtime.slots.map((slot) => ({
    slot_id: slot.slot_id,
    worker: slot.worker,
    task_id: slot.task_id,
    run_id: slot.run_id,
    pid: slot.pid,
    status: slot.status,
    liveness: classifySlotLiveness(slot, options),
    started_at: slot.started_at,
    heartbeat_at: slot.heartbeat_at,
    workspace_path: slot.workspace_path,
  }));
}

export interface ProviderStatus {
  name: string;
  status: "AVAILABLE" | "BUSY" | "QUOTA_LIMITED" | "UNAVAILABLE";
  current_task_id: string | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  unavailable_reason: string | null;
  last_successful_run_at: string | null;
}

function providerNames(
  agents: Agent[],
  runtime: Awaited<ReturnType<typeof readRuntimeState>>,
): string[] {
  const names = new Set(agents.map((agent) => agent.name));
  for (const entry of runtime.in_flight) names.add(entry.agent);
  for (const cooldown of runtime.cooldowns) names.add(cooldown.agent);
  return [...names];
}

export async function getProviders(
  dir: string,
  now: () => number = Date.now,
): Promise<ProviderStatus[]> {
  const [runtime, ledger] = await Promise.all([
    readRuntimeState(dir),
    readLedger(dir),
  ]);
  const current = now();

  return providerNames(ledger.agents, runtime).map((name) => {
    const agent = ledger.agents.find((candidate) => candidate.name === name);
    const inFlight = runtime.in_flight.find((entry) => entry.agent === name);
    const cooldown = runtime.cooldowns.find(
      (entry) => entry.agent === name && Date.parse(entry.until) > current,
    );
    const lastSuccessfulRun = [...ledger.runs]
      .filter((run) => run.agent === name && run.status === "completed")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

    let status: ProviderStatus["status"];
    if (agent && !agent.available) {
      status = "UNAVAILABLE";
    } else if (inFlight) {
      status = "BUSY";
    } else if (cooldown) {
      status = cooldown.reason.toLowerCase().includes("quota")
        ? "QUOTA_LIMITED"
        : "UNAVAILABLE";
    } else {
      status = "AVAILABLE";
    }

    return {
      name,
      status,
      current_task_id: inFlight?.task_id ?? null,
      cooldown_until: cooldown?.until ?? null,
      cooldown_reason: cooldown?.reason ?? null,
      unavailable_reason:
        agent && !agent.available
          ? agent.unavailable_reason
          : status === "UNAVAILABLE" && cooldown
            ? cooldown.reason
            : null,
      last_successful_run_at: lastSuccessfulRun?.updated_at ?? null,
    };
  });
}

export interface TaskSummary {
  id: string;
  title: string;
  priority: number;
  status: Task["status"];
  agent: string;
  started_at: string | null;
  duration_ms: number | null;
  attempts: number;
}

function latestRunFor(runs: Run[], taskId: string): Run | undefined {
  return [...runs]
    .filter((run) => run.task_id === taskId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
}

export async function getTasks(
  dir: string,
  now: () => Date = () => new Date(),
): Promise<TaskSummary[]> {
  const ledger = await readLedger(dir);
  const nowIso = now().toISOString();
  return ledger.tasks.map((task) => {
    const run = latestRunFor(ledger.runs, task.id);
    const startedAt = run?.started_at ?? null;
    const endedAt = run ? (run.completed_at ?? nowIso) : null;
    const durationMs =
      startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : null;
    return {
      id: task.id,
      title: task.title,
      priority: task.priority,
      status: task.status,
      agent: run?.agent ?? task.recommended_agent,
      started_at: startedAt,
      duration_ms: durationMs,
      attempts: task.attempts,
    };
  });
}

export interface TaskDetail extends Task {
  runs: Run[];
}

export async function getTaskDetail(
  dir: string,
  taskId: string,
): Promise<TaskDetail | null> {
  const ledger = await readLedger(dir);
  const task = ledger.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return null;
  return {
    ...task,
    runs: ledger.runs.filter((run) => run.task_id === taskId),
  };
}

export async function getHistory(
  dir: string,
  limit = 50,
): Promise<Array<{ at: string; message: string }>> {
  const runtime = await readRuntimeState(dir);
  return [...runtime.history]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(0, limit));
}

export async function getLogTail(dir: string, limit = 50): Promise<string[]> {
  return readRuntimeLogTail(dir, limit);
}
