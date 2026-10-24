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
 * JSONL (tối đa 5 MB, giữ 48 giờ) và gửi lại khi relay sống lại. Cấu hình sai (sessionPrefix không
 * hợp lệ, relayUrl không phải IP, thiếu token với relay ngoài loopback) thì plugin TỰ TẮT.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isIP } from "node:net";

export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT = 8000;
export const SPOOL_TTL_MS = 48 * 60 * 60 * 1000;
export const LOG_MAX_BYTES = 512 * 1024;
export const BREAKER_MS = 60_000;
export const MAX_PARAMS_CHARS = 4000;
export const MAX_CHAT_ID = 64;
const DRAIN_MIN_INTERVAL_MS = 30_000;
const DRAIN_MAX_EVENTS = 500;
/** Phạm vi duy nhất được phép: `agent:<id>:` (id gồm chữ thường, số, gạch ngang). */
export const SESSION_PREFIX_RE = /^agent:[a-z0-9-]+:$/;

export const stripPrefix = (v) => String(v ?? "").replace(/^telegram:/i, "");
export const chatIdOf = (ctx = {}, event = {}) =>
  stripPrefix(ctx.conversationId ?? event.to ?? "").slice(0, MAX_CHAT_ID);
export const isGroupSession = (sk) => /:(group|supergroup|channel):/.test(String(sk ?? ""));
export const inScope = (sessionKey, prefix) =>
  typeof prefix === "string" &&
  SESSION_PREFIX_RE.test(prefix) &&
  typeof sessionKey === "string" &&
  sessionKey.startsWith(prefix);

const clip = (v, n) => String(v ?? "").slice(0, n);

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

/** Tham số tool, bị chặn cỡ: quá MAX_PARAMS_CHARS thì chỉ ghi cỡ. */
export function boundedParams(params) {
  try {
    const s = JSON.stringify(params ?? null);
    if (s.length <= MAX_PARAMS_CHARS) return JSON.parse(s);
    return { _truncated: true, chars: s.length };
  } catch {
    return { _unserializable: true };
  }
}

export function buildTool(event = {}, ctx = {}) {
  return {
    v: 1,
    kind: "tool",
    eid: `tool:${randomUUID()}`,
    ts: Date.now(),
    sessionKey: ctx.sessionKey ?? null,
    runId: event.runId ?? ctx.runId ?? null,
    tool: clip(event.toolName ?? event.name, 200) || null,
    params: boundedParams(event.params),
    // Không gửi event.result: có thể chứa dữ liệu khách hàng và rất lớn.
    ok: !event.error,
    error: event.error ? clip(event.error, 500) : null,
    durationMs: event.durationMs ?? null,
  };
}

const isLoopbackHost = (h) => h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);

/**
 * Kiểm tra cấu hình. Trả `{ cfg }` hoặc `{ error }`; có lỗi thì plugin không đăng ký hook nào.
 *  - relayUrl: http(s) tới ĐỊA CHỈ IP (không hostname, không userinfo)
 *  - sessionPrefix: đúng dạng `agent:<id>:` (chuỗi rỗng hay thiếu dấu `:` cuối sẽ chuyển tiếp agent khác)
 *  - token bắt buộc khi relay không ở loopback
 */
