import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readTextRetry, removeRetry } from "./fs-retry.js";
import { isProcessAlive, resolveSpawnInvocation } from "./process.js";

/**
 * Restart-safe worker transport.
 *
 * A worker CLI launched as a plain child of the orchestrator dies with it:
 * its stdout/stderr pipes close and, on Windows, nothing keeps it alive once
 * the parent is gone. This module gives a worker an independent lifetime by
 * launching a small *detached runner* that owns the worker process and
 * hands everything the orchestrator needs to a durable job directory:
 *
 *   job.json        launch contract (command, args, timeout, ...)
 *   input.txt       worker stdin
 *   stdout.log / stderr.log   worker output (files, not pipes)
 *   heartbeat       touched by the runner once a second -- process identity
 *   go              written by the orchestrator only AFTER the runner pid is
 *                   durably persisted; the runner will not start the worker
 *                   before it exists (no un-tracked worker process)
 *   cancel          asks the runner to stop the worker (graceful shutdown)
 *   result.json     written atomically by the runner when the worker exits
 *
 * A restarted orchestrator re-derives everything from that directory plus the
 * persisted slot record: it never needs the original process handles.
 */

export interface DurableWorkerPaths {
  dir: string;
  job: string;
  runner: string;
  input: string;
  stdout: string;
  stderr: string;
  result: string;
  heartbeat: string;
  child: string;
  go: string;
  cancel: string;
}

/** Runner heartbeat freshness required to trust a live-looking pid. */
export const DURABLE_HEARTBEAT_STALE_MS = 20_000;
/** A just-launched runner has not written its first heartbeat yet. */
const DURABLE_STARTUP_GRACE_MS = 60_000;

/** Job directory of one worker, inside the runtime state directory. */
export function durableWorkerDir(
  stateDir: string,
  runId: string,
  slotId: string,
): string {
  return resolve(stateDir, "workers", `${runId}-${slotId}`);
}

export function durableWorkerPaths(dir: string): DurableWorkerPaths {
  return {
    dir,
    job: join(dir, "job.json"),
    runner: join(dir, "runner.mjs"),
    input: join(dir, "input.txt"),
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
    result: join(dir, "result.json"),
    heartbeat: join(dir, "heartbeat"),
    child: join(dir, "child.json"),
    go: join(dir, "go"),
    cancel: join(dir, "cancel"),
  };
}

interface DurableJob {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  cwd: string;
  timeout_ms: number;
  kill_grace_ms: number;
  go_timeout_ms: number;
  command: string;
  launched_at: string;
}

interface DurableResultFile {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  aborted: boolean;
  spawn_error: {
    code: string | undefined;
    message: string;
    command: string;
  } | null;
  finished_at: string;
}

/**
 * The detached runner. Plain ESM with no imports beyond node builtins, so it
 * runs identically from source (tsx), compiled dist, or a test process --
 * it is written to the job directory at launch and executed with the same
 * node binary. Kept deliberately tiny: launch the worker with file-backed
 * stdio, enforce the timeout/cancel, and record the outcome.
 */
const WORKER_RUNNER_SOURCE = `import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const file = (name) => join(dir, name);
const job = JSON.parse(readFileSync(file("job.json"), "utf8"));
const beat = () => {
  try { writeFileSync(file("heartbeat"), String(Date.now())); } catch {}
};
beat();
const heartbeat = setInterval(beat, 1000);

function writeResult(result) {
  const temporary = file("result.json.tmp");
  writeFileSync(temporary, JSON.stringify({ ...result, finished_at: new Date().toISOString() }));
  // On Windows the orchestrator polling result.json can hold it open for a
  // moment, which makes the rename fail with EPERM/EBUSY: retry briefly.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, file("result.json"));
      break;
    } catch (error) {
      if (attempt >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  clearInterval(heartbeat);
  process.exit(0);
}

function killTree(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
      setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, job.kill_grace_ms).unref();
    }
  } catch {}
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const base = { exit_code: null, signal: null, timed_out: false, aborted: false, spawn_error: null };

const goDeadline = Date.now() + job.go_timeout_ms;
while (!existsSync(file("go"))) {
  if (existsSync(file("cancel")) || Date.now() > goDeadline) {
    writeResult({ ...base, aborted: true });
  }
  await sleep(100);
}

const stdinFd = openSync(file("input.txt"), "r");
const stdoutFd = openSync(file("stdout.log"), "a");
const stderrFd = openSync(file("stderr.log"), "a");
let child;
try {
  child = spawn(job.file, job.args, {
    cwd: job.cwd,
    stdio: [stdinFd, stdoutFd, stderrFd],
    windowsHide: true,
    windowsVerbatimArguments: job.windowsVerbatimArguments,
  });
} catch (error) {
  writeResult({ ...base, spawn_error: { code: error.code, message: error.message, command: job.command } });
}
for (const fd of [stdinFd, stdoutFd, stderrFd]) { try { closeSync(fd); } catch {} }
writeFileSync(file("child.json"), JSON.stringify({ pid: child.pid ?? null }));

let timedOut = false;
let aborted = false;
const stop = (reason) => {
  if (reason === "timeout") timedOut = true; else aborted = true;
  if (child.pid) killTree(child.pid);
};
setTimeout(() => stop("timeout"), job.timeout_ms);
setInterval(() => { if (!aborted && existsSync(file("cancel"))) stop("abort"); }, 300);

child.on("error", (error) => {
  writeResult({ ...base, timed_out: timedOut, aborted, spawn_error: { code: error.code, message: error.message, command: job.command } });
});
child.on("close", (code, signal) => {
  writeResult({ exit_code: code, signal: signal ?? null, timed_out: timedOut, aborted, spawn_error: null });
});
`;

