/**
 * Kho SQLite của bộ học "người báo hay phải bổ sung gì" (W25). Bảng riêng, tạo bằng
 * CREATE TABLE IF NOT EXISTS; không đụng schema dùng chung (storage/schema.ts).
 *
 * - ask_learn_ticket: mỗi ticket đã quét (mốc created_at của ticket dùng làm mẫu số).
 * - ask_learn_comment: mỗi bình luận kỹ thuật viên đã phân loại. Khoá là comment_id,
 *   nên chạy lại ingest không gọi LLM lần thứ hai cho cùng bình luận.
 *
 * Thời gian lưu là epoch ms (INTEGER). Cột already_in_report thêm vào so với mô tả
 * ban đầu: học chỉ tính mục CHƯA có trong lời báo.
 */
import { Database } from "bun:sqlite";
import { openLazyDb } from "../storage/lazy-db";
import { isCanonItem, type CanonItem } from "./items";

export interface AskTicketRow {
  issueKey: string;
  system: string;
  createdAt: number;
  lastScannedAt: number;
}

export interface AskCommentRow {
  commentId: string;
  issueKey: string;
  system: string;
  createdAt: number;
  needsInfo: boolean;
  kind: string;
  items: CanonItem[];
  alreadyInReport: boolean;
  model: string;
  classifiedAt: number;
}

export function createAskLearnSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_learn_ticket (
      issue_key TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ask_learn_ticket_system ON ask_learn_ticket(system);
    CREATE TABLE IF NOT EXISTS ask_learn_comment (
      comment_id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      system TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      needs_info INTEGER NOT NULL,
      kind TEXT NOT NULL,
      items TEXT NOT NULL,
      already_in_report INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      classified_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ask_learn_comment_system ON ask_learn_comment(system, needs_info);
  `);
}

export class AskLearnStore {
  constructor(readonly db: Database) {
    createAskLearnSchema(db);
  }

  upsertTicket(row: AskTicketRow): void {
    this.db
      .query(
        `INSERT INTO ask_learn_ticket (issue_key, system, created_at, last_scanned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(issue_key) DO UPDATE SET system = excluded.system,
           created_at = excluded.created_at, last_scanned_at = excluded.last_scanned_at`,
      )
      .run(row.issueKey, row.system, row.createdAt, row.lastScannedAt);
  }

  upsertComment(row: AskCommentRow): void {
    this.db
      .query(
        `INSERT INTO ask_learn_comment (comment_id, issue_key, system, created_at, needs_info, kind, items,
           already_in_report, model, classified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(comment_id) DO UPDATE SET issue_key = excluded.issue_key, system = excluded.system,
           created_at = excluded.created_at, needs_info = excluded.needs_info, kind = excluded.kind,
           items = excluded.items, already_in_report = excluded.already_in_report,
           model = excluded.model, classified_at = excluded.classified_at`,
      )
      .run(
        row.commentId,
        row.issueKey,
        row.system,
        row.createdAt,
        row.needsInfo ? 1 : 0,
        row.kind,
        JSON.stringify(row.items),
        row.alreadyInReport ? 1 : 0,
        row.model,
        row.classifiedAt,
      );
  }

  hasComment(commentId: string): boolean {
    return this.db.query("SELECT 1 FROM ask_learn_comment WHERE comment_id = ?").get(commentId) !== null;
  }
  updateCommentsSystem(issueKey: string, system: string): number {
    const res = this.db
      .query("UPDATE ask_learn_comment SET system = ? WHERE issue_key = ? AND system != ?")
      .run(system, issueKey, system);
    return res.changes;
  }


  ticketsOf(system: string): AskTicketRow[] {
    const rows = this.db
      .query("SELECT issue_key, system, created_at, last_scanned_at FROM ask_learn_ticket WHERE system = ?")
      .all(system) as Array<{ issue_key: string; system: string; created_at: number; last_scanned_at: number }>;
    return rows.map((r) => ({
      issueKey: r.issue_key,
      system: r.system,
      createdAt: r.created_at,
      lastScannedAt: r.last_scanned_at,
    }));
  }

  /** Bình luận đòi người báo bổ sung (needs_info = 1) của một hệ thống. */
  needsCommentsOf(system: string): AskCommentRow[] {
    const rows = this.db
      .query(
        `SELECT comment_id, issue_key, system, created_at, needs_info, kind, items, already_in_report, model, classified_at
         FROM ask_learn_comment WHERE system = ? AND needs_info = 1`,
      )
      .all(system) as Array<Record<string, any>>;
    return rows.map((r) => ({
      commentId: r.comment_id,
      issueKey: r.issue_key,
      system: r.system,
      createdAt: r.created_at,
      needsInfo: r.needs_info === 1,
      kind: r.kind,
      items: parseItems(r.items),
      alreadyInReport: r.already_in_report === 1,
      model: r.model,
      classifiedAt: r.classified_at,
    }));
  }

  systems(): string[] {
    const rows = this.db.query("SELECT DISTINCT system FROM ask_learn_ticket").all() as Array<{ system: string }>;
    return rows.map((r) => r.system);
  }
}

function parseItems(raw: string): CanonItem[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isCanonItem) : [];
  } catch {
    return [];
  }
}

/** Mở (và tạo nếu chưa có) kho tại đường dẫn; dùng chung kết nối theo đường dẫn. */
export function openAskLearnStore(dbPath: string): AskLearnStore {
  return new AskLearnStore(openLazyDb(dbPath));
}
