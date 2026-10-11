import { afterEach, describe, expect, it } from "vitest";
import {
  getHistory,
  getProviders,
  getStatusSnapshot,
  getTaskDetail,
  getTasks,
  getWorkers,
} from "../src/dashboard/state-reader.js";
import {
  buildAgent,
  buildRun,
  buildSlot,
  buildTask,
  cleanupTempDirs,
  createFixtureDir,
} from "./support.js";

afterEach(cleanupTempDirs);

const IN_FLIGHT = {
  task_id: "T-1",
  run_id: "run-1",
  agent: "worker-a",
  attempts: 0,
  last_started_at: "2026-01-15T00:00:00.000Z",
  last_outcome: null,
};

describe("getStatusSnapshot", () => {
  it("reports STOPPED with no current task when nothing is running", async () => {
    const dir = await createFixtureDir({
      tasks: [buildTask({ status: "done" })],
    });
    const snapshot = await getStatusSnapshot(dir);
    expect(snapshot.runtime_status).toBe("STOPPED");
    expect(snapshot.current_task).toBeNull();
    expect(snapshot.last_successful_task).toBe("T-1");
  });

  it("reports RUNNING and the in-flight task when the recorded pid is alive", async () => {
    const dir = await createFixtureDir({
      tasks: [
        buildTask({ id: "T-2", title: "Working task", status: "in_progress" }),
      ],
      runtime: {
        status: "running",
        pid: process.pid,
        started_at: "2026-01-15T00:00:00.000Z",
        in_flight: [{ ...IN_FLIGHT, task_id: "T-2", run_id: "run-2" }],
      },
    });
    const snapshot = await getStatusSnapshot(dir);
    expect(snapshot.runtime_status).toBe("RUNNING");
    expect(snapshot.current_task).toEqual({
      id: "T-2",
      title: "Working task",
      agent: "worker-a",
    });
  });

  it("treats a missing state directory content as an idle, empty runtime", async () => {
    const dir = await createFixtureDir({});
    const snapshot = await getStatusSnapshot(`${dir}-does-not-exist`);
    expect(snapshot.runtime_status).toBe("STOPPED");
    expect(snapshot.worker_count).toBe(0);
  });
});

describe("getWorkers", () => {
  it("labels hung and dead workers differently from live ones", async () => {
    const dir = await createFixtureDir({
      runtime: {
        slots: [
          buildSlot({ slot_id: "live", pid: 111, task_id: "T-1", run_id: "r1", workspace_path: "workspaces/cycle-1-live" }),
          buildSlot({ slot_id: "gone", pid: 222, task_id: "T-2", run_id: "r2", workspace_path: "workspaces/cycle-1-gone" }),
          buildSlot({ slot_id: "failed", pid: null, status: "failed", task_id: "T-3", run_id: "r3", workspace_path: "workspaces/cycle-1-failed" }),
        ],
      },
    });
    const workers = await getWorkers(dir, {
      isProcessAlive: (pid) => pid === 111,
    });
    expect(workers.map((w) => [w.slot_id, w.liveness])).toEqual([
      ["live", "alive"],
      ["gone", "dead"],
      ["failed", "inactive"],
    ]);
  });
});

describe("getProviders", () => {
  it("marks an agent BUSY when it has an in-flight task", async () => {
    const dir = await createFixtureDir({
      agents: [
        buildAgent({ name: "worker-a" }),
        buildAgent({ name: "worker-b" }),
      ],
      runtime: { in_flight: [IN_FLIGHT] },
    });
    const providers = await getProviders(dir);
    const a = providers.find((provider) => provider.name === "worker-a");
    const b = providers.find((provider) => provider.name === "worker-b");
    expect(a?.status).toBe("BUSY");
    expect(a?.current_task_id).toBe("T-1");
    expect(b?.status).toBe("AVAILABLE");
  });

  it("marks an agent QUOTA_LIMITED only while the cooldown is in the future and mentions quota", async () => {
    const dir = await createFixtureDir({
      agents: [buildAgent({ name: "worker-a" })],
      runtime: {
        cooldowns: [
          {
            agent: "worker-a",
            until: "2999-01-01T00:00:00.000Z",
            reason: "quota exhausted",
          },
        ],
      },
    });
    const limited = await getProviders(dir);
    expect(limited[0]?.status).toBe("QUOTA_LIMITED");
    expect(limited[0]?.cooldown_until).toBe("2999-01-01T00:00:00.000Z");

    const afterReset = await getProviders(dir, () => Date.parse("3000-01-01"));
    expect(afterReset[0]?.status).toBe("AVAILABLE");
  });

  it("marks an agent UNAVAILABLE for a non-quota cooldown or when flagged unavailable", async () => {
    const dir = await createFixtureDir({
      agents: [
        buildAgent({ name: "worker-a" }),
        buildAgent({
          name: "worker-b",
          available: false,
          unavailable_reason: "binary missing",
        }),
      ],
      runtime: {
        cooldowns: [
          {
            agent: "worker-a",
            until: "2999-01-01T00:00:00.000Z",
            reason: "network down",
          },
        ],
      },
    });
    const providers = await getProviders(dir);
    expect(providers.find((p) => p.name === "worker-a")).toMatchObject({
      status: "UNAVAILABLE",
      unavailable_reason: "network down",
    });
    expect(providers.find((p) => p.name === "worker-b")).toMatchObject({
      status: "UNAVAILABLE",
      unavailable_reason: "binary missing",
    });
  });
});

describe("getTasks / getTaskDetail", () => {
  it("derives started_at and duration from the task's latest run", async () => {
    const dir = await createFixtureDir({
      tasks: [buildTask({ id: "T-1", status: "done", attempts: 2 })],
      runs: [
        buildRun({
          id: "run-old",
          task_id: "T-1",
          started_at: "2026-01-15T00:00:00.000Z",
          completed_at: "2026-01-15T00:01:00.000Z",
        }),
        buildRun({
          id: "run-new",
          task_id: "T-1",
          agent: "worker-b",
          started_at: "2026-01-15T01:00:00.000Z",
          completed_at: "2026-01-15T01:02:00.000Z",
        }),
      ],
    });
    const [task] = await getTasks(dir);
    expect(task).toMatchObject({
      id: "T-1",
      agent: "worker-b",
      started_at: "2026-01-15T01:00:00.000Z",
      duration_ms: 120_000,
      attempts: 2,
    });
  });

  it("returns the task with its runs, or null for an unknown id", async () => {
    const dir = await createFixtureDir({
      tasks: [buildTask({ id: "T-1" })],
      runs: [buildRun({ id: "run-1", task_id: "T-1" })],
    });
    const detail = await getTaskDetail(dir, "T-1");
    expect(detail?.runs.map((run) => run.id)).toEqual(["run-1"]);
    expect(await getTaskDetail(dir, "nope")).toBeNull();
  });
});

describe("getHistory", () => {
  it("returns newest first and never more than the limit", async () => {
    const dir = await createFixtureDir({
      runtime: {
        history: [
          { at: "2026-01-15T00:00:01.000Z", message: "a" },
          { at: "2026-01-15T00:00:02.000Z", message: "b" },
        ],
      },
    });
    expect((await getHistory(dir, 1)).map((item) => item.message)).toEqual([
      "b",
    ]);
    expect(await getHistory(dir, 0)).toEqual([]);
  });
});
