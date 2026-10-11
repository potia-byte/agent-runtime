import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LifecycleError,
  type LifecycleDeps,
  startRuntime,
  stopRuntime,
} from "./lifecycle.js";
import {
  getHistory,
  getLogTail,
  getProviders,
  getStatusSnapshot,
  getTaskDetail,
  getTasks,
  getWorkers,
} from "./state-reader.js";

/**
 * Transport-independent request handler. `server.ts` adapts it to
 * node:http; tests call `handle` directly, so no port is needed.
 */

export interface AppRequest {
  method: string;
  /** Path plus optional query string, e.g. "/api/events?limit=10". */
  url: string;
  headers: Record<string, string | undefined>;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AppOptions extends LifecycleDeps {
  /** Directory of the static frontend. Defaults to <repo>/public. */
  publicDir?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface App {
  handle(request: AppRequest): Promise<AppResponse>;
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

function json(status: number, value: unknown): AppResponse {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(value),
  };
}

function parseLimit(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createApp(dir: string, options: AppOptions = {}): App {
  const publicDir =
    options.publicDir ?? fileURLToPath(new URL("../../public/", import.meta.url));

  const asset = (name: string, contentType: string): AppResponse => ({
    status: 200,
    headers: { "Content-Type": contentType },
    body: readFileSync(`${publicDir}/${name}`, "utf8"),
  });

  async function route(request: AppRequest): Promise<AppResponse> {
    const url = new URL(request.url, "http://local.invalid");
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "GET") {
      if (path === "/") return asset("index.html", "text/html; charset=utf-8");
      if (path === "/i18n.js") {
        return asset("i18n.js", "application/javascript; charset=utf-8");
      }
      if (path === "/dashboard.js") {
        return asset("dashboard.js", "application/javascript; charset=utf-8");
      }
      if (path === "/api/status") return json(200, await getStatusSnapshot(dir));
      if (path === "/api/workers") {
        return json(
          200,
          await getWorkers(dir, {
            ...(options.isProcessAlive
              ? { isProcessAlive: options.isProcessAlive }
              : {}),
          }),
        );
      }
      if (path === "/api/providers") return json(200, await getProviders(dir));
      if (path === "/api/tasks") return json(200, await getTasks(dir));
      if (path.startsWith("/api/tasks/")) {
        const id = decodeURIComponent(path.slice("/api/tasks/".length));
        const detail = await getTaskDetail(dir, id);
        if (!detail) return json(404, { error: "Task not found." });
        return json(200, detail);
      }
      if (path === "/api/history") {
        return json(
          200,
          await getHistory(dir, parseLimit(url.searchParams.get("limit"), 50)),
        );
      }
      if (path === "/api/log") {
        return json(
          200,
          await getLogTail(dir, parseLimit(url.searchParams.get("limit"), 50)),
        );
      }
    }

    if (method === "POST") {
      if (path === "/api/lifecycle/start") {
        try {
          return json(200, await startRuntime(dir, options));
        } catch (error) {
          return json(409, { error: (error as Error).message });
        }
      }
      if (path === "/api/lifecycle/stop") {
        try {
          return json(200, await stopRuntime(dir, options));
        } catch (error) {
          return json(error instanceof LifecycleError ? 404 : 500, {
            error: (error as Error).message,
          });
        }
      }
    }

    return json(404, { error: "Not found." });
  }

  return {
    async handle(request) {
      // Localhost-only and unauthenticated by design, so the app defends
      // itself against (a) DNS rebinding, where an attacker-controlled
      // origin resolves to 127.0.0.1 and becomes same-origin for the
      // browser, and (b) cross-origin form/fetch POSTs (CSRF). Reject any
      // Host that is not one of our own local addresses, and any non-GET
      // request whose Origin does not match the Host.
      const host = request.headers.host ?? "";
      if (!LOCAL_HOST.test(host)) {
        return json(403, { error: "Forbidden host." });
      }
      const origin = request.headers.origin;
      if (request.method.toUpperCase() !== "GET" && origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          return json(403, { error: "Cross-origin request refused." });
        }
        if (originHost !== host) {
          return json(403, { error: "Cross-origin request refused." });
        }
      }
      try {
        return await route(request);
      } catch (error) {
        return json(500, { error: (error as Error).message });
      }
    },
  };
}
