/**
 * Worker: lấy tin vào chưa xử lý trong hàng đợi, gửi tới gateway OpenClaw của Tiểu Linh 2 (Colab,
 * qua tunnel) bằng POST /v1/chat/completions, rồi ghi một cặp (Tiểu Linh 1, Tiểu Linh 2) vào
 * pairs.jsonl.
 *
 * - Mỗi chat chạy tuần tự, theo thứ tự tin nhắn; các chat khác nhau chạy song song (có trần).
 * - Gateway/tunnel không với tới được: tin giữ nguyên trong hàng đợi, thử lại với backoff khi
 *   tunnel trở lại (replay backlog). Tin cũ hơn `backlogMaxAgeMs` bị bỏ và ghi một cặp báo lỗi.
 * - Lỗi do phía Tiểu Linh 2 (HTTP lỗi, quá hạn, trả rỗng) ghi vào `tl2.error`, không thử lại.
 * - Cặp chỉ được ghi khi Tiểu Linh 1 đã trả lời xong (hoặc hết hạn chờ), nhưng Tiểu Linh 2 được gọi
 *   NGAY khi tin tới để đo độ trễ song song.
 */
import { readFileSync } from "node:fs";
import type { RelayConfig } from "./config.ts";
import type { EventStore, InboundEvent, Pair, PairStore } from "./queue.ts";
import { replayTurn, type ReplayDeps } from "./receptionist-replay.ts";
import type { PairV2 } from "./queue.ts";

export class GatewayUnreachable extends Error {}
export class Tl2Error extends Error {}

export interface Tl2Result {
  reply: string | null;
  latencyMs: number | null;
  model: string | null;
  error: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Phong bì kênh giống thứ OpenClaw gắn vào tin Telegram thật, để Tiểu Linh 2 biết chatId, người báo. */
export function buildEnvelope(inb: InboundEvent): string {
  const info: Record<string, unknown> = {
    message_id: inb.messageId ?? undefined,
    sender_id: inb.senderId ?? undefined,
    chat_id: `telegram:${inb.chatId}`,
    sender: inb.senderName ?? undefined,
    timestamp: new Date(inb.ts).toISOString(),
    is_group_chat: inb.isGroup || undefined,
  };
  const sender: Record<string, unknown> = {
    label: inb.senderName ? `${inb.senderName} (${inb.senderId ?? ""})`.trim() : undefined,
    id: inb.senderId ?? undefined,
    name: inb.senderName ?? undefined,
    username: inb.senderUsername ?? undefined,
  };
  const block = (title: string, obj: Record<string, unknown>) =>
    `${title} (untrusted metadata):\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
  const parts = [block("Conversation info", info)];
  if (inb.senderId || inb.senderName) parts.push(block("Sender", sender));
  if (inb.replyTo?.body) {
    parts.push(
      block("Replied message", { sender_label: inb.replyTo.sender, body: inb.replyTo.body }),
    );
  }
  parts.push(inb.text);
  return parts.join("\n\n");
}

export function buildMessages(
  inb: InboundEvent,
  turns: { user: string; assistant: string | null }[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const t of turns) {
    messages.push({ role: "user", content: t.user });
    if (t.assistant) messages.push({ role: "assistant", content: t.assistant });
  }
  messages.push({ role: "user", content: buildEnvelope(inb) });
  return messages;
}

export interface CallOptions {
  gatewayUrl: string;
  model: string;
  /** Nhãn model ghi vào kết quả; mặc định lấy từ phản hồi gateway. */
  modelLabel?: string;
  sessionKey: string;
  token: string | null;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export async function callTl2(messages: ChatMessage[], opts: CallOptions): Promise<Tl2Result> {
  if (!opts.token) throw new GatewayUnreachable("chưa có token gateway (tunnel chưa lấy về)");
  const doFetch = opts.fetchImpl ?? fetch;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await doFetch(`${opts.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
        "x-openclaw-session-key": opts.sessionKey,
      },
      body: JSON.stringify({ model: opts.model, messages, stream: false }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Tl2Error(`quá hạn ${opts.timeoutMs} ms`);
    }
    throw new GatewayUnreachable((e as Error)?.message ?? String(e));
  }
  const latencyMs = Math.round(performance.now() - t0);
  const raw = await res.text().catch(() => "");
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    // Tunnel mở nhưng gateway phía sau không trả lời: coi như chưa với tới.
    throw new GatewayUnreachable(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Tl2Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Tl2Error(`phản hồi không phải JSON: ${raw.slice(0, 120)}`);
  }
  const reply = body?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || reply.trim() === "") {
    throw new Tl2Error("gateway trả lời rỗng");
  }
  return { reply, latencyMs, model: opts.modelLabel ?? body?.model ?? null, error: null };
}

export function readGatewayToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export interface WorkerDeps {
  cfg: RelayConfig;
  events: EventStore;
  pairs: PairStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  readToken?: () => string | null;
  log?: (msg: string) => void;
  replayDeps?: ReplayDeps;
}

const BACKOFF_MIN = 5000;
const BACKOFF_MAX = 60_000;

export class ShadowWorker {
  private results = new Map<string, Tl2Result>();
  private v2Results = new Map<string, PairV2>();
  private calling = new Set<string>();
  private downUntil = 0;
  private backoff = BACKOFF_MIN;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private log: (msg: string) => void;

