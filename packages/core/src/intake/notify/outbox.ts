/**
 * Outbox opt-in (B1) — đảm-bảo-gửi cho bot nào CẦN không mất tin báo ngược.
 *
 * Mặc định lib gửi THẲNG qua `ChannelPort`: nhanh nhất, nhưng một lỗi tức thời
 * (Telegram 5xx/429 hết retry, mạng chớp tắt) làm MẤT tin đó — chấp nhận được
 * với bot realtime như OP, không chấp nhận được với bot cần chắc chắn.
 *
 * Cơ chế (lấy từ CM `worker/outbox-dispatcher.ts` + `lib/domain/dedup.ts`, bản
 * trừu tượng hoá): một DECORATOR bọc quanh `ChannelPort` thật. Gửi thành công
 * thì y như cũ. Gửi THẤT BẠI thì ghi "việc gửi" vào một hàng đợi SQLite (outbox)
 * và một vòng `drainOutbox()` thử lại có GIỚI HẠN số lần + backoff. Hết số lần
 * thì bỏ cuộc và đánh dấu `failed` (có log) — không kẹt vòng lặp vô hạn.
 *
 * OPT-IN: bot muốn đảm bảo thì BỌC `ChannelPort` bằng `OutboxChannelPort` và gọi
 * `drainOutbox()` định kỳ (cron/worker tick). KHÔNG bọc ⇒ hành vi gửi-thẳng như
 * cũ, không hề đổi — đây là mặc định. ADR-0003: outbox là cache cục bộ, Itsaplan
 * vẫn là nguồn sự thật; mất outbox chỉ mất một tin thông báo, không mất ticket.
 *
 * Channel-free: decorator chỉ biết `ChannelPort`, không biết Telegram. Copy-free:
 * nó chuyển tiếp đúng input đã dựng, không sinh chữ.
 */
import type { Database } from "bun:sqlite";
import { getLogger } from "../../core/logger";
import type { ChannelPort, NotifyBinding, TicketLifecycleState } from "../ports";

/** Số lần thử lại tối đa trước khi bỏ cuộc. Nguồn CM: giới hạn để không kẹt. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Backoff cơ bản (ms) — lần thử thứ n chờ `base * 2^(n-1)`, chặn trần. */
export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_MAX_MS = 30 * 60_000;

export const OUTBOX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notify_outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,              -- 'comment' | 'state'
     payload_json TEXT NOT NULL,      -- input đã dựng cho ChannelPort
     status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT NOT NULL,   -- ISO; chỉ gửi lại khi now >= cái này
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notify_outbox (status, next_attempt_at)`,
];

/** Áp schema outbox (shape khớp core `ApplySchema`). */
export function outboxApplySchema(db: Database, opts: { wal: boolean } = { wal: false }): void {
  if (opts.wal) {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
  }
  for (const stmt of OUTBOX_SCHEMA) db.run(stmt);
}

type OutboxKind = "comment" | "state";

interface CommentPayload {
  binding: NotifyBinding;
  authorName: string;
  text: string;
  images?: string[];
  videos?: string[];
}
interface StatePayload {
  binding: NotifyBinding;
  message: string;
  state: TicketLifecycleState;
  withReporterOkButton: boolean;
}

interface OutboxRow {
  id: number;
  kind: OutboxKind;
  payload_json: string;
  attempts: number;
}

/** Clock tiêm để test được backoff. */
export interface OutboxClock {
  now(): number;
}
const systemClock: OutboxClock = { now: () => Date.now() };

export interface OutboxOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  clock?: OutboxClock;
}

/** Hàng đợi gửi-lại trên SQLite. */
export class SqliteOutboxStore {
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly clock: OutboxClock;

  constructor(
    private readonly db: Database,
    opts: OutboxOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.clock = opts.clock ?? systemClock;
  }

  /** Xếp một việc gửi vào hàng đợi (ngay sau khi gửi thẳng thất bại). */
  enqueue(kind: OutboxKind, payload: CommentPayload | StatePayload, firstError?: string): number {
    const now = new Date(this.clock.now()).toISOString();
    const res = this.db
      .query(
        `INSERT INTO notify_outbox (kind, payload_json, status, attempts, next_attempt_at, last_error, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(kind, JSON.stringify(payload), now, firstError ?? null, now, now);
    return Number(res.lastInsertRowid);
  }

  /** Số việc còn chờ (pending), hữu ích cho test/giám sát. */
  pendingCount(): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM notify_outbox WHERE status = 'pending'`)
      .get() as { n: number };
    return Number(row?.n ?? 0);
  }

  /**
   * Gửi lại các việc tới hạn qua `channel`. Trả tổng kết. Mỗi việc:
   *  - thành công ⇒ status = 'sent';
   *  - lỗi + còn lượt ⇒ attempts++, dời `next_attempt_at` theo backoff;
   *  - lỗi + hết lượt ⇒ status = 'failed' (log), thôi thử.
   */
  async drain(channel: ChannelPort): Promise<{ sent: number; retried: number; failed: number }> {
    const nowMs = this.clock.now();
    const nowIso = new Date(nowMs).toISOString();
    const rows = this.db
      .query(
        `SELECT id, kind, payload_json, attempts FROM notify_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id ASC`,
      )
      .all(nowIso) as OutboxRow[];

    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const row of rows) {
      let payload: CommentPayload | StatePayload;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        // payload hỏng không bao giờ gửi được — đánh failed để không kẹt.
        this.markFailed(row.id, "payload_json hỏng");
        failed++;
        continue;
      }

      try {
        if (row.kind === "comment") {
          await channel.sendComment(payload as CommentPayload);
        } else {
          await channel.sendStateChange(payload as StatePayload);
        }
        this.db
          .query(`UPDATE notify_outbox SET status = 'sent', updated_at = ? WHERE id = ?`)
          .run(new Date(this.clock.now()).toISOString(), row.id);
        sent++;
      } catch (err: any) {
        const attempts = row.attempts + 1;
        const msg = err?.message ? String(err.message) : String(err);
        if (attempts >= this.maxAttempts) {
          this.markFailed(row.id, `hết ${this.maxAttempts} lần: ${msg}`);
          getLogger().error(
            `[outbox] việc #${row.id} (${row.kind}) bỏ cuộc sau ${this.maxAttempts} lần: ${msg}`,
          );
          failed++;
        } else {
          const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempts - 1));
          const next = new Date(this.clock.now() + delay).toISOString();
          this.db
            .query(
              `UPDATE notify_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(attempts, next, msg, new Date(this.clock.now()).toISOString(), row.id);
          retried++;
        }
      }
    }
    return { sent, retried, failed };
  }

  private markFailed(id: number, reason: string): void {
    this.db
      .query(
        `UPDATE notify_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, new Date(this.clock.now()).toISOString(), id);
  }
}