export interface LaunchDurableWorkerOptions {
  /** Runtime state directory; the job directory is created inside it. */
  stateDir: string;
  runId: string;
  slotId: string;
  /** Executable to run (a .cmd shim is fine on Windows). */
  command: string;
  args?: string[];
  /** Text written to the worker's stdin. */
  input?: string;
  cwd: string;
  timeoutMs: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface LaunchedDurableWorker {
  /** Pid of the detached runner: the durable, restart-checkable identity. */
  pid: number;
  jobDir: string;
}

/**
 * Launches the detached runner for one worker. The worker command itself is
 * NOT started until {@link releaseDurableWorker} is called, so the caller can
 * persist the runner pid first.
 */
export async function launchDurableWorker(
  options: LaunchDurableWorkerOptions,
): Promise<LaunchedDurableWorker> {
  const paths = durableWorkerPaths(
    durableWorkerDir(options.stateDir, options.runId, options.slotId),
  );
  await mkdir(paths.dir, { recursive: true });
  const invocation = resolveSpawnInvocation(
    options.platform ?? process.platform,
    options.command,
    options.args ?? [],
  );
  const job: DurableJob = {
    file: invocation.file,
    args: invocation.args,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    cwd: options.cwd,
    timeout_ms: options.timeoutMs,
    kill_grace_ms: options.killGraceMs ?? 5_000,
    go_timeout_ms: 120_000,
    command: options.command,
    launched_at: new Date().toISOString(),
  };
  await Promise.all([
    writeFile(paths.job, JSON.stringify(job, null, 2), "utf8"),
    writeFile(paths.input, options.input ?? "", "utf8"),
    writeFile(paths.runner, WORKER_RUNNER_SOURCE, "utf8"),
  ]);

  const child = spawn(process.execPath, [paths.runner, paths.dir], {
    cwd: paths.dir,
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      if (child.pid === undefined) reject(new Error("Runner has no pid."));
      else resolvePromise(child.pid);
    });
  });
  child.unref();
  return { pid, jobDir: paths.dir };
}

/** Lets the runner start the worker. Call only after the runner pid is durable. */
export function releaseDurableWorker(jobDir: string): void {
  writeFileSync(durableWorkerPaths(jobDir).go, new Date().toISOString());
}

/** Asks the runner to stop its worker; it still writes a result. */
export function cancelDurableWorker(jobDir: string): void {
  try {
    writeFileSync(durableWorkerPaths(jobDir).cancel, new Date().toISOString());
  } catch {
    // The job directory is already gone -- nothing left to cancel.
  }
}

export function durableResultExists(jobDir: string | undefined): boolean {
  return jobDir !== undefined && existsSync(durableWorkerPaths(jobDir).result);
}

/**
 * True only for a runner that is genuinely the one we launched: the pid is
 * alive AND its heartbeat is fresh. The heartbeat is what protects against
 * PID reuse -- an unrelated process that inherited a dead runner's pid will
 * never touch that job directory's heartbeat file.
 */
