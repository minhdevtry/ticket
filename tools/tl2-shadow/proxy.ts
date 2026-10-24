#!/usr/bin/env bun
/**
 * Proxy giữ secret cho Tiểu Linh 2 (máy dev, chỉ nghe 127.0.0.1). Colab không bao giờ cầm secret:
 * gateway OpenClaw và MCP trên Colab gọi các cổng loopback này (qua `ssh -R`), proxy gỡ mọi
 * thông tin xác thực đi kèm rồi gắn khoá thật.
 *
 *  - MiniMax  (:18999)  chỉ POST /v1/messages và /v1/chat/completions, chỉ model trong allowlist,
 *                       có trần tốc độ và trần đồng thời, KHÔNG log nội dung.
 *  - itsaplan (:18998)  chỉ GET, tạo ticket vào đúng project thử, và ghi vào /issues/{id} khi
 *                       ticket đó đã kiểm tra là thuộc project thử. Chặn DELETE, webhook,
 *                       đổi project/team. Log mọi lệnh gọi (phương thức, đường dẫn, quyết định).
 *
 * Khoá và URL đọc từ ~/.config/ticket/minimax.env và ~/.config/ticket/tieulinh2.env (không commit).
 */
import { join } from "node:path";
import { ConfigError, configDir, intEnv, loadLocalEnv, readEnvFile } from "./config.ts";
import {
  type FetchLike,
  type Log,
  MAX_BODY,
  RateLimiter,
  deny,
  hostOk,
  isJson,
  json,
  passHeaders,
  pick,
  readBody,
  withAuth,
  withRelease,
} from "./proxy-common.ts";
import { createItsaplanProxy, selfTest } from "./proxy-itsaplan.ts";

export { createItsaplanProxy, matchWrite, selfTest } from "./proxy-itsaplan.ts";
export { safePath } from "./proxy-common.ts";

// ---------------------------------------------------------------- MiniMax

export interface MinimaxOpts {
  upstream: string;
  apiKey: string;
  models: string[];
  ratePerMin?: number;
  maxConcurrent?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: Log;
}

const MINIMAX_PATHS = new Set(["/v1/messages", "/v1/chat/completions"]);

export function createMinimaxProxy(o: MinimaxOpts) {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const ratePerMin = o.ratePerMin ?? 120;
  const maxConcurrent = o.maxConcurrent ?? 6;
  const upstream = o.upstream.replace(/\/+$/, "");
  const limiter = new RateLimiter(ratePerMin, now);
  let inflight = 0;

  return async (req: Request): Promise<Response> => {
    const t0 = now();
    const url = new URL(req.url);
    const entry: Record<string, unknown> = {
      ts: t0,
      svc: "minimax",
      method: req.method,
      path: url.pathname,
    };
    const finish = (res: Response, decision: string, reason?: string) => {
      log({ ...entry, decision, reason, status: res.status, ms: now() - t0 });
      return res;
    };

    if (!hostOk(req)) return finish(deny("Host không phải loopback"), "deny", "host");
    if (!MINIMAX_PATHS.has(url.pathname))
      return finish(deny("đường dẫn không được phép"), "deny", "path");
    if (req.method !== "POST") return finish(deny("chỉ POST", 405), "deny", "method");

    if (!isJson(req)) return finish(deny("cần content-type application/json", 415), "deny", "type");
    const body = await readBody(req, MAX_BODY);
    if (!body) return finish(deny("body quá lớn", 413), "deny", "too-large");
    entry.reqBytes = body.byteLength;
    let model: unknown;
    try {
      model = JSON.parse(new TextDecoder().decode(body))?.model;
    } catch {
      return finish(deny("body không phải JSON", 400), "deny", "bad-json");
    }
    entry.model = typeof model === "string" ? model : null;
    if (typeof model !== "string" || !o.models.includes(model)) {
      return finish(deny("model không nằm trong allowlist"), "deny", "model");
    }

    if (inflight >= maxConcurrent)
      return finish(deny("quá nhiều lệnh đồng thời", 429), "deny", "concurrency");
    if (!limiter.take()) return finish(deny("vượt trần tốc độ", 429), "deny", "rate");

    inflight++;
    let released = false;
    // Lưới an toàn: không để một luồng treo giữ chỗ đồng thời mãi mãi.
    const safety = setTimeout(() => release(), 10 * 60_000);
    safety.unref?.();
    const release = () => {
      if (!released) {
        released = true;
        inflight--;
        clearTimeout(safety);
      }
    };
    try {
      const headers = withAuth(
        pick(req, ["content-type", "accept", "anthropic-version", "anthropic-beta"]),
        o.apiKey,
      );
      const res = await doFetch(`${upstream}${url.pathname}${url.search}`, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
      });
      const out = new Response(res.body ? withRelease(res.body, release) : null, {
        status: res.status,
        headers: passHeaders(res.headers),
      });
      if (!res.body) release();
      return finish(out, "allow");
    } catch (e) {
      release();
      return finish(
        json(502, { error: "upstream", reason: "không gọi được upstream" }),
        "error",
        (e as Error)?.message,
      );
    }
  };
}