/**
 * `OutboxChannelPort` — decorator OPT-IN bọc quanh một `ChannelPort` thật. Gửi
 * thẳng trước; CHỈ khi gửi thẳng ném lỗi mới xếp vào outbox để `drain()` sau. Vì
 * vậy đường thành công KHÔNG chậm thêm (không ghi DB khi mọi thứ ổn) — hợp cả
 * với bot realtime nếu nó muốn "đảm bảo" mà không trả giá độ trễ lúc bình thường.
 *
 * Trả về cùng kiểu `ChannelPort`: thành công trả message id như port gốc; thất
 * bại (đã xếp outbox) trả `null` để dispatcher không ghi route một tin chưa thực
 * sự gửi — route sẽ không có cho tới khi drain gửi được (chấp nhận: reply vào
 * tin đang treo là hiếm; đảm-bảo-gửi quan trọng hơn).
 */
export class OutboxChannelPort implements ChannelPort {
  readonly channelType: string;
  constructor(
    private readonly inner: ChannelPort,
    private readonly store: SqliteOutboxStore,
  ) {
    this.channelType = inner.channelType;
  }

  async sendComment(input: CommentPayload): Promise<string | number | null> {
    try {
      const r = await this.inner.sendComment(input);
      return r ?? null;
    } catch (err: any) {
      const id = this.store.enqueue(
        "comment",
        input,
        err?.message ? String(err.message) : String(err),
      );
      getLogger().warn(
        `[outbox] sendComment ${input.binding.identifier} lỗi, xếp outbox #${id} để gửi lại.`,
      );
      return null;
    }
  }

  async sendStateChange(input: StatePayload): Promise<string | number | null> {
    try {
      const r = await this.inner.sendStateChange(input);
      return r ?? null;
    } catch (err: any) {
      const id = this.store.enqueue(
        "state",
        input,
        err?.message ? String(err.message) : String(err),
      );
      getLogger().warn(
        `[outbox] sendStateChange ${input.binding.identifier} lỗi, xếp outbox #${id} để gửi lại.`,
      );
      return null;
    }
  }

  async clearInteractiveButtons(binding: NotifyBinding, messageId: string): Promise<void> {
    // Side job — không cần đảm bảo; chuyển thẳng nếu port gốc có.
    await this.inner.clearInteractiveButtons?.(binding, messageId);
  }
}
