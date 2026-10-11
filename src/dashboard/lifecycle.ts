import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../process.js";
import { readRuntimeState } from "../runtime-state.js";

export class LifecycleError extends Error {}

/** What the dashboard start button launches. Absent: start is disabled. */
export interface StartCommand {
  command: string;
  args: string[];
  /** Working directory of the launched process. Defaults to process.cwd(). */
  cwd?: string;
}

export interface LifecycleDeps {
  startCommand?: StartCommand | undefined;
  spawn?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Delay between post-spawn liveness polls. Defaults to 400ms. */
  pollIntervalMs?: number;
  /** Number of post-spawn liveness polls before giving up. Defaults to 5. */
  pollAttempts?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 400;
const DEFAULT_POLL_ATTEMPTS = 5;
const LOG_TAIL_LINES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLogTail(logPath: string, lines: number): string[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-lines);
  } catch {
    return [];
  }
}

export interface LifecycleResult {
  ok: true;
  pid: number;
}

export async function startRuntime(
  dir: string,
  deps: LifecycleDeps = {},
): Promise<LifecycleResult> {
  const start = deps.startCommand;
  if (!start) {
    throw new LifecycleError(
      "No start command configured (set AGENT_RUNTIME_START_COMMAND).",
    );
  }
  const runtime = await readRuntimeState(dir);
  if (runtime.pid !== null && isProcessAlive(runtime.pid)) {
    throw new LifecycleError(
      `Runtime is already running (pid ${runtime.pid}). Stop it first.`,
    );
  }

  const spawnFn = deps.spawn ?? nodeSpawn;
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "dashboard.log");
  const logFd = openSync(logPath, "a");
  let childPid: number;
  try {
    const child = spawnFn(start.command, start.args, {
      cwd: start.cwd ?? process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      shell: process.platform === "win32",
    });
    child.unref();
    if (child.pid === undefined) {
      throw new LifecycleError("Failed to start the runtime process.");
    }
    childPid = child.pid;
  } finally {
    closeSync(logFd);
  }

  // A successful spawn only proves the OS launched *something* (on Windows,
  // via a shell wrapper) -- not that the runtime's own startup (e.g.
  // acquiring its lock) succeeded. Poll the runtime state for a live pid
  // before reporting success; otherwise surface the log tail so the real
  // failure reason is not silently swallowed.
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollAttempts = deps.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    const polled = await readRuntimeState(dir);
    if (polled.pid !== null && isProcessAlive(polled.pid)) {
      return { ok: true, pid: childPid };
    }
  }

  const tail = readLogTail(logPath, LOG_TAIL_LINES);
  const tailText = tail.length ? tail.join("\n") : "(no log output captured)";
  throw new LifecycleError(
    `Runtime process (pid ${childPid}) did not report as running within ` +
      `${pollAttempts * pollIntervalMs}ms. Last log lines:\n${tailText}`,
  );
}

export async function stopRuntime(
  dir: string,
  deps: LifecycleDeps = {},
): Promise<LifecycleResult> {
  const runtime = await readRuntimeState(dir);
  if (runtime.pid === null || !isProcessAlive(runtime.pid)) {
    throw new LifecycleError("Runtime is not running.");
  }
  const killFn = deps.kill ?? process.kill.bind(process);
  killFn(runtime.pid, "SIGTERM");
  return { ok: true, pid: runtime.pid };
}
