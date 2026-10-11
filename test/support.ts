import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRetry } from "../src/fs-retry.js";
import type { Agent, Run, Task } from "../src/ledger.js";
import type { RuntimeState, WorkerSlot } from "../src/runtime-state.js";

export const NOW = "2026-01-15T00:00:00.000Z";

export function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-1",
    title: "Example task",
    description: "Example description",
    status: "todo",
    priority: 50,
    depends_on: [],
    recommended_agent: "worker-a",
    attempts: 0,
    active_run_id: null,
    last_error: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function buildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    task_id: "T-1",
    agent: "worker-a",
    status: "completed",
    phase: "done",
    started_at: NOW,
    updated_at: NOW,
    completed_at: NOW,
    result: null,
    result_id: null,
    ...overrides,
  };
}

export function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "worker-a",
    available: true,
    unavailable_reason: null,
    ...overrides,
  };
}

export function buildSlot(overrides: Partial<WorkerSlot> = {}): WorkerSlot {
  return {
    slot_id: "A",
    controller_id: "cycle-1",
    worker: "worker-a",
    workspace_path: "workspaces/cycle-1-A",
    task_id: "T-1",
    run_id: "run-1",
    pid: null,
    started_at: NOW,
    heartbeat_at: NOW,
    status: "running",
    ...overrides,
  };
}

const directories: string[] = [];

/** Creates a temp directory that `cleanupTempDirs` removes (with retries). */
export async function makeTempDir(prefix = "agent-runtime-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  for (const dir of directories.splice(0)) {
    await removeRetry(dir, { retryDelaysMs: [50, 100, 200, 400, 800, 1600] });
  }
}

export interface FixtureOptions {
  tasks?: Task[];
  runs?: Run[];
  agents?: Agent[];
  runtime?: Partial<RuntimeState>;
}

/** Writes synthetic runtime.json / ledger.json into a fresh state directory. */
export async function createFixtureDir(
  options: FixtureOptions = {},
): Promise<string> {
  const dir = await makeTempDir("agent-runtime-fixture-");
  await mkdir(dir, { recursive: true });
  const ledger = {
    schema_version: 1,
    tasks: options.tasks ?? [],
    runs: options.runs ?? [],
    agents: options.agents ?? [buildAgent()],
    updated_at: NOW,
  };
  await writeFile(join(dir, "ledger.json"), JSON.stringify(ledger, null, 2));
  const runtime = {
    schema_version: 1,
    status: "stopped",
    pid: null,
    started_at: null,
    updated_at: NOW,
    in_flight: [],
    slots: [],
    cooldowns: [],
    history: [],
    ...options.runtime,
  };
  await writeFile(join(dir, "runtime.json"), JSON.stringify(runtime, null, 2));
  return dir;
}
