/**
 * Server `/healthz` nhỏ cho bot: chỉ GET/HEAD một đường dẫn, trả JSON sức khoẻ.
 * Mặc định bind `127.0.0.1` (probe cục bộ / reverse proxy); đổi `host` có chủ đích.
 * 200 khi `ok`/`degraded`, 503 khi `down`/`starting`/`stopped`. Không chứa secret.
 */
import http from "node:http";
import type { BotHealth } from "./create";

export interface HealthServerOptions {
  port: number;
  host?: string;
  /** Mặc định `/healthz`. */
  path?: string;
  health: () => BotHealth;
}

export interface HealthServerHandle {
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Bật server health. `port: 0` để hệ điều hành chọn cổng (test). */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServerHandle> {
  const path = options.path ?? "/healthz";
  const host = options.host ?? "127.0.0.1";
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== path) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    let status = 503;
    let body: string;
    try {
      const health = options.health();
      status = health.status === "ok" || health.status === "degraded" ? 200 : 503;
      body = JSON.stringify(health);
    } catch {
      body = '{"status":"down","error":"health check failed"}';
    }
    res
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port;
  return {
    host,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
