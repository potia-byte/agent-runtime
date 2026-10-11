import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp } from "../src/dashboard/app.js";
import { listen } from "../src/dashboard/server.js";
import { readRuntimeState, writeRuntimeState } from "../src/runtime-state.js";
import {
  buildSlot,
  buildTask,
  cleanupTempDirs,
  createFixtureDir,
} from "./support.js";

const LOCAL_HOST = "127.0.0.1:4877";
const pendingWrites: Promise<unknown>[] = [];

afterEach(async () => {
  await Promise.allSettled(pendingWrites.splice(0));
  await cleanupTempDirs();
});

async function get(
  app: App,
  path: string,
  headers: Record<string, string | undefined> = {},
) {
  const response = await app.handle({
    method: "GET",
    url: path,
    headers: { host: LOCAL_HOST, ...headers },
  });
  return { ...response, json: () => JSON.parse(response.body) as unknown };
}

async function post(
  app: App,
  path: string,
  headers: Record<string, string | undefined> = {},
) {
  const response = await app.handle({
    method: "POST",
    url: path,
    headers: { host: LOCAL_HOST, ...headers },
  });
  return { ...response, json: () => JSON.parse(response.body) as unknown };
}

const FAST_POLL = { pollIntervalMs: 20, pollAttempts: 150 };
const START = { command: "run-runtime", args: [] };

function markAliveInBackground(dir: string): void {
  pendingWrites.push(
    (async () => {
      const current = await readRuntimeState(dir);
      await writeRuntimeState(
        dir,
        { ...current, status: "running", pid: process.pid },
        { retryDelaysMs: [20, 50, 100, 200, 400, 800, 1_000, 2_000, 3_000] },
      );
    })(),
  );
}

describe("GET /api/status", () => {
  it("reflects the fixture's real state", async () => {
    const dir = await createFixtureDir({});
    const res = await get(createApp(dir), "/api/status");
    expect(res.status).toBe(200);
    expect((res.json() as { runtime_status: string }).runtime_status).toBe(
      "STOPPED",
    );
  });
});

describe("GET /api/workers", () => {
  it("returns slots with the liveness the recovery predicates would compute", async () => {
    const dir = await createFixtureDir({
      runtime: {
        slots: [
          buildSlot({ slot_id: "A", pid: process.pid, status: "running" }),
          buildSlot({
            slot_id: "B",
            task_id: "T-2",
            run_id: "run-2",
            workspace_path: "workspaces/cycle-1-B",
            pid: 4_000_001,
            status: "running",
          }),
        ],
      },
    });
    const app = createApp(dir, {
      isProcessAlive: (pid) => pid === process.pid,
    });
    const res = await get(app, "/api/workers");
    expect(res.status).toBe(200);
    const body = res.json() as Array<{ slot_id: string; liveness: string }>;
    expect(body.map((w) => [w.slot_id, w.liveness])).toEqual([
      ["A", "alive"],
      ["B", "dead"],
    ]);
  });
});

describe("GET /api/tasks and /api/tasks/:id", () => {
  it("lists tasks and returns a 404 JSON error for an unknown id", async () => {
    const dir = await createFixtureDir({ tasks: [buildTask({ id: "T-1" })] });
    const app = createApp(dir);

    const list = await get(app, "/api/tasks");
    expect(list.status).toBe(200);
    expect((list.json() as { id: string }[]).map((task) => task.id)).toEqual([
      "T-1",
    ]);

    const missing = await get(app, "/api/tasks/does-not-exist");
    expect(missing.status).toBe(404);
    expect((missing.json() as { error: string }).error).toMatch(/not found/i);

    const found = await get(app, "/api/tasks/T-1");
    expect(found.status).toBe(200);
    expect((found.json() as { id: string }).id).toBe("T-1");
  });
});

describe("GET /api/history and /api/log", () => {
  it("returns the newest history first and honours the limit", async () => {
    const dir = await createFixtureDir({
      runtime: {
        history: [
          { at: "2026-01-15T00:00:01.000Z", message: "first" },
          { at: "2026-01-15T00:00:02.000Z", message: "second" },
          { at: "2026-01-15T00:00:03.000Z", message: "third" },
        ],
      },
    });
    await writeFile(join(dir, "runtime.log"), "line one\nline two\n");
    const app = createApp(dir);

    const history = await get(app, "/api/history?limit=2");
    expect(
      (history.json() as { message: string }[]).map((item) => item.message),
    ).toEqual(["third", "second"]);

    const log = await get(app, "/api/log");
    expect(log.json()).toEqual(["line one", "line two"]);
  });
});