  constructor(private d: WorkerDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Số tin vào chưa có cặp. */
  pendingCount(): number {
    let n = 0;
    for (const chat of this.d.events.chats()) {
      for (const inb of this.d.events.inboundsOf(chat)) if (!this.d.pairs.has(inb.eid)) n++;
    }
    return n;
  }

  isDown(): boolean {
    return this.now() < this.downUntil;
  }

  /** Một vòng: hết hạn, khởi động lệnh gọi mới, ghi cặp theo thứ tự. Trả Promise của các lệnh gọi đã khởi động. */
  tick(): Promise<unknown> {
    const { cfg, events, pairs } = this.d;
    const now = this.now();
    const started: Promise<void>[] = [];

    for (const chat of events.chats()) {
      const pending = events.inboundsOf(chat).filter((i) => !pairs.has(i.eid));
      if (pending.length === 0) continue;

      // 1) Tin quá cũ: bỏ, ghi cặp báo lỗi để còn thấy trong bảng so sánh.
      for (const inb of pending) {
        if (now - inb.ts > cfg.backlogMaxAgeMs && !this.results.has(inb.eid)) {
          this.results.set(inb.eid, {
            reply: null,
            latencyMs: null,
            model: null,
            error: `bỏ: tồn đọng quá ${Math.round(cfg.backlogMaxAgeMs / 3_600_000)} giờ`,
          });
        }
      }

      // 2) Khởi động lệnh gọi cho tin cũ nhất chưa có kết quả.
      if (!this.calling.has(chat) && now >= this.downUntil && this.calling.size < cfg.concurrency) {
        const next = pending.find((i) => !this.results.has(i.eid));
        if (next) started.push(this.run(chat, next));
      }

      // 3) Ghi cặp theo thứ tự khi Tiểu Linh 1 đã xong.
      for (const inb of pending) {
        const r = this.results.get(inb.eid);
        if (!r) break;
        const expired = r.error?.startsWith("bỏ:") === true;
        if (!expired && !events.tl1Settled(inb, now, cfg.tl1SettleMs, cfg.tl1WaitMaxMs)) break;
        pairs.add(this.makePair(inb, r));
        this.results.delete(inb.eid);
      }
    }
    return Promise.allSettled(started);
  }

  private makePair(inb: InboundEvent, r: Tl2Result): Pair {
    const v2 = this.v2Results.get(inb.eid);
    if (v2) {
      this.v2Results.delete(inb.eid);
      return v2;
    }
    return {
      v: 1,
      eid: inb.eid,
      ts: inb.ts,
      chatId: inb.chatId,
      text: inb.text,
      tl1: { reply: this.d.events.tl1Reply(inb), tools: this.d.events.toolsFor(inb) },
      tl2: r,
    };
  }

  private async run(chat: string, inb: InboundEvent): Promise<void> {
    const { cfg, events } = this.d;
    this.calling.add(chat);
    try {
      if (cfg.target === "receptionist" && this.d.replayDeps) {
        const chatInbounds = events.inboundsOf(chat);
        const turns = chatInbounds.map((i) => ({
          user: i.text,
          tl1Reply: events.tl1Reply(i),
          eid: i.eid,
          ts: i.ts,
          mediaPaths: i.media.map((m) => m.kind ?? "").filter(Boolean),
        }));
        const targetTurnIndex = turns.findIndex((t) => t.eid === inb.eid);
        const pairV2 = await replayTurn(
          chat,
          turns,
          targetTurnIndex >= 0 ? targetTurnIndex : turns.length - 1,
          this.d.replayDeps,
        );
        this.v2Results.set(inb.eid, pairV2);
        this.results.set(inb.eid, {
          reply: pairV2.tl2.reply,
          latencyMs: pairV2.tl2.latencyMs,
          model: pairV2.tl2.model ?? "receptionist",
          error: pairV2.tl2.error,
        });
        this.log(
          `receptionist replay ok ${pairV2.tl2.latencyMs}ms diff=${pairV2.diff?.class ?? "match"}`,
        );
        return;
      }
      const turns = events.recentTurns(inb, cfg.contextTurns, cfg.contextWindowMs);
      const readToken = this.d.readToken ?? (() => readGatewayToken(cfg.gatewayTokenPath));
      const result = await callTl2(buildMessages(inb, turns), {
        gatewayUrl: cfg.gatewayUrl,
        model: cfg.model,
        modelLabel: cfg.modelLabel,
        sessionKey: `${cfg.sessionPrefix}${chat}`,
        token: readToken(),
        timeoutMs: cfg.requestTimeoutMs,
        fetchImpl: this.d.fetchImpl,
      });
      if (this.backoff !== BACKOFF_MIN || this.downUntil) this.log("gateway: trở lại");
      this.backoff = BACKOFF_MIN;
      this.downUntil = 0;
      this.results.set(inb.eid, result);
      this.log(`tl2 ok ${result.latencyMs}ms model=${result.model}`);
    } catch (e) {
      if (e instanceof GatewayUnreachable) {
        this.downUntil = this.now() + this.backoff;
        this.log(`gateway chưa với tới (${e.message}); thử lại sau ${this.backoff / 1000}s`);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.results.set(inb.eid, { reply: null, latencyMs: null, model: null, error: msg });
        this.log(`tl2 lỗi: ${msg}`);
      }
    } finally {
      this.calling.delete(chat);
    }
  }
}