export function validateConfig(pluginConfig, env = process.env) {
  const c = pluginConfig ?? {};
  const relayUrl = c.relayUrl ?? env.SHADOW_RELAY_URL;
  if (!relayUrl) return { error: "chưa cấu hình relayUrl" };
  let url;
  try {
    url = new URL(relayUrl);
  } catch {
    return { error: "relayUrl không phải URL hợp lệ" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "relayUrl phải là http(s)" };
  }
  if (url.username || url.password) return { error: "relayUrl không được chứa userinfo" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) return { error: "relayUrl phải dùng địa chỉ IP, không dùng hostname" };
  const token = c.token ?? env.SHADOW_RELAY_TOKEN ?? null;
  if (!isLoopbackHost(host) && !(typeof token === "string" && token.length >= 16)) {
    return { error: "relay ngoài loopback bắt buộc có token (>= 16 ký tự)" };
  }
  const sessionPrefix = c.sessionPrefix ?? "agent:ticket-intake-agent:";
  if (typeof sessionPrefix !== "string" || !SESSION_PREFIX_RE.test(sessionPrefix)) {
    return { error: "sessionPrefix phải có dạng agent:<id>:" };
  }
  const timeoutMs = c.timeoutMs ?? 1500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 5000) {
    return { error: "timeoutMs phải là số nguyên 200-5000" };
  }
  const stateDir = env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  return {
    cfg: {
      relayUrl: url.toString(),
      token: typeof token === "string" && token ? token : null,
      sessionPrefix,
      timeoutMs,
      tools: c.tools !== false,
      spoolPath: c.spoolPath ?? join(stateDir, "shadow-forwarder.spool.jsonl"),
      logPath: join(stateDir, "shadow-forwarder.log"),
    },
  };
}

/** Tương thích: trả cấu hình hoặc null nếu không hợp lệ. */
export function resolveConfig(pluginConfig, env = process.env) {
  return validateConfig(pluginConfig, env).cfg ?? null;
}

