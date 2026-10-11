/**
 * True when a process with this pid exists. EPERM means it exists but we
 * lack permission to signal it -- still alive. Any other error (typically
 * ESRCH) means it is gone.
 *
 * A bare pid check is never sufficient on its own: pids are recycled. The
 * durable worker layer pairs this with a heartbeat file for exactly that
 * reason.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SpawnInvocation {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * cmd.exe treats these as syntax (redirection, pipes, escaping, grouping),
 * so any token containing one must be caret-escaped or it will be
 * reinterpreted by the shell instead of passed through literally.
 */
const CMD_META_CHARS = new Set([
  "(",
  ")",
  "%",
  "!",
  "^",
  '"',
  "`",
  "<",
  ">",
  "&",
  "|",
  ";",
  ",",
  " ",
  "*",
  "?",
  "[",
  "]",
]);

function escapeCmdMetaChars(value: string): string {
  let out = "";
  for (const char of value) {
    out += CMD_META_CHARS.has(char) ? `^${char}` : char;
  }
  return out;
}

/**
 * Quotes one token for safe inclusion in a `cmd.exe /d /s /c "..."` command
 * line (https://qntm.org/cmd): backslash runs before a literal quote (or at
 * the end of the token) are doubled, the token is quote-wrapped, and every
 * cmd.exe metacharacter is caret-escaped.
 */
function escapeWindowsToken(value: string): string {
  let escaped = value.replace(/(\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escapeCmdMetaChars(escaped);
}

/**
 * Resolves how to actually spawn `command` on the given platform. On
 * Windows, npm installs CLIs as `.cmd` shims which node's `spawn` cannot
 * execute directly, so the call is routed through `cmd.exe /d /s /c` with
 * each token escaped (rather than `shell: true`, whose quoting is not
 * injection-safe). Other platforms need no wrapping.
 */
export function resolveSpawnInvocation(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
): SpawnInvocation {
  if (platform !== "win32") {
    return { file: command, args, windowsVerbatimArguments: false };
  }
  const commandLine = [command, ...args].map(escapeWindowsToken).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
