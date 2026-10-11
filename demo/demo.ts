import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/dashboard/app.js";
import { listen } from "../src/dashboard/server.js";
import { removeRetry } from "../src/fs-retry.js";
import { buildDemoState } from "./fixture.js";

/**
 * Starts the dashboard on a synthetic state directory. No external
 * services, no network beyond 127.0.0.1.
 *
 * To look at a real runtime instead, skip this script and run
 *   AGENT_RUNTIME_DIR=/path/to/state-dir npm run dashboard
 * (see README: the directory must contain runtime.json / ledger.json).
 */
export async function startDemo(port = 0) {
  const dir = mkdtempSync(join(tmpdir(), "agent-runtime-demo-"));
  const state = await buildDemoState(dir);
  const { server, port: actualPort } = await listen(createApp(dir), port);
  return {
    dir,
    url: `http://127.0.0.1:${actualPort}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await state.stop();
      await removeRetry(dir).catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  const requested = Number(process.env.AGENT_RUNTIME_PORT ?? 4877);
  const demo = await startDemo(requested).catch(() => startDemo(0));
  process.stdout.write(
    [
      `agent-runtime demo: ${demo.url}`,
      `synthetic state dir: ${demo.dir}`,
      "workers: A alive, B hung (pid alive, heartbeat stale), C dead, D finished",
      "provider worker-b is paused on a quota cooldown",
      "Ctrl+C to stop (the temp directory is removed).",
      "",
    ].join("\n"),
  );

  if (process.env.DEMO_SELFTEST === "1") {
    const response = await fetch(`${demo.url}/api/workers`);
    const workers = (await response.json()) as Array<{
      slot_id: string;
      liveness: string;
    }>;
    process.stdout.write(
      `selftest /api/workers: ${workers
        .map((worker) => `${worker.slot_id}=${worker.liveness}`)
        .join(" ")}\n`,
    );
    await demo.stop();
    return;
  }

  const shutdown = () => {
    void demo.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
