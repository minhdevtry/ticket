/**
 * Durable, cross-process webhook dedupe over SQLite — the CM hardening of the
 * webhook server's in-memory LRU.
 *
 * The webhook server keeps a bounded in-RAM `Set` of seen keys; that survives
 * exactly one process. Itsaplan RE-DELIVERS an old event after a restart, and
 * sibling workers share one DB file, so a RAM set lets a redelivered event
 * through twice. This store is the shared, restart-surviving guard.
 *
 * NGUỒN: CM `cm/worker/dedup-store.ts` (`WebhookDedupStore.claim`) and
 * `cm/lib/domain/dedup.ts` (`MessageDedup.record`). The win condition is a
 * single conditional upsert run inside `BEGIN IMMEDIATE`:
 *
 *   INSERT ... ON CONFLICT(key) DO UPDATE SET ... WHERE expires_at <= ?
 *
 * `BEGIN IMMEDIATE` takes the write lock at open, so `busy_timeout` actually
 * waits instead of SQLite returning SQLITE_BUSY_SNAPSHOT immediately (the real
 * bug CM measured in r4D-RACE). There is NO prior `SELECT`: the gate is the
 * `WHERE expires_at <= ?` clause plus `changes` (0 ⇒ a live key is held).
 *
 * This is the itsaplan layer because it is pure tracker-event dedupe with no
 * channel coupling, applied through core's lazy-db `applySchema` hook.
 */
import type { Database } from "bun:sqlite";
import type { WebhookDedupeStore } from "../../intake/ports";

/** 7 ngày: webhook retry trong vài ngày; TTL dài hơn cửa sổ retry là đủ. */
export const DEFAULT_WEBHOOK_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const WEBHOOK_DEDUPE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS webhook_dedupe (
     key TEXT PRIMARY KEY,
     received_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_dedupe_expires ON webhook_dedupe (expires_at)`,
];

/** Apply the webhook-dedupe schema (shape matches core's `ApplySchema`). */
export function webhookDedupeApplySchema(db: Database, opts: { wal: boolean } = { wal: false }): void {
  if (opts.wal) {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
  }
  for (const stmt of WEBHOOK_DEDUPE_SCHEMA) db.run(stmt);
}

export class SqliteWebhookDedupeStore implements WebhookDedupeStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number = DEFAULT_WEBHOOK_DEDUPE_TTL_MS,
  ) {}

  /**
   * `true` khi sự kiện MỚI (cần xử lý), `false` khi đã có tiến trình khác giữ
   * khoá. Chốt chặn là `WHERE expires_at <= ?` của `DO UPDATE` + `changes`.
   */
  claim(key: string): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtIso = new Date(now.getTime() + this.ttlMs).toISOString();
    const txn = this.db.transaction((): boolean => {
      const res = this.db
        .query(
          `INSERT INTO webhook_dedupe (key, received_at, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET received_at = excluded.received_at, expires_at = excluded.expires_at
           WHERE webhook_dedupe.expires_at <= ?`,
        )
        .run(key, nowIso, expiresAtIso, nowIso);
      return res.changes > 0;
    });
    return txn.immediate();
  }

  /** Dọn bản ghi hết hạn. Trả số dòng đã xoá. */
  purgeExpired(): number {
    return this.db.run("DELETE FROM webhook_dedupe WHERE expires_at <= ?", [new Date().toISOString()]).changes;
  }
}

/**
 * In-memory bounded dedupe (the webhook server's own default). Fine for a
 * single process; not restart-safe. Use `SqliteWebhookDedupeStore` across
 * processes. NGUỒN: intake `worker/webhook-server.ts` `seenWebhookKeys` LRU.
 */
export class MemoryWebhookDedupeStore implements WebhookDedupeStore {
  private readonly seen = new Set<string>();
  constructor(private readonly maxKeys = 5000) {}
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.maxKeys) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
