import type { Database } from "bun:sqlite";

export interface KgSyncQueueRow {
  identifier: string;
  issue_id: number;
  project_key: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Hai bảng của luồng nạp Knowledge Graph (xem schema.ts):
 * - `kg_sync_queue`: ticket nạp hỏng chờ thử lại, sống qua restart.
 * - `kg_sync_ledger`: dấu vân tay nội dung đã nạp, để không bóc lại bằng LLM.
 */
/** Hàng đợi thử lại theo sink tri thức; cùng cấu trúc bảng (schema.ts). */
export type KnowledgeQueueTable = "kg_sync_queue" | "onyx_ingest_queue";

export class KgSyncRepository {
  constructor(
    private readonly db: Database,
    private readonly table: KnowledgeQueueTable = "kg_sync_queue",
  ) {}

  /** Ghi một lần hỏng: tạo mới (attempts=1) hoặc tăng attempts, giữ created_at. */
  enqueueFailure(params: {
    identifier: string;
    issueId: number;
    projectKey: string;
    error: string;
    nextAttemptAt: number;
    now: number;
  }): KgSyncQueueRow {
    this.db
      .query(`
        INSERT INTO ${this.table} (identifier, issue_id, project_key, attempts, next_attempt_at, last_error, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(identifier) DO UPDATE SET
          issue_id = excluded.issue_id,
          project_key = excluded.project_key,
          attempts = ${this.table}.attempts + 1,
          next_attempt_at = excluded.next_attempt_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `)
      .run(
        params.identifier,
        params.issueId,
        params.projectKey,
        params.nextAttemptAt,
        params.error.slice(0, 1000),
        params.now,
        params.now,
      );
    return this.getQueued(params.identifier)!;
  }

  getQueued(identifier: string): KgSyncQueueRow | null {
    return (
      (this.db
        .query(`SELECT * FROM ${this.table} WHERE identifier = ?`)
        .get(identifier) as KgSyncQueueRow) ?? null
    );
  }

  dequeue(identifier: string): void {
    this.db.query(`DELETE FROM ${this.table} WHERE identifier = ?`).run(identifier);
  }

  listDue(projectKey: string, now: number, limit = 20): KgSyncQueueRow[] {
    return this.db
      .query(`
        SELECT * FROM ${this.table}
        WHERE UPPER(project_key) = ? AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?
      `)
      .all(projectKey.toUpperCase(), now, limit) as KgSyncQueueRow[];
  }

  listQueue(): KgSyncQueueRow[] {
    return this.db
      .query(`SELECT * FROM ${this.table} ORDER BY next_attempt_at ASC`)
      .all() as KgSyncQueueRow[];
  }

  getLedger(identifier: string): { fingerprint: string; syncedAt: number } | null {
    const row = this.db
      .query(`SELECT fingerprint, synced_at FROM kg_sync_ledger WHERE identifier = ?`)
      .get(identifier) as { fingerprint: string; synced_at: number } | null;
    return row ? { fingerprint: row.fingerprint, syncedAt: row.synced_at } : null;
  }

  recordLedger(identifier: string, fingerprint: string, syncedAt: number): void {
    this.db
      .query(`
        INSERT INTO kg_sync_ledger (identifier, fingerprint, synced_at) VALUES (?, ?, ?)
        ON CONFLICT(identifier) DO UPDATE SET fingerprint = excluded.fingerprint, synced_at = excluded.synced_at
      `)
      .run(identifier, fingerprint, syncedAt);
  }

  /** Dạng `KgSyncLedger` để truyền thẳng vào syncDoneTicketToKnowledgeGraph. */
  ledger(): {
    get: (identifier: string) => { fingerprint: string; syncedAt: number } | null;
    record: (identifier: string, fingerprint: string, syncedAt: number) => void;
  } {
    return {
      get: (identifier) => this.getLedger(identifier),
      record: (identifier, fingerprint, syncedAt) =>
        this.recordLedger(identifier, fingerprint, syncedAt),
    };
  }
}
