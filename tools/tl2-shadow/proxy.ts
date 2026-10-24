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
import { ConfigError, configDir, loadLocalEnv, readEnvFile } from "./config.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type Log = (entry: Record<string, unknown>) => void;

const MAX_BODY = 4 * 1024 * 1024;
const MAX_UPLOAD = 12 * 1024 * 1024;

const json = (status: number, body: unknown) => Response.json(body, { status });
const deny = (reason: string, status = 403) => json(status, { error: "denied", reason });

const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
  "proxy-authenticate",
  "trailer",
  "upgrade",
]);

function passHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!HOP.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

function pick(req: Request, names: string[]): Headers {
  const out = new Headers();
  for (const n of names) {
    const v = req.headers.get(n);
    if (v) out.set(n, v);
  }
  return out;
}

function withAuth(h: Headers, key: string): Headers {
  h.set("x-api-key", key);
  h.set("authorization", `Bearer ${key}`);
  return h;
}

async function readBody(req: Request, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength > max ? null : buf;
}

/** Bọc luồng phản hồi để nhả chỗ đồng thời khi luồng kết thúc, lỗi hoặc client bỏ giữa chừng. */
function withRelease(body: ReadableStream<Uint8Array>, release: () => void) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
        } else controller.enqueue(value);
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

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
  const hits: number[] = [];
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

    if (!MINIMAX_PATHS.has(url.pathname))
      return finish(deny("đường dẫn không được phép"), "deny", "path");
    if (req.method !== "POST") return finish(deny("chỉ POST", 405), "deny", "method");

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

    while (hits.length && t0 - hits[0] > 60_000) hits.shift();
    if (hits.length >= ratePerMin) return finish(deny("vượt trần tốc độ", 429), "deny", "rate");
    if (inflight >= maxConcurrent)
      return finish(deny("quá nhiều lệnh đồng thời", 429), "deny", "concurrency");
    hits.push(t0);

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

// --------------------------------------------------------------- itsaplan

export interface ItsaplanOpts {
  upstream: string;
  apiKey: string;
  /** Project thử duy nhất được ghi vào. */
  projectKey: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: Log;
}

const OK_TTL = 10 * 60_000;
const NO_TTL = 30_000;

/** Đường dẫn an toàn: ký tự cho phép, không `..`, không `//`, không mã hoá `/` `.` `\`. */
export function safePath(path: string): boolean {
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(path)) return false;
  if (path.includes("..") || path.includes("//")) return false;
  return true;
}

