/**
 * shadow-forwarder: sao chép lưu lượng của MỘT agent sang relay chạy thử Tiểu Linh 2,
 * bắn rồi quên (fire-and-forget).
 *
 * Hook dùng (OpenClaw 2026.9.9, docs/plugins/hooks/reference.md), tất cả chỉ quan sát:
 *  - message_received  tin vào; gateway gọi qua fireAndForgetHook nên không thêm độ trễ
 *  - message_sent      câu trả lời cuối cùng đã gửi (sau khi các plugin khác viết lại)
 *  - after_tool_call   tên tool + tham số của Tiểu Linh 1, để so với bản 2
 * Không hook nào cần hooks.allowConversationAccess (chỉ agent_end, llm_input, llm_output,
 * before_agent_reply mới cần). KHÔNG đăng ký before_dispatch (hook chờ, chặn luồng) và
 * không bao giờ trả giá trị từ handler.
 *
 * Quy tắc an toàn: handler không await mạng; mọi lỗi bị nuốt; relay chết thì ghi vào spool
 * JSONL (tối đa 5 MB) và gửi lại khi relay sống lại.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT = 8000;
const DRAIN_MIN_INTERVAL_MS = 30_000;
const DRAIN_MAX_EVENTS = 500;

export const stripPrefix = (v) => String(v ?? "").replace(/^telegram:/i, "");
export const chatIdOf = (ctx = {}, event = {}) => stripPrefix(ctx.conversationId ?? event.to ?? "");
export const isGroupSession = (sk) => /:(group|supergroup|channel):/.test(String(sk ?? ""));
export const inScope = (sessionKey, prefix) => String(sessionKey ?? "").startsWith(prefix);

export function mediaFacts(arr) {
  return (arr ?? []).map((m) => ({
    kind: m.kind,
    contentType: m.contentType,
    hasLocalFile: Boolean(m.path),
    url: m.url ?? null,
  }));
}

export function buildInbound(event = {}, ctx = {}) {
  const md = event.metadata ?? {};
  const chatId = chatIdOf(ctx, event);
  const messageId = event.messageId ?? ctx.messageId ?? null;
  const accountId = ctx.accountId ?? null;
  return {
    v: 1,
    kind: "inbound",
    // eid ổn định theo tin nhắn: gửi lại hay hook bắn đôi thì relay khử trùng được.
    eid: messageId ? `in:${accountId}:${chatId}:${messageId}` : `in:${randomUUID()}`,
    ts: Date.now(),
    accountId,
    channelId: ctx.channelId ?? "telegram",
    chatId,
    isGroup: isGroupSession(event.sessionKey ?? ctx.sessionKey),
    sessionKey: event.sessionKey ?? ctx.sessionKey ?? null,
    runId: event.runId ?? ctx.runId ?? null,
    messageId,
    threadId: event.threadId ?? null,
    senderId: event.senderId ?? ctx.senderId ?? null,
    senderName: md.senderName ?? null,
    senderUsername: md.senderUsername ?? null,
    text: String(event.content ?? "").slice(0, MAX_TEXT),
    replyTo: event.replyToId
      ? {
          id: event.replyToId,
          body: event.replyToBody ?? null,
          sender: event.replyToSender ?? null,
          isQuote: event.replyToIsQuote ?? false,
        }
      : null,
    media: mediaFacts(event.media ?? event.originalMedia),
    location: event.location ?? null,
  };
}

export function buildOutbound(event = {}, ctx = {}) {
  const chatId = chatIdOf(ctx, event);
  const messageId = event.messageId ?? null;
  return {
    v: 1,
    kind: "outbound",
    eid: messageId ? `out:${ctx.accountId ?? null}:${chatId}:${messageId}` : `out:${randomUUID()}`,
    ts: Date.now(),
    accountId: ctx.accountId ?? null,
    chatId,
    sessionKey: event.sessionKey ?? ctx.sessionKey ?? null,
    runId: event.runId ?? null,
    messageId,
    success: event.success !== false,
    error: event.error ?? null,
    text: String(event.content ?? "").slice(0, MAX_TEXT),
  };
}

function safeJson(value, max) {
  try {
    const s = JSON.stringify(value ?? null);
    return max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
}

export function buildTool(event = {}, ctx = {}) {
  const params = safeJson(event.params);
  return {
    v: 1,
    kind: "tool",
    eid: `tool:${randomUUID()}`,
    ts: Date.now(),
    sessionKey: ctx.sessionKey ?? null,
    runId: event.runId ?? ctx.runId ?? null,
    tool: event.toolName ?? event.name ?? null,
    params: params ? JSON.parse(params) : null,
    result: safeJson(event.result, 1500),
    ok: !event.error,
    error: event.error ? String(event.error).slice(0, 500) : null,
    durationMs: event.durationMs ?? null,
  };
}

export function resolveConfig(pluginConfig, env = process.env) {
  const c = pluginConfig ?? {};
  const relayUrl = c.relayUrl ?? env.SHADOW_RELAY_URL;
  if (!relayUrl) return null;
  const stateDir = env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  return {
    relayUrl,
    token: c.token ?? env.SHADOW_RELAY_TOKEN ?? null,
    sessionPrefix: c.sessionPrefix ?? "agent:ticket-intake-agent:",
    timeoutMs: c.timeoutMs ?? 1500,
    tools: c.tools !== false,
    spoolPath: c.spoolPath ?? join(stateDir, "shadow-forwarder.spool.jsonl"),
    logPath: join(stateDir, "shadow-forwarder.log"),
  };
}

function makeLogger(cfg) {
  return (line) => {
    if (process.env.NODE_ENV === "test") return;
    try {
      appendFileSync(cfg.logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };
}

function headersOf(cfg) {
  const h = { "content-type": "application/json" };
  if (cfg.token) h["x-shadow-token"] = cfg.token;
  return h;
}

async function post(cfg, payload, fetchImpl) {
  const r = await fetchImpl(cfg.relayUrl, {
    method: "POST",
    headers: headersOf(cfg),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** Ghi một sự kiện vào spool, dừng khi file đã đạt trần. */
