import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitDurableWorker,
  durableWorkerAlive,
  durableWorkerDir,
  durableWorkerPaths,
  launchDurableWorker,
  readDurableChildPid,
  releaseDurableWorker,
  removeDurableWorkerJob,
} from "../src/durable-worker.js";
import { addTasks, claimTask, readLedger } from "../src/ledger.js";
import { isProcessAlive } from "../src/process.js";
import { recoverOrchestratorRestart } from "../src/runtime-health.js";
import { readRuntimeState } from "../src/runtime-state.js";
import { cleanupTempDirs, makeTempDir } from "./support.js";

const FIXTURES = resolve(fileURLToPath(new URL("./fixtures/", import.meta.url)));
const FAKE_WORKER = join(FIXTURES, "fake-worker.mjs");
const SIM = join(FIXTURES, "orchestrator-sim.mts");
const spawnedPids: number[] = [];

function killQuietly(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) killQuietly(pid);
  await cleanupTempDirs();
});

/**
 * A .cmd / shell wrapper around the fake worker, so the Windows `.cmd` shim
 * path (cmd.exe /d /s /c with escaped tokens) is exercised too.
 */
function wrapperFor(directory: string): string {
  if (process.platform === "win32") {
    const wrapper = join(directory, "fake-worker.cmd");
    writeFileSync(wrapper, `@"${process.execPath}" "${FAKE_WORKER}" %*\r\n`);
    return wrapper;
  }
  const wrapper = join(directory, "fake-worker.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WORKER}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function until<T>(
  probe: () => T | Promise<T>,
  timeoutMs = 30_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("Timed out waiting for state.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function launchCount(log: string): number {
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).length
    : 0;
}

async function planTwoTasks(dir: string) {
  await addTasks(dir, [
    { id: "TASK-A", title: "TASK-A" },
    { id: "TASK-B", title: "TASK-B" },
  ]);
  const runA = await claimTask(dir, "TASK-A", "sim-worker");
  const runB = await claimTask(dir, "TASK-B", "sim-worker");
  return { runA, runB };
}

function startOrchestrator(
  dir: string,
  runA: string,
  runB: string,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", SIM, dir, runA, runB, FAKE_WORKER],
    { cwd: resolve(FIXTURES, "..", ".."), env, stdio: "ignore", windowsHide: true },
  );
  if (child.pid) spawnedPids.push(child.pid);
  return child;
}