export function createItsaplanProxy(o: ItsaplanOpts) {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const upstream = o.upstream.replace(/\/+$/, "");
  const owned = new Map<number, { ok: boolean; exp: number }>();

  const fetchUp = (path: string, init: RequestInit = {}) => {
    const headers = withAuth(new Headers(init.headers), o.apiKey);
    return doFetch(`${upstream}${path}`, { ...init, headers, redirect: "manual" });
  };

  /** Ticket có thuộc project thử không: hỏi upstream và nhớ kết quả. */
  async function belongs(id: number): Promise<boolean> {
    const hit = owned.get(id);
    if (hit && hit.exp > now()) return hit.ok;
    let ok = false;
    try {
      const res = await fetchUp(`/issues/${id}`, { headers: { accept: "application/json" } });
      if (res.ok) {
        const issue: any = await res.json();
        const ident = String(issue?.identifier ?? issue?.issue?.identifier ?? "");
        ok = ident.startsWith(`${o.projectKey}-`);
      }
    } catch {}
    owned.set(id, { ok, exp: now() + (ok ? OK_TTL : NO_TTL) });
    return ok;
  }

  return async (req: Request): Promise<Response> => {
    const t0 = now();
    const url = new URL(req.url);
    const entry: Record<string, unknown> = {
      ts: t0,
      svc: "itsaplan",
      method: req.method,
      path: url.pathname,
    };
    const finish = (res: Response, decision: string, reason?: string) => {
      log({ ...entry, decision, reason, status: res.status, ms: now() - t0 });
      return res;
    };
    const refuse = (reason: string, status = 403) => finish(deny(reason, status), "deny", reason);

    if (!safePath(url.pathname)) return refuse("đường dẫn không hợp lệ", 400);
    const seg = url.pathname.split("/").filter(Boolean);
    const method = req.method.toUpperCase();

    if (method === "DELETE") return refuse("DELETE bị chặn");
    if (seg.some((s) => /^webhooks?$/i.test(s))) return refuse("webhook bị chặn");

    const forward = async (body?: ArrayBuffer, after?: (res: Response) => Promise<Response>) => {
      try {
        const res = await fetchUp(`${url.pathname}${url.search}`, {
          method,
          headers: pick(req, ["content-type", "accept"]),
          body: method === "GET" || method === "HEAD" ? undefined : body,
        });
        const out = after
          ? await after(res)
          : new Response(res.body, { status: res.status, headers: passHeaders(res.headers) });
        return finish(out, "allow");
      } catch (e) {
        return finish(json(502, { error: "upstream" }), "error", (e as Error)?.message);
      }
    };

    // Đọc: cho phép mọi GET/HEAD (key thật cũng chỉ thấy project thử).
    if (method === "GET" || method === "HEAD") return forward();

    if (method !== "POST" && method !== "PATCH" && method !== "PUT")
      return refuse("phương thức không được phép", 405);

    const body = await readBody(req, MAX_UPLOAD);
    if (!body) return refuse("body quá lớn", 413);

    // Tạo ticket: chỉ vào project thử.
    if (seg.length === 3 && seg[0] === "projects" && seg[2] === "issues") {
      if (method !== "POST" || seg[1] !== o.projectKey)
        return refuse("chỉ tạo ticket trong project thử");
      return forward(body, async (res) => {
        const text = await res.text();
        try {
          const issue: any = JSON.parse(text);
          const id = Number(issue?.id ?? issue?.issue?.id);
          if (res.ok && Number.isInteger(id)) owned.set(id, { ok: true, exp: now() + OK_TTL });
        } catch {}
        return new Response(text, { status: res.status, headers: passHeaders(res.headers) });
      });
    }

    // Ghi vào một ticket: phải là ticket của project thử.
    if (seg[0] === "issues" && /^\d+$/.test(seg[1] ?? "")) {
      const id = Number(seg[1]);
      entry.issueId = id;
      if (!(await belongs(id))) return refuse("ticket không thuộc project thử");
      if (seg[2] === "links") {
        // Không cho nối sang ticket của project khác.
        let target: unknown;
        try {
          target = JSON.parse(new TextDecoder().decode(body))?.targetIssueId;
        } catch {}
        const tid = Number(target);
        if (!Number.isInteger(tid) || !(await belongs(tid)))
          return refuse("link tới ticket ngoài project thử");
      }
      return forward(body);
    }

    return refuse("không có quy tắc cho phép");
  };
}

// ------------------------------------------------------------------ main

function requireKey(env: Record<string, string>, key: string, file: string): string {
  const v = env[key];
  if (!v) throw new ConfigError(`Thiếu ${key} trong ${file}`);
  return v;
}

export function startProxies(opts: { log?: Log; env?: Record<string, string | undefined> } = {}) {
  const env = opts.env ?? process.env;
  const log: Log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  const dir = configDir(env);

  const mmFile = env.MINIMAX_ENV_FILE || join(dir, "minimax.env");
  const mm = readEnvFile(mmFile);
  const itFile = env.TIEULINH2_ENV_FILE || join(dir, "tieulinh2.env");
  const it = readEnvFile(itFile);

  const projectKey = requireKey(it, "ITSAPLAN_PROJECT_KEY", itFile);
  if (["TECH", "PO"].includes(projectKey)) {
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
    ratePerMin: Number(env.TL2_MINIMAX_RATE_PER_MIN || 120),
    maxConcurrent: Number(env.TL2_MINIMAX_MAX_CONCURRENT || 6),
    log,
  });
  const itsaplan = createItsaplanProxy({
    upstream: requireKey(it, "ITSAPLAN_BASE_URL", itFile),
    apiKey: requireKey(it, "ITSAPLAN_API_KEY", itFile),
    projectKey,
    log,
  });

  const serve = (port: number, handler: (r: Request) => Promise<Response>) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: MAX_UPLOAD + 1024,
      fetch: handler,
    });
  const mmServer = serve(Number(env.TL2_MINIMAX_PORT || 18999), minimax);
  const itServer = serve(Number(env.TL2_ITSAPLAN_PORT || 18998), itsaplan);
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
  let proxies: ReturnType<typeof startProxies>;
  try {
    proxies = startProxies();
  } catch (e) {
    console.error(`[proxy] không khởi động được: ${(e as Error).message}`);
    process.exit(1);
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      proxies.stop();
      process.exit(0);
    });
  }
}