export function spoolAppend(cfg, payload) {
  try {
    mkdirSync(dirname(cfg.spoolPath), { recursive: true });
    let size = 0;
    try {
      size = statSync(cfg.spoolPath).size;
    } catch {}
    if (size >= SPOOL_MAX_BYTES) return false;
    appendFileSync(cfg.spoolPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

let draining = false;
let lastDrainAt = 0;

/** Gửi lại spool theo thứ tự. Một luồng duy nhất; dừng ở lần lỗi đầu tiên và trả phần còn lại về spool. */
export async function drainSpool(cfg, fetchImpl = fetch, { force = false } = {}) {
  const now = Date.now();
  if (draining || (!force && now - lastDrainAt < DRAIN_MIN_INTERVAL_MS)) return 0;
  const work = `${cfg.spoolPath}.draining`;
  if (!existsSync(work) && !existsSync(cfg.spoolPath)) return 0;
  draining = true;
  lastDrainAt = now;
  let sent = 0;
  try {
    if (!existsSync(work)) renameSync(cfg.spoolPath, work);
    const lines = readFileSync(work, "utf8").split("\n").filter(Boolean);
    let i = 0;
    for (; i < lines.length && i < DRAIN_MAX_EVENTS; i++) {
      let payload;
      try {
        payload = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      try {
        await post(cfg, payload, fetchImpl);
        sent++;
      } catch {
        break;
      }
    }
    for (const rest of lines.slice(i)) {
      try {
        spoolAppend(cfg, JSON.parse(rest));
      } catch {}
    }
    unlinkSync(work);
  } catch {
    // Giữ nguyên file .draining, lần sau thử lại.
  } finally {
    draining = false;
  }
  return sent;
}

/** Bắn rồi quên: trả về ngay, không bao giờ reject; lỗi thì vào spool. */
export function send(cfg, payload, fetchImpl = fetch, log = () => {}) {
  try {
    post(cfg, payload, fetchImpl)
      .then(() => {
        void drainSpool(cfg, fetchImpl).catch(() => {});
      })
      .catch((e) => {
        log(`relay fail (${e?.message || e}) -> spool ${payload.kind}`);
        spoolAppend(cfg, payload);
      });
  } catch (e) {
    log(`send err ${e?.message || e}`);
    spoolAppend(cfg, payload);
  }
}

export default {
  id: "shadow-forwarder",
  name: "Shadow forwarder",
  description: "Sao chép không chặn lưu lượng của một agent sang relay chạy thử.",
  register(api) {
    const cfg = resolveConfig(api.pluginConfig ?? api.config);
    if (!cfg) return; // chưa cấu hình relayUrl: không làm gì cả
    const log = makeLogger(cfg);
    log(`loaded relay=${cfg.relayUrl} prefix=${cfg.sessionPrefix}`);
    const guard = (name, fn) => (event, ctx) => {
      try {
        fn(event, ctx);
      } catch (e) {
        log(`${name} err ${e?.message}`);
      }
    };
    api.on(
      "message_received",
      guard("inbound", (event, ctx) => {
        if (inScope(event?.sessionKey ?? ctx?.sessionKey, cfg.sessionPrefix))
          send(cfg, buildInbound(event, ctx), fetch, log);
      }),
    );
    api.on(
      "message_sent",
      guard("outbound", (event, ctx) => {
        if (inScope(event?.sessionKey ?? ctx?.sessionKey, cfg.sessionPrefix))
          send(cfg, buildOutbound(event, ctx), fetch, log);
      }),
    );
    if (cfg.tools)
      api.on(
        "after_tool_call",
        guard("tool", (event, ctx) => {
          if (inScope(ctx?.sessionKey, cfg.sessionPrefix))
            send(cfg, buildTool(event, ctx), fetch, log);
        }),
      );
  },
};
