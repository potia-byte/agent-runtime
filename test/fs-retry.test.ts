import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTextRetry,
  removeRetry,
  withTransientRetry,
} from "../src/fs-retry.js";
import { cleanupTempDirs, makeTempDir } from "./support.js";

afterEach(cleanupTempDirs);

function codeError(code: string): Error {
  const error = new Error(`${code}: simulated`);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

describe("withTransientRetry", () => {
  it("retries transient codes with the configured delays, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw codeError("EPERM");
        return "ok";
      },
      {
        retryDelaysMs: [1, 2, 3],
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(result).toBe("ok");
    expect(delays).toEqual([1, 2]);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls += 1;
          throw codeError("ENOENT");
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls += 1;
          throw codeError("EBUSY");
        },
        { retryDelaysMs: [1, 1], sleep: async () => undefined },
      ),
    ).rejects.toThrow("EBUSY");
    expect(calls).toBe(3);
  });
});

describe("readTextRetry / removeRetry", () => {
  it("reads an existing file and rejects ENOENT without retrying forever", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "a.txt");
    await writeFile(file, "hello");
    expect(await readTextRetry(file)).toBe("hello");
    await expect(readTextRetry(join(dir, "missing.txt"))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("removes a directory tree and tolerates a missing path", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "x");
    await removeRetry(dir);
    await removeRetry(dir);
  });
});
