#!/usr/bin/env bun
/**
 * Relay chạy bóng Tiểu Linh 2 (máy dev). Nhận sự kiện từ plugin `shadow-forwarder` trên server,
 * ghi vào hàng đợi 0600 và để worker chuyển cho Tiểu Linh 2.
 *
 *   POST /ingest   một sự kiện JSON (hoặc mảng) từ plugin; chỉ nhận từ SHADOW_ALLOW_FROM + loopback
 *   GET  /health   trạng thái hàng đợi (cùng danh sách IP)
 *
 * Chạy: bun run tools/tl2-shadow/relay.ts   (cấu hình: xem README và config.ts)
 */
import { timingSafeEqual } from "node:crypto";
import { type RelayConfig, loadLocalEnv, relayConfig } from "./config.ts";
import {
  EventStore,
  PairStore,
  type ShadowEvent,
  type ToolEvent,
  ensurePrivateDir,
} from "./queue.ts";
import { ShadowWorker } from "./worker.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT = 8000;
const MAX_BATCH = 200;

const str = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" ? v.slice(0, max) : v == null ? null : String(v).slice(0, max);

/** "::ffff:1.2.3.4" -> "1.2.3.4". */
export function normalizeIp(ip: string | undefined | null): string {
  return String(ip ?? "").replace(/^::ffff:/i, "");
}

export function isLoopback(ip: string): boolean {
  return ip === "::1" || /^127\.\d+\.\d+\.\d+$/.test(ip);
}

export function ipAllowed(ip: string | undefined | null, allowFrom: string[]): boolean {
  const n = normalizeIp(ip);
  return isLoopback(n) || allowFrom.includes(n);
}

/** Kiểm tra và rút gọn một sự kiện thô; chỉ giữ các trường biết trước. Trả null nếu không hợp lệ. */
export function normalizeEvent(raw: unknown, now = Date.now()): ShadowEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (r.v !== 1 || typeof r.eid !== "string" || !r.eid || r.eid.length > 200) return null;
  const ts = typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : now;
  if (r.kind === "inbound") {
    if (typeof r.chatId !== "string" || !r.chatId || typeof r.text !== "string") return null;
    return {
      v: 1,
      kind: "inbound",
      eid: r.eid,
      ts,
      chatId: r.chatId,
      sessionKey: str(r.sessionKey, 300),
      accountId: str(r.accountId, 100),
      messageId: str(r.messageId, 100),
      isGroup: r.isGroup === true,
      senderId: str(r.senderId, 100),
      senderName: str(r.senderName, 200),
      senderUsername: str(r.senderUsername, 100),
      text: r.text.slice(0, MAX_TEXT),
      replyTo: r.replyTo
        ? {
            id: String(r.replyTo.id ?? ""),
            body: str(r.replyTo.body),
            sender: str(r.replyTo.sender, 200),
          }
        : null,
      media: Array.isArray(r.media)
        ? r.media.slice(0, 20).map((m: any) => ({
            kind: str(m?.kind, 30) ?? undefined,
            contentType: str(m?.contentType, 100) ?? undefined,
          }))
        : [],
    };
  }
  if (r.kind === "outbound") {
    if (typeof r.chatId !== "string" || !r.chatId || typeof r.text !== "string") return null;
    return {
      v: 1,
      kind: "outbound",
      eid: r.eid,
      ts,
      chatId: r.chatId,
      sessionKey: str(r.sessionKey, 300),
      success: r.success !== false,
      text: r.text.slice(0, MAX_TEXT),
    };
  }
  if (r.kind === "tool") {
    const ev: ToolEvent = {
      v: 1,
      kind: "tool",
      eid: r.eid,
      ts,
      sessionKey: str(r.sessionKey, 300),
      tool: str(r.tool, 200),
      params: r.params ?? null,
      ok: r.ok !== false,
      error: str(r.error, 500),
    };
    return ev;
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface RelayDeps {
  cfg: RelayConfig;
  events: EventStore;
  worker: Pick<ShadowWorker, "pendingCount" | "isDown">;
  now?: () => number;
}

/** Bộ xử lý HTTP thuần: nhận Request và IP đã resolve, dễ kiểm thử không cần mở cổng. */
export function createHandler(d: RelayDeps) {
  const now = d.now ?? Date.now;
  return async (req: Request, ip: string | undefined | null): Promise<Response> => {
    if (!ipAllowed(ip, d.cfg.allowFrom)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        events: d.events.size(),
        pending: d.worker.pendingCount(),
        gatewayDown: d.worker.isDown(),
      });
    }
    if (req.method !== "POST" || url.pathname !== "/ingest") {
      return new Response("not found", { status: 404 });
    }
    if (d.cfg.token) {
      const given = req.headers.get("x-shadow-token") ?? "";
      if (!safeEqual(given, d.cfg.token)) return new Response("unauthorized", { status: 401 });
    }
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const list = Array.isArray(body) ? body.slice(0, MAX_BATCH) : [body];
    let added = 0;
    let dup = 0;
    let invalid = 0;
    for (const raw of list) {
      const ev = normalizeEvent(raw, now());
      if (!ev) invalid++;
      else if (d.events.add(ev)) added++;
      else dup++;
    }
    if (added + dup === 0) return Response.json({ ok: false, invalid }, { status: 400 });
    return Response.json({ ok: true, added, dup, invalid }, { status: 202 });
  };
}

export function startRelay(cfg: RelayConfig, log: (m: string) => void = console.log) {
  ensurePrivateDir(cfg.dir);
  const events = new EventStore(`${cfg.dir}/events.jsonl`);
  const pairs = new PairStore(`${cfg.dir}/pairs.jsonl`);
  const worker = new ShadowWorker({ cfg, events, pairs, log: (m) => log(`[worker] ${m}`) });
  const handle = createHandler({ cfg, events, worker });

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    maxRequestBodySize: MAX_BODY_BYTES + 1024,
    async fetch(req, srv) {
      try {
        return await handle(req, srv.requestIP(req)?.address);
      } catch (e) {
        log(`[relay] lỗi xử lý: ${(e as Error)?.message}`);
        return new Response("error", { status: 500 });
      }
    },
  });

  const prune = () => {
    const cutoff = Date.now() - cfg.retentionMs;
    const a = events.prune(cutoff);
    const b = pairs.prune(cutoff);
    if (a + b > 0)
      log(`[relay] dọn quá hạn ${cfg.retentionMs / 86_400_000} ngày: ${a} sự kiện, ${b} cặp`);
  };
  prune();
  const pruneTimer = setInterval(prune, 60 * 60 * 1000);
  worker.start();
  log(
    `[relay] nghe ${cfg.host}:${server.port}, cho phép ${["loopback", ...cfg.allowFrom].join(",")}; ` +
      `hàng đợi ${events.size()} sự kiện, ${worker.pendingCount()} tin đang chờ; dữ liệu ${cfg.dir}`,
  );
  return {
    server,
    events,
    pairs,
    worker,
    stop() {
      worker.stop();
      clearInterval(pruneTimer);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  loadLocalEnv();
  let relay: ReturnType<typeof startRelay>;
  try {
    relay = startRelay(relayConfig());
  } catch (e) {
    console.error(`[relay] không khởi động được: ${(e as Error).message}`);
    process.exit(1);
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      relay.stop();
      process.exit(0);
    });
  }
}