// ------------------------------------------------------------------ main

function requireKey(env: Record<string, string>, key: string, file: string): string {
  const v = env[key];
  if (!v) throw new ConfigError(`Thiếu ${key} trong ${file}`);
  return v;
}

/** Project cấm: khoá itsaplan không được nhìn thấy và proxy không được cho đọc. */
const FORBIDDEN_PROJECTS = ["TECH", "PO"];

export async function startProxies(
  opts: { log?: Log; env?: Record<string, string | undefined> } = {},
) {
  const env = opts.env ?? process.env;
  const log: Log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const dir = configDir(env);

  const mmFile = env.MINIMAX_ENV_FILE || join(dir, "minimax.env");
  const mm = readEnvFile(mmFile);
  const itFile = env.TIEULINH2_ENV_FILE || join(dir, "tieulinh2.env");
  const it = readEnvFile(itFile);

  const projectKey = requireKey(it, "ITSAPLAN_PROJECT_KEY", itFile);
  if (FORBIDDEN_PROJECTS.includes(projectKey)) {
    throw new ConfigError(
      `${itFile}: ITSAPLAN_PROJECT_KEY=${projectKey} là project thật; chỉ chạy với project thử`,
    );
  }

  const minimax = createMinimaxProxy({
    upstream: requireKey(mm, "MINIMAX_BASE_URL", mmFile),
    apiKey: requireKey(mm, "MINIMAX_API_KEY", mmFile),
    models: (env.TL2_MODEL_ALLOWLIST || mm.MINIMAX_MODELS || "MiniMax-M3.1-Flash")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ratePerMin: intEnv(env, "TL2_MINIMAX_RATE_PER_MIN", 120),
    maxConcurrent: intEnv(env, "TL2_MINIMAX_MAX_CONCURRENT", 6),
    log,
  });
  const itOpts = {
    upstream: requireKey(it, "ITSAPLAN_BASE_URL", itFile),
    apiKey: requireKey(it, "ITSAPLAN_API_KEY", itFile),
    projectKey,
  };
  const itsaplan = createItsaplanProxy({
    ...itOpts,
    ratePerMin: intEnv(env, "TL2_ITSAPLAN_RATE_PER_MIN", 600),
    writesPerMin: intEnv(env, "TL2_ITSAPLAN_WRITES_PER_MIN", 60),
    log,
  });
  await selfTest({ handler: itsaplan, ...itOpts, forbidden: FORBIDDEN_PROJECTS });

  const serve = (port: number, handler: (r: Request) => Promise<Response>) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: 13 * 1024 * 1024,
      fetch: handler,
    });
  const mmServer = serve(intEnv(env, "TL2_MINIMAX_PORT", 18999), minimax);
  const itServer = serve(intEnv(env, "TL2_ITSAPLAN_PORT", 18998), itsaplan);
  log({
    ts: Date.now(),
    svc: "proxy",
    msg: "started",
    minimaxPort: mmServer.port,
    itsaplanPort: itServer.port,
    projectKey,
  });
  return {
    stop() {
      mmServer.stop(true);
      itServer.stop(true);
    },
  };
}

if (import.meta.main) {
  loadLocalEnv();
  try {
    const proxies = await startProxies();
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        proxies.stop();
        process.exit(0);
      });
    }
  } catch (e) {
    console.error(`[proxy] không khởi động được: ${(e as Error).message}`);
    process.exit(1);
  }
}
