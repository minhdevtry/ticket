import type { Database } from "bun:sqlite";
import { openLazyDb } from "./lazy-db";
import { memoByPath } from "./memo";

export interface DraftSession {
  chatId: string;
  state: Record<string, unknown>;
  updatedAt?: string;
}

/**
 * Bản nháp ticket đang gom dở, khoá theo chatId.
 *
 * Phiên chat (OpenClaw) có thể tự reset giữa chừng lúc bot đang hỏi thêm
 * trường — ví dụ do idle timeout. Nếu không có chỗ giữ tạm, lượt sau bot mất
 * sạch ngữ cảnh và dễ nhầm sang việc của ticket cũ (`getLatestBinding`).
 */
export class DraftSessionRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  saveDraft(chatId: string, state: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO intake_sessions (session_id, state_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(chatId, JSON.stringify(state));
  }

  getDraft(chatId: string): DraftSession | null {
    const row = this.db
      .prepare(`SELECT session_id, state_json, updated_at FROM intake_sessions WHERE session_id = ?`)
      .get(chatId) as any;
    if (!row) return null;
    try {
      return { chatId: row.session_id, state: JSON.parse(row.state_json), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  clearDraft(chatId: string): void {
    this.db.prepare(`DELETE FROM intake_sessions WHERE session_id = ?`).run(chatId);
  }
}

export const getSharedDraftSessionRepo = memoByPath<DraftSessionRepository>(
  (dbPath) => new DraftSessionRepository(openLazyDb(dbPath)),
);