/** Nhật ký 0600, xoay một lần khi vượt LOG_MAX_BYTES. */
function makeLogger(cfg) {
  return (line) => {
    if (process.env.NODE_ENV === "test") return;
    try {
      mkdirSync(dirname(cfg.logPath), { recursive: true });
      try {
        if (statSync(cfg.logPath).size > LOG_MAX_BYTES) renameSync(cfg.logPath, `${cfg.logPath}.1`);
      } catch {}
      appendFileSync(cfg.logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {}
  };
}

function headersOf(cfg) {
  const h = { "content-type": "application/json" };
  if (cfg.token) h["x-shadow-token"] = cfg.token;
  return h;
}

/** Lỗi HTTP kèm mã trạng thái, để phân biệt lỗi tạm (thử lại) và lỗi vĩnh viễn (bỏ). */
class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** 4xx (trừ 408/429) nghĩa là relay từ chối hẳn sự kiện này: gửi lại cũng vô ích, nên bỏ. */
export const isPermanentFailure = (e) =>
  e instanceof HttpError &&
  e.status >= 400 &&
  e.status < 500 &&
  e.status !== 408 &&
  e.status !== 429;

async function post(cfg, payload, fetchImpl) {
  const r = await fetchImpl(cfg.relayUrl, {
    method: "POST",
    headers: headersOf(cfg),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  r.body?.cancel?.().catch?.(() => {});
  if (!r.ok) throw new HttpError(r.status);
}

// Cầu dao: sau một lần lỗi, 60 giây không gọi mạng (chỉ ghi spool) để không dồn việc lên gateway.
const state = { openUntil: 0, draining: false, lastDrainAt: 0, lastPruneAt: 0 };
export function resetState() {
  Object.assign(state, { openUntil: 0, draining: false, lastDrainAt: 0, lastPruneAt: 0 });
}

/** Ghi một sự kiện vào spool, dừng khi file đã đạt trần (rồi dọn sự kiện quá hạn nền). */
export function spoolAppend(cfg, payload) {
  try {
    mkdirSync(dirname(cfg.spoolPath), { recursive: true });
    let size = 0;
    try {
      size = statSync(cfg.spoolPath).size;
    } catch {}
    if (size >= SPOOL_MAX_BYTES) {
      void pruneSpool(cfg).catch(() => {});
      return false;
    }
    appendFileSync(cfg.spoolPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const expired = (payload, now) =>
  !(typeof payload?.ts === "number") || now - payload.ts > SPOOL_TTL_MS;

/** Dọn sự kiện quá SPOOL_TTL_MS, bất đồng bộ (không chặn vòng lặp gateway), tối đa mỗi 60 giây. */
export async function pruneSpool(cfg, now = Date.now()) {
  if (now - state.lastPruneAt < 60_000) return 0;
  state.lastPruneAt = now;
  let text;
  try {
    text = await readFile(cfg.spoolPath, "utf8");
  } catch {
    return 0;
  }
  const lines = text.split("\n").filter(Boolean);
  const kept = lines.filter((l) => {
    try {
      return !expired(JSON.parse(l), now);
    } catch {
      return false;
    }
  });
  if (kept.length === lines.length) return 0;
  const tmp = `${cfg.spoolPath}.tmp`;
  await writeFile(tmp, kept.map((l) => `${l}\n`).join(""), { mode: 0o600 });
  await rename(tmp, cfg.spoolPath);
  return lines.length - kept.length;
}

/**
 * Gửi lại spool theo thứ tự, bất đồng bộ. Một luồng duy nhất. Sự kiện quá hạn hoặc bị relay từ chối
 * hẳn (4xx) thì bỏ; lỗi tạm thì dừng và trả phần còn lại về spool.
 */
export async function drainSpool(cfg, fetchImpl = fetch, { force = false, now = Date.now() } = {}) {
  if (state.draining || (!force && now - state.lastDrainAt < DRAIN_MIN_INTERVAL_MS)) return 0;
  const work = `${cfg.spoolPath}.draining`;
  const present = async (p) =>
    stat(p).then(
      () => true,
      () => false,
    );
  if (!(await present(work)) && !(await present(cfg.spoolPath))) return 0;
  state.draining = true;
  state.lastDrainAt = now;
  let sent = 0;
  try {
    if (!(await present(work))) await rename(cfg.spoolPath, work);
    const lines = (await readFile(work, "utf8")).split("\n").filter(Boolean);
    let i = 0;
    for (; i < lines.length && i < DRAIN_MAX_EVENTS; i++) {
      let payload;
      try {
        payload = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (expired(payload, now)) continue;
      try {
        await post(cfg, payload, fetchImpl);
        sent++;
      } catch (e) {
        if (isPermanentFailure(e)) continue;
        break;
      }
    }
    const rest = lines.slice(i).filter((l) => {
      try {
        return !expired(JSON.parse(l), now);
      } catch {
        return false;
      }
    });
    if (rest.length)
      await appendFile(cfg.spoolPath, rest.map((l) => `${l}\n`).join(""), { mode: 0o600 });
    await unlink(work);
  } catch {
    // Giữ nguyên file .draining, lần sau thử lại.
  } finally {
    state.draining = false;
  }
  return sent;
}

/** Bắn rồi quên: trả về ngay, không bao giờ reject; lỗi tạm thì vào spool, lỗi vĩnh viễn thì bỏ. */
export function send(cfg, payload, fetchImpl = fetch, log = () => {}) {
  try {
    if (Date.now() < state.openUntil) {
      spoolAppend(cfg, payload);
      return;
    }
    post(cfg, payload, fetchImpl)
      .then(() => {
        state.openUntil = 0;
        void drainSpool(cfg, fetchImpl).catch(() => {});
      })
      .catch((e) => {
        if (isPermanentFailure(e)) {
          log(`relay từ chối (${e.message}), bỏ ${payload.kind}`);
          return;
        }
        state.openUntil = Date.now() + BREAKER_MS;
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
    const { cfg, error } = validateConfig(api.pluginConfig ?? api.config);
    if (!cfg) {
      // Tự tắt khi cấu hình sai; chưa đặt relayUrl thì im lặng.
      if (error && error !== "chưa cấu hình relayUrl") {
        try {
          const dir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
          makeLogger({ logPath: join(dir, "shadow-forwarder.log") })(`TẮT: ${error}`);
          api.logger?.warn?.(`shadow-forwarder tắt: ${error}`);
        } catch {}
      }
      return;
    }
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
