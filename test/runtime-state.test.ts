import { mkdir, readdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRuntimeLock,
  appendRuntimeLog,
  initialRuntimeState,
  readRuntimeLogTail,
  readRuntimeState,
  runtimePaths,
  workerSlotsSchema,
  writeRuntimeState,
} from "../src/runtime-state.js";
import { buildSlot, cleanupTempDirs, makeTempDir } from "./support.js";

afterEach(cleanupTempDirs);

describe("runtime state file", () => {
  it("reads a missing file as an idle state", async () => {
    const dir = await makeTempDir();
    const state = await readRuntimeState(dir);
    expect(state).toMatchObject({ status: "idle", pid: null, slots: [] });
  });

  it("round-trips a written state and fills documented defaults", async () => {
    const dir = await makeTempDir();
    const slot = buildSlot();
    await writeRuntimeState(dir, {
      ...initialRuntimeState(),
      status: "running",
      pid: 1234,
      slots: [slot],
    });
    const state = await readRuntimeState(dir);
    expect(state.status).toBe("running");
    expect(state.pid).toBe(1234);
    expect(state.slots).toEqual([slot]);

    // A minimal hand-written file is valid: everything else defaults.
    await writeFile(
      runtimePaths(dir).runtime,
      JSON.stringify({ status: "running", pid: 7 }),
    );
    const minimal = await readRuntimeState(dir);
    expect(minimal).toMatchObject({
      schema_version: 1,
      pid: 7,
      in_flight: [],
      slots: [],
      cooldowns: [],
      history: [],
    });
  });

  it("rejects a malformed file instead of guessing", async () => {
    const dir = await makeTempDir();
    await writeFile(
      runtimePaths(dir).runtime,
      JSON.stringify({ status: "exploded" }),
    );
    await expect(readRuntimeState(dir)).rejects.toThrow();
  });

  it("rejects ambiguous slot ownership on write and leaves the old file untouched", async () => {
    const dir = await makeTempDir();
    await writeRuntimeState(dir, initialRuntimeState());
    const duplicate = [
      buildSlot({ slot_id: "A" }),
      buildSlot({ slot_id: "B" }),
    ];
    await expect(
      writeRuntimeState(dir, { ...initialRuntimeState(), slots: duplicate }),
    ).rejects.toThrow(/Duplicate worker/);
    expect((await readRuntimeState(dir)).slots).toEqual([]);
  });

  it("flags duplicate slot, workspace, task and run ids", () => {
    const base = buildSlot({ slot_id: "A" });
    const cases = [
      { ...base, workspace_path: "w/b", task_id: "t2", run_id: "r2" },
      { ...base, slot_id: "B", task_id: "t2", run_id: "r2" },
      { ...base, slot_id: "B", workspace_path: "w/b", run_id: "r2" },
      { ...base, slot_id: "B", workspace_path: "w/b", task_id: "t2" },
    ];
    for (const other of cases) {
      expect(workerSlotsSchema.safeParse([base, other]).success).toBe(false);
    }
    expect(
      workerSlotsSchema.safeParse([
        base,
        { ...base, slot_id: "B", workspace_path: "w/b", task_id: "t2", run_id: "r2" },
      ]).success,
    ).toBe(true);
  });

  it("keeps only the newest 200 history entries", async () => {
    const dir = await makeTempDir();
    const history = Array.from({ length: 250 }, (_, index) => ({
      at: `2026-01-15T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: `m${index}`,
    }));
    await writeRuntimeState(dir, { ...initialRuntimeState(), history });
    const state = await readRuntimeState(dir);
    expect(state.history).toHaveLength(200);
    expect(state.history[0]?.message).toBe("m50");
    expect(state.history.at(-1)?.message).toBe("m249");
  });

  it("leaves no temp files behind after a write", async () => {
    const dir = await makeTempDir();
    await writeRuntimeState(dir, initialRuntimeState());
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("runtime log", () => {
  it("appends lines and returns the tail", async () => {
    const dir = await makeTempDir();
    expect(await readRuntimeLogTail(dir)).toEqual([]);
    for (const message of ["one", "two", "three"]) {
      await appendRuntimeLog(dir, message);
    }
    const tail = await readRuntimeLogTail(dir, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0]).toMatch(/two$/);
    expect(tail[1]).toMatch(/three$/);
  });
});

describe("runtime lock", () => {
  it("refuses a second holder while the first process is alive", async () => {
    const dir = await makeTempDir();
    const release = await acquireRuntimeLock(dir);
    await expect(acquireRuntimeLock(dir)).rejects.toThrow(/already running/);
    await release();
    const again = await acquireRuntimeLock(dir);
    await again();
  });

  it("replaces a lock whose recorded pid is dead", async () => {
    const dir = await makeTempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(runtimePaths(dir).lock, "4000000\n2026-01-01T00:00:00Z\n");
    const release = await acquireRuntimeLock(dir);
    await release();
  });

  it("refuses a lock file that holds no pid", async () => {
    const dir = await makeTempDir();
    await writeFile(runtimePaths(dir).lock, "garbage\n");
    await expect(acquireRuntimeLock(dir)).rejects.toThrow(/inconsistency/);
  });

  it("refuses when the lock pid disagrees with the pid in runtime.json", async () => {
    const dir = await makeTempDir();
    await writeFile(runtimePaths(dir).lock, `${process.pid}\n`);
    await writeFile(
      runtimePaths(dir).runtime,
      JSON.stringify({ status: "running", pid: process.pid + 1 }),
    );
    await expect(acquireRuntimeLock(dir)).rejects.toThrow(/does not match/);
  });
});
