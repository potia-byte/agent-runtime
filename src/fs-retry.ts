import { readFile, rm } from "node:fs/promises";
import {
  DEFAULT_RETRY_DELAYS_MS,
  defaultSleep,
  isTransientRenameError,
} from "./atomic-file.js";

/**
 * Bounded retries for ordinary filesystem operations that hit the same
 * transient Windows contention codes (EPERM / EBUSY / EACCES) as an atomic
 * rename: a reader polling a file while a writer replaces it, an antivirus
 * scanner holding a handle on a freshly created temp directory, or a
 * recursive delete racing a just-closed file.
 */

export interface RetryOptions {
  /** Delay before each retry, in order. Defaults to DEFAULT_RETRY_DELAYS_MS. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  isTransient?: (error: unknown) => boolean;
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const isTransient = options.isTransient ?? isTransientRenameError;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isTransient(error)) throw error;
      await sleep(delay);
    }
  }
}

/** readFile(utf8) that survives a concurrent atomic replace of the file. */
export function readTextRetry(
  path: string,
  options: RetryOptions = {},
): Promise<string> {
  return withTransientRetry(() => readFile(path, "utf8"), options);
}

/**
 * Recursive, forced removal that retries transient errors. Never throws for
 * a missing path (force). Throws the last error if contention outlasts the
 * retry budget, so callers can decide whether that is fatal.
 */
export function removeRetry(
  path: string,
  options: RetryOptions = {},
): Promise<void> {
  return withTransientRetry(
    () => rm(path, { recursive: true, force: true }),
    options,
  );
}
