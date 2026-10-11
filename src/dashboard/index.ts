import { resolve } from "node:path";
import { createApp } from "./app.js";
import type { StartCommand } from "./lifecycle.js";
import { listen } from "./server.js";

function parseStartCommand(value: string | undefined): StartCommand | undefined {
  const tokens = value?.trim().split(/\s+/).filter(Boolean) ?? [];
  const [command, ...args] = tokens;
  return command ? { command, args } : undefined;
}

const dir = resolve(process.env.AGENT_RUNTIME_DIR ?? ".agent-runtime");
const port = Number(process.env.AGENT_RUNTIME_PORT ?? 4877);
const startCommand = parseStartCommand(process.env.AGENT_RUNTIME_START_COMMAND);

const app = createApp(dir, { startCommand });
const { port: actualPort } = await listen(app, port);
process.stdout.write(
  `agent-runtime dashboard: http://127.0.0.1:${actualPort} (state dir: ${dir})\n`,
);
