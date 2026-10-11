import { createServer, type Server } from "node:http";
import type { App } from "./app.js";

/** Binds an App to node:http on 127.0.0.1. Resolves once listening. */
export function listen(
  app: App,
  port: number,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    app
      .handle({ method: req.method ?? "GET", url: req.url ?? "/", headers })
      .then((response) => {
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      })
      .catch((error: Error) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual =
        typeof address === "object" && address ? address.port : port;
      resolvePromise({ server, port: actual });
    });
  });
}