describe("durable detached workers", () => {
  it("keeps the worker unstarted until released, then records a durable result", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const cwd = join(dir, "work");
    mkdirSync(cwd);
    const launched = await launchDurableWorker({
      stateDir: dir,
      runId: "run-unit",
      slotId: "A",
      command: wrapperFor(dir),
      input: "hello",
      cwd,
      timeoutMs: 30_000,
      env: { ...process.env, FAKE_LOG: log, FAKE_DELAY_MS: "0" },
    });
    spawnedPids.push(launched.pid);
    const paths = durableWorkerPaths(launched.jobDir);

    expect(launched.jobDir).toBe(durableWorkerDir(dir, "run-unit", "A"));
    expect(durableWorkerAlive(launched.jobDir, launched.pid)).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    // Gated: no worker process exists before the caller persisted the pid.
    expect(launchCount(log)).toBe(0);
    expect(existsSync(paths.child)).toBe(false);

    releaseDurableWorker(launched.jobDir);
    const outcome = await awaitDurableWorker({
      jobDir: launched.jobDir,
      pid: launched.pid,
    });
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw new Error("unreachable");
    expect(outcome.result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    expect(outcome.result.stdout).toContain("worker finished; input=hello");
    expect(existsSync(join(cwd, "worker-output.txt"))).toBe(true);
    expect(launchCount(log)).toBe(1);
    expect(await readDurableChildPid(launched.jobDir)).not.toBeNull();
    // The result stays readable after the runner exited.
    await until(() => !isProcessAlive(launched.pid));
    expect(existsSync(paths.result)).toBe(true);
  }, 60_000);

  it("workers survive the orchestrator being killed, are re-attached without reclaim or duplicate launch, and their results reconcile", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const { runA, runB } = await planTwoTasks(dir);
    const orchestrator = startOrchestrator(dir, runA.id, runB.id, {
      ...process.env,
      FAKE_LOG: log,
      FAKE_DELAY_MS: "6000",
    });

    // Both real workers running, pids durably persisted.
    const running = await until(async () => {
      const runtime = await readRuntimeState(dir).catch(() => null);
      return runtime &&
        runtime.slots.length === 2 &&
        runtime.slots.every(
          (slot) => slot.status === "running" && slot.pid !== null,
        ) &&
        launchCount(log) === 2
        ? runtime
        : null;
    }, 45_000);
    const runnerPids = running.slots.map((slot) => slot.pid as number);
    for (const pid of runnerPids) spawnedPids.push(pid);
    expect(new Set(runnerPids).size).toBe(2);
    for (const slot of running.slots) {
      expect(durableWorkerAlive(slot.job_dir, slot.pid)).toBe(true);
    }

    // Kill ONLY the orchestrator. No shutdown hook runs.
    process.kill(orchestrator.pid as number, "SIGKILL");
    await until(() => !isProcessAlive(orchestrator.pid as number));

    // Workers are still alive and still the same processes.
    for (const slot of running.slots) {
      expect(isProcessAlive(slot.pid as number)).toBe(true);
      expect(durableWorkerAlive(slot.job_dir, slot.pid)).toBe(true);
    }

    // Restart recovery recognises them: nothing reclaimed, nothing removed.
    const removed: string[] = [];
    const recovered = await recoverOrchestratorRestart({
      stateDir: dir,
      removeWorkspace: (path) => {
        removed.push(path);
      },
    });
    expect(removed).toEqual([]);
    expect(recovered.crashedSlots).toEqual([]);
    expect(recovered.recoveredTaskIds).toEqual([]);
    expect(recovered.liveSlotIds.sort()).toEqual(["A", "B"]);
    const afterRecovery = await readRuntimeState(dir);
    expect(afterRecovery.slots.map((slot) => slot.pid)).toEqual(runnerPids);
    const ledger = await readLedger(dir);
    expect(ledger.tasks.map((task) => task.active_run_id).sort()).toEqual(
      [runA.id, runB.id].sort(),
    );

    // Re-attach: wait on the SAME workers and read their results.
    for (const slot of afterRecovery.slots) {
      const outcome = await awaitDurableWorker({
        jobDir: slot.job_dir as string,
        pid: slot.pid,
      });
      expect(outcome.kind).toBe("result");
      if (outcome.kind !== "result") throw new Error("unreachable");
      expect(outcome.result.exitCode).toBe(0);
      expect(outcome.result.stdout).toContain("worker finished");
      expect(
        existsSync(join(dir, slot.workspace_path, "worker-output.txt")),
      ).toBe(true);
      await removeDurableWorkerJob(slot.job_dir);
    }
    // No duplicate launch across the restart.
    expect(launchCount(log)).toBe(2);
    for (const slot of running.slots) {
      expect(slot.job_dir && existsSync(slot.job_dir)).toBe(false);
      await until(() => !isProcessAlive(slot.pid as number));
    }
  }, 120_000);

  it("a worker that finished while no orchestrator was alive keeps its result and is never reclaimed as a crash", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const { runA, runB } = await planTwoTasks(dir);
    const orchestrator = startOrchestrator(dir, runA.id, runB.id, {
      ...process.env,
      FAKE_LOG: log,
      FAKE_DELAY_MS: "0",
    });
    await until(async () => {
      const runtime = await readRuntimeState(dir).catch(() => null);
      return runtime &&
        runtime.slots.length === 2 &&
        runtime.slots.every((slot) => slot.pid !== null)
        ? runtime
        : null;
    }, 45_000);
    process.kill(orchestrator.pid as number, "SIGKILL");
    const persisted = await readRuntimeState(dir);
    for (const slot of persisted.slots) {
      await until(() => !isProcessAlive(slot.pid as number), 30_000);
    }
    // Worker is done and dead; runner is dead; result.json remains.
    for (const slot of persisted.slots) {
      expect(
        existsSync(durableWorkerPaths(slot.job_dir as string).result),
      ).toBe(true);
    }

    const removed: string[] = [];
    const recovered = await recoverOrchestratorRestart({
      stateDir: dir,
      heartbeatIntervalMs: 1,
      removeWorkspace: (path) => {
        removed.push(path);
      },
    });
    expect(removed).toEqual([]);
    expect(recovered.crashedSlots).toEqual([]);
    expect(recovered.runtime.slots).toHaveLength(2);

    for (const slot of recovered.runtime.slots) {
      const outcome = await awaitDurableWorker({
        jobDir: slot.job_dir as string,
        pid: slot.pid,
      });
      expect(outcome.kind).toBe("result");
      if (outcome.kind !== "result") throw new Error("unreachable");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(launchCount(log)).toBe(2);
  }, 120_000);

  it("a worker that genuinely dies without a result is not re-attached and is reclaimed", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const { runA, runB } = await planTwoTasks(dir);
    const orchestrator = startOrchestrator(dir, runA.id, runB.id, {
      ...process.env,
      FAKE_LOG: log,
      FAKE_DELAY_MS: "30000",
    });
    const running = await until(async () => {
      const runtime = await readRuntimeState(dir).catch(() => null);
      return runtime &&
        runtime.slots.length === 2 &&
        runtime.slots.every((slot) => slot.status === "running") &&
        launchCount(log) === 2
        ? runtime
        : null;
    }, 45_000);
    process.kill(orchestrator.pid as number, "SIGKILL");

    // Slot B's worker really dies (runner + worker tree); slot A stays healthy.
    const [slotA, slotB] = running.slots;
    if (!slotA || !slotB) throw new Error("expected two slots");
    spawnedPids.push(slotA.pid as number);
    killQuietly(slotB.pid as number);
    await until(() => !isProcessAlive(slotB.pid as number));

    const removed: string[] = [];
    const recovered = await recoverOrchestratorRestart({
      stateDir: dir,
      heartbeatIntervalMs: 1,
      removeWorkspace: (path) => {
        removed.push(path);
      },
    });
    // The dead worker is reclaimed and its task released; the healthy one
    // is untouched.
    expect(recovered.crashedSlots.map((slot) => slot.slot_id)).toEqual(["B"]);
    expect(recovered.freedSlotIds).toEqual(["B"]);
    expect(recovered.recoveredTaskIds).toEqual(["TASK-B"]);
    expect(removed).toEqual([slotB.workspace_path]);
    expect(existsSync(slotB.job_dir as string)).toBe(false);
    expect(recovered.runtime.slots.map((slot) => slot.slot_id)).toEqual(["A"]);
    expect(isProcessAlive(slotA.pid as number)).toBe(true);
    expect(existsSync(slotA.job_dir as string)).toBe(true);
    const ledger = await readLedger(dir);
    expect(
      ledger.tasks.find((task) => task.id === "TASK-A")?.active_run_id,
    ).toBe(runA.id);
    expect(ledger.tasks.find((task) => task.id === "TASK-B")?.status).toBe(
      "ready",
    );

    // Waiting on a runner that is gone and left no result is a crash, not a
    // result.
    const outcome = await awaitDurableWorker({
      jobDir: slotB.job_dir as string,
      pid: slotB.pid,
    });
    expect(outcome.kind).toBe("vanished");
    killQuietly(slotA.pid as number);
  }, 120_000);

  it("a normal run leaves no orphan process or job directory", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const pids: number[] = [];
    const launched = [];
    for (const slotId of ["A", "B"]) {
      const cwd = join(dir, "workspaces", `cycle-${slotId}`);
      mkdirSync(cwd, { recursive: true });
      const worker = await launchDurableWorker({
        stateDir: dir,
        runId: "run-normal",
        slotId,
        command: process.execPath,
        args: [FAKE_WORKER],
        input: slotId,
        cwd,
        timeoutMs: 60_000,
        env: { ...process.env, FAKE_LOG: log, FAKE_DELAY_MS: "300" },
      });
      spawnedPids.push(worker.pid);
      pids.push(worker.pid);
      launched.push(worker);
      releaseDurableWorker(worker.jobDir);
    }
    for (const worker of launched) {
      const outcome = await awaitDurableWorker({
        jobDir: worker.jobDir,
        pid: worker.pid,
      });
      expect(outcome.kind).toBe("result");
      if (outcome.kind === "result") expect(outcome.result.exitCode).toBe(0);
      await removeDurableWorkerJob(worker.jobDir);
    }
    expect(new Set(pids).size).toBe(2);
    for (const pid of pids) await until(() => !isProcessAlive(pid));
    for (const slotId of ["A", "B"]) {
      expect(
        existsSync(durableWorkerDir(dir, "run-normal", slotId)),
      ).toBe(false);
    }
    expect(launchCount(log)).toBe(2);
  }, 60_000);

  it("uses the timeout to stop a runaway detached worker and records it as timed out", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const cwd = join(dir, "work");
    mkdirSync(cwd);
    const launched = await launchDurableWorker({
      stateDir: dir,
      runId: "run-timeout",
      slotId: "B",
      command: process.execPath,
      args: [FAKE_WORKER],
      cwd,
      timeoutMs: 1_500,
      env: { ...process.env, FAKE_LOG: log, FAKE_DELAY_MS: "60000" },
    });
    spawnedPids.push(launched.pid);
    releaseDurableWorker(launched.jobDir);
    const outcome = await awaitDurableWorker({
      jobDir: launched.jobDir,
      pid: launched.pid,
    });
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw new Error("unreachable");
    expect(outcome.result.timedOut).toBe(true);
    await until(() => !isProcessAlive(launched.pid));
  }, 60_000);

  it("an aborted wait cancels the worker gracefully and still yields a result", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "launches.log");
    const cwd = join(dir, "work");
    mkdirSync(cwd);
    const launched = await launchDurableWorker({
      stateDir: dir,
      runId: "run-cancel",
      slotId: "C",
      command: process.execPath,
      args: [FAKE_WORKER],
      cwd,
      timeoutMs: 60_000,
      env: { ...process.env, FAKE_LOG: log, FAKE_DELAY_MS: "60000" },
    });
    spawnedPids.push(launched.pid);
    releaseDurableWorker(launched.jobDir);
    await until(() => launchCount(log) === 1);

    const controller = new AbortController();
    const waiting = awaitDurableWorker({
      jobDir: launched.jobDir,
      pid: launched.pid,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await waiting;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw new Error("unreachable");
    expect(outcome.result.aborted).toBe(true);
    expect(outcome.result.timedOut).toBe(false);
  }, 60_000);
});
