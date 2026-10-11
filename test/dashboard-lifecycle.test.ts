import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile } from "../src/atomic-file.js";
import {
  LifecycleError,
  startRuntime,
  stopRuntime,
} from "../src/dashboard/lifecycle.js";
import { readRuntimeState, writeRuntimeState } from "../src/runtime-state.js";
import { cleanupTempDirs, createFixtureDir } from "./support.js";

/**
 * Why this file exists in its present shape (root cause of the Windows
 * failure of the original `lifecycle.test.ts`):
 *
 * On Windows, `rename()` onto a file that another handle currently has open
 * fails with EPERM -- and `startRuntime` polls `runtime.json` while the
 * simulated runtime replaces it. The original helper did a bare
 * `writeFile` + `rename` in a fire-and-forget (`void`) call, so
 *   1. the first EPERM was an *unhandled rejection* (vitest fails the run),
 *   2. the pid was never written, so the poll loop timed out as well, and
 *   3. nothing awaited the background write before the temp directory was
 *      deleted, so a late write could land in (or fail against) a removed
 *      directory.
 *
 * Fixed here by (1) writing through the production atomic writer, which
 * retries transient EPERM/EBUSY/EACCES with backoff, (2) tracking every
 * background write and awaiting it before cleanup, asserting none failed,
 * and (3) removing the temp directory with retries (see support.ts).
 */

/** A patient budget: ~12s of retries, far above one poll interval. */
const PATIENT_RETRY_DELAYS_MS = [
  20, 50, 100, 200, 400, 800, 1_000, 1_000, 2_000, 2_000, 3_000,
];
const FAST_POLL = { pollIntervalMs: 20, pollAttempts: 150 };
const START = { command: "run-runtime", args: ["--flag"] };

const pendingWrites: Promise<unknown>[] = [];
const backgroundErrors: unknown[] = [];

/** Simulates the real runtime recording its own pid shortly after spawn. */
function markRuntimeAliveInBackground(dir: string, pid: number): void {
  const write = (async () => {
    const current = await readRuntimeState(dir);
    await writeRuntimeState(
      dir,
      { ...current, status: "running", pid },
      { retryDelaysMs: PATIENT_RETRY_DELAYS_MS },
    );
  })().catch((error: unknown) => {
    backgroundErrors.push(error);
  });
  pendingWrites.push(write);
}

afterEach(async () => {
  // Wait for every background write BEFORE the directory is removed.
  await Promise.allSettled(pendingWrites.splice(0));
  const errors = backgroundErrors.splice(0);
  await cleanupTempDirs();
  expect(errors).toEqual([]);
});

describe("startRuntime", () => {
  it("refuses to start when the recorded pid is already alive", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "running", pid: process.pid },
    });
    const spawn = vi.fn();
    await expect(
      startRuntime(dir, { startCommand: START, spawn: spawn as never }),
    ).rejects.toThrow(LifecycleError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to start when no start command is configured", async () => {
    const dir = await createFixtureDir();
    const spawn = vi.fn();
    await expect(
      startRuntime(dir, { spawn: spawn as never }),
    ).rejects.toThrow(/No start command configured/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the configured command and resolves once the runtime state reports a live pid", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    const fakeChild = { pid: 4242, unref: vi.fn() };
    const spawn = vi.fn().mockImplementation(() => {
      markRuntimeAliveInBackground(dir, process.pid);
      return fakeChild;
    });
    const result = await startRuntime(dir, {
      startCommand: START,
      spawn: spawn as never,
      ...FAST_POLL,
    });
    expect(spawn).toHaveBeenCalledWith(
      "run-runtime",
      ["--flag"],
      expect.objectContaining({ detached: true }),
    );
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, pid: 4242 });
  });

  it("throws with the log tail when the process never reports as running", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    // The pid is never written -- simulates a real startup failure (e.g. the
    // runtime lock being held by another process).
    const spawn = vi.fn().mockReturnValue({ pid: 4242, unref: vi.fn() });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "dashboard.log"),
      "starting runtime...\nfatal: lock already held\n",
      "utf8",
    );

    let caught: unknown;
    try {
      await startRuntime(dir, {
        startCommand: START,
        spawn: spawn as never,
        pollIntervalMs: 5,
        pollAttempts: 3,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LifecycleError);
    expect((caught as Error).message).toMatch(/fatal: lock already held/);
  });
});

describe("stopRuntime", () => {
  it("throws a clear error when nothing is running", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    await expect(stopRuntime(dir)).rejects.toThrow(/not running/i);
  });

  it("sends SIGTERM to the pid recorded in the runtime state", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "running", pid: process.pid },
    });
    const kill = vi.fn();
    const result = await stopRuntime(dir, { kill });
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(result).toEqual({ ok: true, pid: process.pid });
  });
});

describe("state file replacement while a reader polls (Windows rename race)", () => {
  it("keeps every atomic write intact while another task polls the same file", async () => {
    const dir = await createFixtureDir();
    const path = join(dir, "runtime.json");
    let stop = false;
    const readErrors: unknown[] = [];
    const reader = (async () => {
      while (!stop) {
        try {
          await readRuntimeState(dir);
        } catch (error) {
          readErrors.push(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();

    for (let writer = 0; writer < 15; writer += 1) {
      await atomicWriteFile(
        path,
        JSON.stringify({ schema_version: 1, status: "running", pid: writer }),
        { retryDelaysMs: PATIENT_RETRY_DELAYS_MS },
      );
    }
    stop = true;
    await reader;

    expect(readErrors).toEqual([]);
    expect((await readRuntimeState(dir)).pid).toBe(14);
  });
});
