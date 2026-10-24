/**
 * Hàng đợi sự kiện và kho cặp so sánh, đều là JSONL 0600 nằm ngoài repo (có chữ chat thật).
 *
 * - `events.jsonl`: mọi sự kiện relay nhận (tin vào, tin ra của Tiểu Linh 1, lệnh gọi tool).
 * - `pairs.jsonl`: một dòng cho mỗi tin vào đã được Tiểu Linh 2 xử lý xong.
 *
 * Không có file con trỏ: tin "đang chờ" = tin vào chưa có dòng trong pairs. Khởi động lại là
 * dựng lại được trạng thái từ hai file này.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface InboundEvent {
  v: 1;
  kind: "inbound";
  eid: string;
  ts: number;
  chatId: string;
  sessionKey: string | null;
  accountId: string | null;
  messageId: string | null;
  isGroup: boolean;
  senderId: string | null;
  senderName: string | null;
  senderUsername: string | null;
  text: string;
  replyTo: { id: string; body: string | null; sender: string | null } | null;
  media: { kind?: string; contentType?: string }[];
}

export interface OutboundEvent {
  v: 1;
  kind: "outbound";
  eid: string;
  ts: number;
  chatId: string;
  sessionKey: string | null;
  success: boolean;
  text: string;
}

export interface ToolEvent {
  v: 1;
  kind: "tool";
  eid: string;
  ts: number;
  sessionKey: string | null;
  tool: string | null;
  params: unknown;
  ok: boolean;
  error: string | null;
}

export type ShadowEvent = InboundEvent | OutboundEvent | ToolEvent;

export interface ToolCall {
  tool: string;
  params: unknown;
  ok: boolean;
}

export interface Pair {
  v: 1;
  eid: string;
  ts: number;
  chatId: string;
  text: string;
  tl1: { reply: string | null; tools: ToolCall[] };
  tl2: {
    reply: string | null;
    latencyMs: number | null;
    model: string | null;
    error: string | null;
  };
}

/** Tạo thư mục 0700 (siết lại nếu đã tồn tại với quyền rộng hơn). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
}

/** File JSONL 0600, đọc khoan dung (bỏ dòng hỏng, kể cả dòng cuối bị ghi dở). */
export class JsonlFile<T extends { ts: number }> {
  constructor(readonly path: string) {
    ensurePrivateDir(dirname(path));
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
    else chmodSync(path, 0o600);
  }

  append(record: T): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  readAll(): T[] {
    const out: T[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {}
    }
    return out;
  }

  /** Giữ bản ghi có ts >= cutoff; ghi qua file tạm rồi đổi tên nên không mất dữ liệu khi sập giữa chừng. */
  prune(cutoff: number): { kept: T[]; removed: number } {
    const all = this.readAll();
    const kept = all.filter((r) => r.ts >= cutoff);
    const removed = all.length - kept.length;
    if (removed > 0) {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, kept.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
      renameSync(tmp, this.path);
    }
    return { kept, removed };
  }
}

const byTs = (a: { ts: number }, b: { ts: number }) => a.ts - b.ts;

/** Chỉ mục trong bộ nhớ trên events.jsonl. */
export class EventStore {
  private file: JsonlFile<ShadowEvent>;
  private eids = new Set<string>();
  private inboundByChat = new Map<string, InboundEvent[]>();
  private outboundByChat = new Map<string, OutboundEvent[]>();
  private toolsBySession = new Map<string, ToolEvent[]>();
  private chatBySession = new Map<string, string>();

  constructor(path: string) {
    this.file = new JsonlFile<ShadowEvent>(path);
    this.reindex(this.file.readAll());
  }

  private reindex(events: ShadowEvent[]): void {
    this.eids.clear();
    this.inboundByChat.clear();
    this.outboundByChat.clear();
    this.toolsBySession.clear();
    this.chatBySession.clear();
    for (const ev of events.sort(byTs)) this.index(ev);
  }

  private index(ev: ShadowEvent): void {
    this.eids.add(ev.eid);
    const push = <K>(m: Map<K, ShadowEvent[]>, k: K, e: ShadowEvent) => {
      const list = m.get(k);
      if (list) list.push(e);
      else m.set(k, [e]);
    };
    if (ev.kind === "inbound") {
      push(this.inboundByChat as Map<string, ShadowEvent[]>, ev.chatId, ev);
      if (ev.sessionKey) this.chatBySession.set(ev.sessionKey, ev.chatId);
    } else if (ev.kind === "outbound") {
      push(this.outboundByChat as Map<string, ShadowEvent[]>, ev.chatId, ev);
    } else if (ev.sessionKey) {
      push(this.toolsBySession as Map<string, ShadowEvent[]>, ev.sessionKey, ev);
    }
    // Sự kiện tới trễ hơn thứ tự thời gian thì xếp lại cho đúng.
    for (const m of [this.inboundByChat, this.outboundByChat, this.toolsBySession]) {
      for (const list of m.values()) {
        for (let i = list.length - 1; i > 0 && list[i].ts < list[i - 1].ts; i--) {
          [list[i], list[i - 1]] = [list[i - 1], list[i]];
        }
      }
    }
  }

