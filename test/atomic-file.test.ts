import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rename as realRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AtomicWriteError,
  atomicWriteFile,
  cleanupStaleAtomicTempFiles,
} from "../src/atomic-file.js";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-runtime-atomic-test-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Wraps the real rename, throwing `code` for the first `failCount` calls. */
function flakyRename(
  failCount: number,
  code: string,
): { rename: typeof realRename; calls: number } {
  const state = {
    calls: 0,
    rename: (async (...args: Parameters<typeof realRename>) => {
      state.calls += 1;
      if (state.calls <= failCount) {
        const error = new Error(`${code}: simulated transient rename failure`);
        (error as NodeJS.ErrnoException).code = code;
        throw error;
      }
      return realRename(...args);
    }) as typeof realRename,
  };
  return state;
}

function instantSleepTracker(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("atomicWriteFile", () => {
  it("A: normal atomic write succeeds", async () => {
    const dir = tempDir();
    const target = join(dir, "state.json");
    await atomicWriteFile(target, '{"ok":true}');
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ ok: true });
  });

  it("B: rename returns EPERM once, then succeeds -- final JSON is correct", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");
    const flaky = flakyRename(1, "EPERM");
    const { sleep, delays } = instantSleepTracker();

    await atomicWriteFile(target, '{"attempt":1}', {
      fsOps: { rename: flaky.rename },
      sleep,
    });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ attempt: 1 });
    expect(delays).toHaveLength(1);
    expect(flaky.calls).toBe(2);
  });

  it("C: rename returns EPERM multiple times, then succeeds -- bounded retries, correct final state", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");
    const flaky = flakyRename(4, "EPERM");
    const { sleep, delays } = instantSleepTracker();

    await atomicWriteFile(target, '{"attempt":"many"}', {
      fsOps: { rename: flaky.rename },
      sleep,
      retryDelaysMs: [1, 2, 3, 4, 5, 6],
      random: () => 0,
    });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      attempt: "many",
    });
    // 4 failures -> 4 retry sleeps, using the first 4 configured delays.
    expect(delays).toEqual([1, 2, 3, 4]);
    expect(flaky.calls).toBe(5);
  });

  it("D: EBUSY behaves as transient", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");
    const flaky = flakyRename(1, "EBUSY");
    const { sleep } = instantSleepTracker();

    await atomicWriteFile(target, '{"code":"EBUSY"}', {
      fsOps: { rename: flaky.rename },
      sleep,
    });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      code: "EBUSY",
    });
  });

  it("E: EACCES behaves as transient", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");
    const flaky = flakyRename(1, "EACCES");
    const { sleep } = instantSleepTracker();

    await atomicWriteFile(target, '{"code":"EACCES"}', {
      fsOps: { rename: flaky.rename },
      sleep,
    });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      code: "EACCES",
    });
  });

  it("F: retry budget exhausted -- old canonical file untouched, no partial JSON, typed failure", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");
    // Establish a valid canonical file first.
    await atomicWriteFile(target, '{"version":1}');
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ version: 1 });

    const flaky = flakyRename(Number.POSITIVE_INFINITY, "EPERM");
    const { sleep, delays } = instantSleepTracker();

    await expect(
      atomicWriteFile(target, '{"version":2, "corrupt', {
        fsOps: { rename: flaky.rename },
        sleep,
        retryDelaysMs: [1, 1, 1],
      }),
    ).rejects.toThrow(AtomicWriteError);

    // Old canonical content is exactly preserved -- never partially
    // overwritten, never deleted to "make room" for the rename.
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ version: 1 });
    // Retries were bounded to the configured budget (3 delays -> 3 sleeps).
    expect(delays).toHaveLength(3);

    // The leftover temp file is retained as diagnostic evidence, not
    // silently discarded.
    const entries = await readdir(dir);
    const leftoverTemp = entries.find(
      (name) => name.startsWith("runtime.json.") && name.endsWith(".tmp"),
    );
    expect(leftoverTemp).toBeDefined();
  });

  it("F2: a non-transient rename error fails immediately without retrying", async () => {
    const dir = tempDir();
    const target = join(dir, "state.json");
    const flaky = flakyRename(Number.POSITIVE_INFINITY, "ENOSPC");
    const { sleep, delays } = instantSleepTracker();

    await expect(
      atomicWriteFile(target, "{}", {
        fsOps: { rename: flaky.rename },
        sleep,
      }),
    ).rejects.toThrow(AtomicWriteError);
    expect(delays).toHaveLength(0);
    expect(flaky.calls).toBe(1);
  });

  it("G: concurrent writes to the same path cannot corrupt the canonical JSON", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        atomicWriteFile(target, JSON.stringify({ writer: index })),
      ),
    );

    // Whichever writer landed last, the file is intact, complete JSON.
    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      writer: number;
    };
    expect(typeof parsed.writer).toBe("number");
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(8);
  });
});

describe("cleanupStaleAtomicTempFiles", () => {
  it("H: removes only eligible stale temp files, matching the exact naming convention", async () => {
    const dir = tempDir();
    const target = join(dir, "runtime.json");
    const now = 10_000_000;

    // Eligible: old enough, regardless of pid liveness.
    writeFileSync(join(dir, "runtime.json.111.1000.tmp"), "old");
    // Eligible: young, but owning pid is dead (crashed writer).
    writeFileSync(join(dir, "runtime.json.222.9999900.tmp"), "dead-pid");
    // NOT eligible: young and owning pid alive -- may be an active write.
    writeFileSync(join(dir, "runtime.json.333.9999950.tmp"), "active");
    // NOT eligible: doesn't match this canonical file's naming convention.
    writeFileSync(join(dir, "unrelated.txt.444.1000.tmp"), "unrelated");
    writeFileSync(join(dir, "runtime.json.notanumber.tmp"), "malformed");
    // NOT eligible: a real sibling canonical file, not a temp file.
    writeFileSync(join(dir, "state.json"), "{}");

    const removed = await cleanupStaleAtomicTempFiles(target, {
      now: () => now,
      minAgeMs: 60_000,
      isProcessAlive: (pid) => pid === 333,
    });

    expect(removed.sort()).toEqual(
      ["runtime.json.111.1000.tmp", "runtime.json.222.9999900.tmp"].sort(),
    );
    const remaining = await readdir(dir);
    expect(remaining).toContain("runtime.json.333.9999950.tmp");
    expect(remaining).toContain("unrelated.txt.444.1000.tmp");
    expect(remaining).toContain("runtime.json.notanumber.tmp");
    expect(remaining).toContain("state.json");
    expect(remaining).not.toContain("runtime.json.111.1000.tmp");
    expect(remaining).not.toContain("runtime.json.222.9999900.tmp");
  });

  it("returns an empty list when the directory does not exist", async () => {
    const dir = tempDir();
    const removed = await cleanupStaleAtomicTempFiles(
      join(dir, "does-not-exist", "runtime.json"),
    );
    expect(removed).toEqual([]);
  });
});
