import type { Database } from "bun:sqlite";
import { openLazyDb } from "../storage/lazy-db";
import { memoByPath } from "../storage/memo";
import type { IntakeDocument } from "./types";
import { normalizeSystemName } from "../kg/system-taxonomy";

/**
 * Các dạng chuỗi của cùng một chat Telegram: model có khi gửi `"telegram:123"`,
 * khi lại gửi `"123"`. Chỉ suy biến thể khi chatId thật sự là số (có thể kèm
 * tiền tố `telegram:`) — chatId dạng khác giữ nguyên, tránh "chat_123" khớp nhầm "123".
 */
export function chatIdVariants(chatId: string): string[] {
  const raw = String(chatId).trim();
  const m = /^(?:telegram:|tg:)?(-?\d+)$/i.exec(raw);
  if (!m) return [raw];
  return Array.from(new Set([raw, m[1], `telegram:${m[1]}`]));
}

/** Tài liệu đang gom dở mà im lặng quá chừng này thì hết hạn — tin nhắn sau mở tài liệu mới. */
export const INTAKE_DRAFT_TTL_MS = 24 * 3600_000;

/** `updated_at` của SQLite là "YYYY-MM-DD HH:MM:SS" (UTC, không kèm múi giờ). */
export function parseSqliteTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export class IntakeDocumentRepository {
  constructor(private readonly db: Database) {}

  /**
   * Lưu một bản ghi mới với (doc_id, revision)
   */
  saveRevision(doc: IntakeDocument): void {
    const query = this.db.prepare(
      `INSERT INTO intake_documents (doc_id, chat_id, revision, status, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(doc_id, revision) DO UPDATE SET
         status = excluded.status,
         state_json = excluded.state_json,
         updated_at = CURRENT_TIMESTAMP`,
    );
    query.run(doc.docId, doc.chatId, doc.revision, doc.status, JSON.stringify(doc));
  }

  /**
   * Ghi revision mới CHỈ KHI chưa ai ghi revision đó — phép so-và-đổi nguyên tử
   * trên khoá (doc_id, revision). Hai cú bấm xác nhận cùng lúc (kể cả từ hai
   * tiến trình MCP khác nhau) cùng đọc revision N, cùng muốn ghi N+1: chỉ một
   * bên thắng, bên kia biết là đã có người đang tạo ticket.
   */
  tryInsertRevision(doc: IntakeDocument): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO intake_documents (doc_id, chat_id, revision, status, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(doc.docId, doc.chatId, doc.revision, doc.status, JSON.stringify(doc));
    return res.changes === 1;
  }

  /**
   * Lấy revision được ghi GẦN NHẤT của một phiên chat.
   *
   * Xếp theo thời điểm ghi (updated_at, rồi rowid để phá hoà trong cùng một
   * giây), KHÔNG theo `revision`: revision chỉ tăng trong một tài liệu, nên xếp
   * theo nó thì tài liệu cũ đã huỷ ở rev 5 luôn thắng tài liệu mới ở rev 1 và
   * mỗi lượt bot lại dựng một tờ khai trắng.
   */
  getLatestByChatId(chatId: string): IntakeDocument | null {
    const keys = chatIdVariants(chatId);
    const row = this.db
      .prepare(
        `SELECT state_json FROM intake_documents
         WHERE chat_id IN (${keys.map(() => "?").join(", ")})
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(...keys) as { state_json: string } | null;

    if (!row) return null;
    try {
      return JSON.parse(row.state_json) as IntakeDocument;
    } catch {
      return null;
    }
  }

  /**
   * Lấy document theo docId và tùy chọn revision cụ thể (mặc định lấy revision cao nhất)
   */
  getByDocId(docId: string, revision?: number): IntakeDocument | null {
    let row: { state_json: string } | null;
    if (revision !== undefined) {
      row = this.db
        .prepare(`SELECT state_json FROM intake_documents WHERE doc_id = ? AND revision = ?`)
        .get(docId, revision) as { state_json: string } | null;
    } else {
      row = this.db
        .prepare(
          `SELECT state_json FROM intake_documents
           WHERE doc_id = ?
           ORDER BY revision DESC
           LIMIT 1`,
        )
        .get(docId) as { state_json: string } | null;
    }

    if (!row) return null;
    try {
      return JSON.parse(row.state_json) as IntakeDocument;
    } catch {
      return null;
    }
  }

  /**
   * Lấy toàn bộ lịch sử các revision của một document
   */
  getRevisions(docId: string): IntakeDocument[] {
    const rows = this.db
      .prepare(
        `SELECT state_json FROM intake_documents
         WHERE doc_id = ?
         ORDER BY revision ASC`,
      )
      .all(docId) as Array<{ state_json: string }>;

    return rows
      .map((r) => {
        try {
          return JSON.parse(r.state_json) as IntakeDocument;
        } catch {
          return null;
        }
      })
      .filter((d): d is IntakeDocument => d !== null);
  }

  /**
   * Tự động migrate bản nháp cũ từ intake_sessions nếu có
   */
  migrateFromLegacyDraft(chatId: string, opts: { maxAgeMs?: number } = {}): IntakeDocument | null {
    const row = this.db
      .prepare(`SELECT state_json, updated_at FROM intake_sessions WHERE session_id = ?`)
      .get(chatId) as { state_json: string; updated_at: string } | null;

    if (!row) return null;

    // Bản nháp bỏ dở quá lâu không còn là "việc đang dở" — đừng hồi sinh nó.
    if (opts.maxAgeMs !== undefined) {
      const savedAt = parseSqliteTimestamp(row.updated_at);
      if (savedAt !== null && Date.now() - savedAt > opts.maxAgeMs) return null;
    }

    try {
      const legacyState = JSON.parse(row.state_json) as Record<string, any>;
      const docId = `itk_${chatId}_${Date.now().toString(36)}`;
      const now = new Date().toISOString();

      const doc: IntakeDocument = {
        docId,
        chatId,
        revision: 1,
        status: "collecting",
        currentTurn: 1,
        fields: {},
        evidence: {},
        askedCount: {},
        similarTickets: [],
        createdAt: row.updated_at || now,
        updatedAt: now,
      };

      // Ánh xạ các trường từ legacyState
      if (legacyState.title) {
        doc.fields.title = {
          value: legacyState.title,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.product) {
        doc.fields.product = {
          value: legacyState.product,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.system) {
        // Draft cũ có thể chứa nhãn hệ thống trước 2026-09-23 (15 nhãn rác
        // LLM) — chuẩn hoá về danh mục 9 giá trị khi migrate.
        const norm = normalizeSystemName(legacyState.system);
        doc.fields.system = {
          value: norm?.value ?? legacyState.system,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.category) {
        doc.fields.errorCategory = {
          value: legacyState.category,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.reportingDept) {
        doc.fields.reportingDept = {
          value: legacyState.reportingDept,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.studentId || legacyState.studentAccount) {
        doc.fields.studentAccount = {
          value: legacyState.studentId || legacyState.studentAccount,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.customerId) {
        doc.fields.customerId = {
          value: legacyState.customerId,
          source: "user_message",
          turn: 1,
          updatedAt: now,
        };
      }
      if (legacyState.symptoms || legacyState.rawText) {
        const text = legacyState.symptoms || legacyState.rawText;
        doc.fields.symptoms = { value: [text], source: "user_message", turn: 1, updatedAt: now };
        doc.fields.rawText = { value: text, source: "user_message", turn: 1, updatedAt: now };
      }

      this.saveRevision(doc);
      return doc;
    } catch {
      return null;
    }
  }
}

export const getSharedIntakeDocRepo = memoByPath<IntakeDocumentRepository>(
  (dbPath) => new IntakeDocumentRepository(openLazyDb(dbPath)),
);