export function durableWorkerAlive(
  jobDir: string | undefined,
  pid: number | null,
  options: {
    now?: () => number;
    isAlive?: (pid: number) => boolean;
  } = {},
): boolean {
  if (jobDir === undefined || pid === null) return false;
  if (!(options.isAlive ?? isProcessAlive)(pid)) return false;
  const now = (options.now ?? Date.now)();
  const paths = durableWorkerPaths(jobDir);
  try {
    if (now - statSync(paths.heartbeat).mtimeMs < DURABLE_HEARTBEAT_STALE_MS) {
      return true;
    }
    return false;
  } catch {
    // No heartbeat yet: only plausible for a runner that has just launched.
    try {
      return now - statSync(paths.job).mtimeMs < DURABLE_STARTUP_GRACE_MS;
    } catch {
      return false;
    }
  }
}

/** The worker pid the runner recorded, for evidence/diagnostics only. */
export async function readDurableChildPid(
  jobDir: string,
): Promise<number | null> {
  try {
    const parsed = JSON.parse(
      await readFile(durableWorkerPaths(jobDir).child, "utf8"),
    ) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export interface DurableWorkerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the worker was stopped because of a cancel request. */
  aborted: boolean;
  /** Set when spawning itself failed (e.g. ENOENT) rather than a bad exit. */
  spawnError?: { code: string | undefined; message: string; command: string };
}

/**
 * Loads a finished worker's result from disk. Returns null while the runner
 * has not written `result.json`.
 */
export async function readDurableResult(
  jobDir: string,
): Promise<DurableWorkerResult | null> {
  const paths = durableWorkerPaths(jobDir);
  let raw: DurableResultFile;
  try {
    raw = JSON.parse(
      await readTextRetry(paths.result),
    ) as DurableResultFile;
  } catch {
    return null;
  }
  const stdout = await readOptional(paths.stdout);
  const stderr = await readOptional(paths.stderr);
  return {
    exitCode: raw.exit_code,
    stdout,
    stderr: raw.spawn_error
      ? `${stderr}
spawn error (${raw.spawn_error.code ?? "UNKNOWN"}) launching "${raw.spawn_error.command}": ${raw.spawn_error.message}`
      : stderr,
    timedOut: raw.timed_out,
    aborted: raw.aborted,
    ...(raw.spawn_error
      ? {
          spawnError: {
            code: raw.spawn_error.code,
            message: raw.spawn_error.message,
            command: raw.spawn_error.command,
          },
        }
      : {}),
  };
}

export type DurableWaitOutcome =
  | { kind: "result"; result: DurableWorkerResult }
  /** The runner is gone and never wrote a result: a genuine crash. */
  | { kind: "vanished" };

export interface AwaitDurableWorkerOptions {
  jobDir: string;
  pid: number | null;
  pollMs?: number;
  /** Graceful stop: cancels the worker, then waits for its result. */
  signal?: AbortSignal;
  killGraceMs?: number;
  isAlive?: (pid: number) => boolean;
  killRunnerTree?: (pid: number) => void;
}

function killRunnerTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

/**
 * Waits for a durable worker to finish -- whether this process launched it or
 * a previous orchestrator did -- and returns its result. Never needs the
 * original child handle.
 */
export async function awaitDurableWorker(
  options: AwaitDurableWorkerOptions,
): Promise<DurableWaitOutcome> {
  const pollMs = options.pollMs ?? 250;
  const killGraceMs = options.killGraceMs ?? 5_000;
  let cancelledAt: number | null = null;
  for (;;) {
    const result = await readDurableResult(options.jobDir);
    if (result) return { kind: "result", result };

    if (options.signal?.aborted && cancelledAt === null) {
      cancelledAt = Date.now();
      cancelDurableWorker(options.jobDir);
    }
    const alive = durableWorkerAlive(options.jobDir, options.pid, {
      ...(options.isAlive ? { isAlive: options.isAlive } : {}),
    });
    if (!alive) {
      // The runner writes result.json strictly before it exits, so one more
      // read distinguishes "finished" from "vanished".
      const finalRead = await readDurableResult(options.jobDir);
      return finalRead
        ? { kind: "result", result: finalRead }
        : { kind: "vanished" };
    }
    if (
      cancelledAt !== null &&
      Date.now() - cancelledAt > killGraceMs + 10_000 &&
      options.pid !== null
    ) {
      (options.killRunnerTree ?? killRunnerTree)(options.pid);
      cancelledAt = Date.now();
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
}

/** Removes a fully consumed (or reclaimed) worker job directory. */
export async function removeDurableWorkerJob(
  jobDir: string | undefined,
): Promise<void> {
  if (!jobDir) return;
  await removeRetry(jobDir).catch(() => undefined);
}

/** Whether a job directory exists at all (used by cleanup assertions). */
export async function durableWorkerJobExists(jobDir: string): Promise<boolean> {
  return stat(jobDir)
    .then(() => true)
    .catch(() => false);
}