  /** Thêm một sự kiện; trả false nếu eid đã có (gửi lại). */
  add(ev: ShadowEvent): boolean {
    if (this.eids.has(ev.eid)) return false;
    this.file.append(ev);
    this.index(ev);
    return true;
  }

  size(): number {
    return this.eids.size;
  }

  prune(cutoff: number): number {
    const { kept, removed } = this.file.prune(cutoff);
    if (removed > 0) this.reindex(kept);
    return removed;
  }

  chats(): string[] {
    return [...this.inboundByChat.keys()];
  }

  inboundsOf(chatId: string): InboundEvent[] {
    return this.inboundByChat.get(chatId) ?? [];
  }

  private nextInbound(inb: InboundEvent): InboundEvent | undefined {
    const list = this.inboundsOf(inb.chatId);
    const i = list.indexOf(inb);
    return i >= 0 ? list[i + 1] : undefined;
  }

  /** Tin ra của Tiểu Linh 1 trong khoảng [tin vào này, tin vào kế tiếp của cùng chat). */
  outboundsFor(inb: InboundEvent): OutboundEvent[] {
    const end = this.nextInbound(inb)?.ts ?? Number.POSITIVE_INFINITY;
    return (this.outboundByChat.get(inb.chatId) ?? []).filter(
      (o) => o.success && o.ts >= inb.ts && o.ts < end,
    );
  }

  toolsFor(inb: InboundEvent): ToolCall[] {
    if (!inb.sessionKey) return [];
    const end = this.nextInbound(inb)?.ts ?? Number.POSITIVE_INFINITY;
    return (this.toolsBySession.get(inb.sessionKey) ?? [])
      .filter((t) => t.ts >= inb.ts && t.ts < end && t.tool)
      .map((t) => ({ tool: t.tool as string, params: t.params, ok: t.ok }));
  }

  tl1Reply(inb: InboundEvent): string | null {
    const outs = this.outboundsFor(inb);
    return outs.length ? outs.map((o) => o.text).join("\n\n") : null;
  }

  /**
   * Tiểu Linh 1 đã trả lời xong chưa: có tin ra và im lặng >= settleMs; hoặc cửa sổ đã đóng
   * (có tin vào kế tiếp) và đã qua settleMs; hoặc đã chờ quá maxWaitMs.
   */
  tl1Settled(inb: InboundEvent, now: number, settleMs: number, maxWaitMs: number): boolean {
    if (now - inb.ts >= maxWaitMs) return true;
    const outs = this.outboundsFor(inb);
    if (outs.length && now - outs[outs.length - 1].ts >= settleMs) return true;
    const next = this.nextInbound(inb);
    return Boolean(next && now - next.ts >= settleMs);
  }

  /** Ngữ cảnh gần đây của chat: các lượt trước (người dùng + Tiểu Linh 1), cũ → mới. */
  recentTurns(
    inb: InboundEvent,
    maxTurns: number,
    windowMs: number,
  ): { user: string; assistant: string | null }[] {
    if (maxTurns <= 0) return [];
    const prev = this.inboundsOf(inb.chatId).filter(
      (p) => p.ts < inb.ts && inb.ts - p.ts <= windowMs,
    );
    return prev.slice(-maxTurns).map((p) => ({ user: p.text, assistant: this.tl1Reply(p) }));
  }
}

/** Kho cặp so sánh + tập eid đã xong. */
export class PairStore {
  private file: JsonlFile<Pair>;
  private done = new Set<string>();

  constructor(path: string) {
    this.file = new JsonlFile<Pair>(path);
    for (const p of this.file.readAll()) this.done.add(p.eid);
  }

  has(eid: string): boolean {
    return this.done.has(eid);
  }

  add(pair: Pair): void {
    if (this.done.has(pair.eid)) return;
    this.file.append(pair);
    this.done.add(pair.eid);
  }

  readAll(): Pair[] {
    return this.file.readAll();
  }

  prune(cutoff: number): number {
    const { removed } = this.file.prune(cutoff);
    return removed;
  }
}
