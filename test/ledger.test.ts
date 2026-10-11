import { afterEach, describe, expect, it } from "vitest";
import {
  addTasks,
  claimTask,
  readLedger,
  releaseTask,
  runPhaseTransitions,
  transitionRunPhase,
  updateLedger,
} from "../src/ledger.js";
import { buildRun, cleanupTempDirs, makeTempDir } from "./support.js";

afterEach(cleanupTempDirs);

describe("ledger", () => {
  it("starts tasks without open dependencies as ready, others as todo", async () => {
    const dir = await makeTempDir();
    await addTasks(dir, [
      { id: "A", title: "A" },
      { id: "B", title: "B", depends_on: ["A"] },
    ]);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.map((task) => [task.id, task.status])).toEqual([
      ["A", "ready"],
      ["B", "todo"],
    ]);
  });

  it("rejects duplicate task ids", async () => {
    const dir = await makeTempDir();
    await addTasks(dir, [{ id: "A", title: "A" }]);
    await expect(addTasks(dir, [{ id: "A", title: "again" }])).rejects.toThrow(
      /Duplicate task id/,
    );
  });

  it("claims a ready task once and refuses a second claim", async () => {
    const dir = await makeTempDir();
    await addTasks(dir, [{ id: "A", title: "A" }]);
    const run = await claimTask(dir, "A", "worker-a");
    const ledger = await readLedger(dir);
    expect(ledger.tasks[0]).toMatchObject({
      status: "in_progress",
      active_run_id: run.id,
      attempts: 1,
    });
    await expect(claimTask(dir, "A", "worker-b")).rejects.toThrow(/not ready/);
  });

  it("releases a task: run failed/released, task ready again", async () => {
    const dir = await makeTempDir();
    await addTasks(dir, [{ id: "A", title: "A" }]);
    const run = await claimTask(dir, "A", "worker-a");
    await releaseTask(dir, "A");
    const ledger = await readLedger(dir);
    expect(ledger.tasks[0]).toMatchObject({
      status: "ready",
      active_run_id: null,
    });
    expect(ledger.runs.find((r) => r.id === run.id)).toMatchObject({
      phase: "failed",
      status: "released",
    });
    await expect(releaseTask(dir, "A")).rejects.toThrow(/cannot be released/);
  });

  it("serializes concurrent updates without losing any of them", async () => {
    const dir = await makeTempDir();
    await addTasks(dir, [{ id: "A", title: "A" }]);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateLedger(dir, (ledger) => {
          const task = ledger.tasks[0];
          if (task) task.attempts += 1;
        }),
      ),
    );
    expect((await readLedger(dir)).tasks[0]?.attempts).toBe(12);
  });

  it("rejects a ledger file that does not match the schema", async () => {
    const dir = await makeTempDir();
    await addTasks(dir, [{ id: "A", title: "A" }]);
    await expect(
      updateLedger(dir, (ledger) => {
        // @ts-expect-error deliberately invalid status
        ledger.tasks[0].status = "exploded";
      }),
    ).rejects.toThrow();
    expect((await readLedger(dir)).tasks[0]?.status).toBe("ready");
  });
});

describe("run phase transitions", () => {
  it("allows the documented transitions and rejects the rest", () => {
    const run = buildRun({ phase: "running", status: "running" });
    transitionRunPhase(run, "waiting-quota");
    transitionRunPhase(run, "running");
    transitionRunPhase(run, "done");
    expect(run.phase).toBe("done");
    expect(() => transitionRunPhase(run, "running")).toThrow(
      /Invalid run phase transition/,
    );
    expect(runPhaseTransitions.done).toEqual([]);
    expect(runPhaseTransitions.failed).toEqual([]);
  });
});