describe("lifecycle routes", () => {
  it("POST /api/lifecycle/start spawns the configured command via injected deps", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    const spawn = vi.fn().mockImplementation(() => {
      markAliveInBackground(dir);
      return { pid: 777, unref: vi.fn() };
    });
    const app = createApp(dir, {
      startCommand: START,
      spawn: spawn as never,
      ...FAST_POLL,
    });
    const res = await post(app, "/api/lifecycle/start");
    expect(res.status).toBe(200);
    expect((res.json() as { pid: number }).pid).toBe(777);
    expect(spawn).toHaveBeenCalledWith(
      "run-runtime",
      [],
      expect.anything(),
    );
  });

  it("POST /api/lifecycle/stop returns a clear 404 error when nothing is running", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    const res = await post(createApp(dir), "/api/lifecycle/stop");
    expect(res.status).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/not running/i);
  });

  it("POST /api/lifecycle/start returns a 409 when already running", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "running", pid: process.pid },
    });
    const res = await post(
      createApp(dir, { startCommand: START }),
      "/api/lifecycle/start",
    );
    expect(res.status).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/already running/i);
  });

  it("POST /api/lifecycle/stop signals the recorded pid", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "running", pid: process.pid },
    });
    const kill = vi.fn();
    const res = await post(createApp(dir, { kill }), "/api/lifecycle/stop");
    expect(res.status).toBe(200);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });
});

describe("static frontend", () => {
  it("serves the dashboard page and scripts", async () => {
    const dir = await createFixtureDir({});
    const app = createApp(dir);

    const page = await get(app, "/");
    expect(page.status).toBe(200);
    expect(page.headers["Content-Type"]).toMatch(/text\/html/);
    expect(page.body).toContain("agent-runtime");

    const i18n = await get(app, "/i18n.js");
    expect(i18n.status).toBe(200);
    expect(i18n.headers["Content-Type"]).toMatch(/javascript/);

    const script = await get(app, "/dashboard.js");
    expect(script.status).toBe(200);
    expect(script.headers["Content-Type"]).toMatch(/javascript/);
  });

  it("returns a JSON 404 for an unknown route", async () => {
    const dir = await createFixtureDir({});
    const res = await get(createApp(dir), "/nope");
    expect(res.status).toBe(404);
  });
});

describe("host/origin guard", () => {
  it("rejects a request whose Host header is not a local address", async () => {
    const dir = await createFixtureDir({});
    const res = await createApp(dir).handle({
      method: "GET",
      url: "/api/status",
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { error: string }).error).toMatch(
      /forbidden host/i,
    );
  });

  it("rejects a POST whose Origin does not match the request's Host", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    const spawn = vi.fn().mockReturnValue({ pid: 777, unref: vi.fn() });
    const app = createApp(dir, { startCommand: START, spawn: spawn as never });
    const res = await post(app, "/api/lifecycle/start", {
      origin: "http://evil.example.com",
    });
    expect(res.status).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/cross-origin/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("allows a POST whose Origin matches the request's Host", async () => {
    const dir = await createFixtureDir({
      runtime: { status: "stopped", pid: null },
    });
    const spawn = vi.fn().mockImplementation(() => {
      markAliveInBackground(dir);
      return { pid: 777, unref: vi.fn() };
    });
    const app = createApp(dir, {
      startCommand: START,
      spawn: spawn as never,
      ...FAST_POLL,
    });
    const res = await post(app, "/api/lifecycle/start", {
      origin: `http://${LOCAL_HOST}`,
    });
    expect(res.status).toBe(200);
    expect(spawn).toHaveBeenCalled();
  });
});

describe("error handling", () => {
  it("returns a JSON error body (not an HTML page) when a route throws", async () => {
    const dir = await createFixtureDir({});
    // Corrupt the ledger so its zod parse throws mid-request.
    await writeFile(
      join(dir, "ledger.json"),
      JSON.stringify({ tasks: "not an array" }),
      "utf8",
    );
    const res = await get(createApp(dir), "/api/tasks");
    expect(res.status).toBe(500);
    expect(res.headers["Content-Type"]).toMatch(/json/);
    expect(
      (res.json() as { error: string }).error.length,
    ).toBeGreaterThan(0);
  });
});

describe("node:http adapter", () => {
  it("serves the API over a real loopback socket", async () => {
    const dir = await createFixtureDir({ tasks: [buildTask({ id: "T-9" })] });
    const { server, port } = await listen(createApp(dir), 0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string }[];
      expect(body.map((task) => task.id)).toEqual(["T-9"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
