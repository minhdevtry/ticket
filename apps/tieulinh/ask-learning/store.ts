/**
 * Kho SQLite của bộ học "người báo hay phải bổ sung gì" (W25).
 * Thuộc app/script ngoài (ASK_LEARN_DB), core không sở hữu DB này.
 */
import type { Database } from "bun:sqlite";
import { makeOpenLazyDb } from "@vuihoc/bot-core/core";
import {
  isCanonItem,
  type AskCommentRow,
  type AskLearnDataProvider,
  type AskTicketRow,
  type CanonItem,
} from "@vuihoc/bot-core/intake";

export type { AskTicketRow, AskCommentRow };

export function createAskLearnSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ask_learn_ticket (
      issue_key TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ask_ticket_system_created ON ask_learn_ticket (system, created_at);

    CREATE TABLE IF NOT EXISTS ask_learn_comment (
      comment_id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      system TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      needs_info INTEGER NOT NULL,
      kind TEXT NOT NULL,
      items TEXT NOT NULL,
      already_in_report INTEGER NOT NULL,
      model TEXT NOT NULL,
      classified_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ask_comment_system_needs ON ask_learn_comment (system, needs_info);
  `);
}

function parseItems(raw: string): CanonItem[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isCanonItem) : [];
  } catch {
    return [];
  }
}

export class AskLearnStore implements AskLearnDataProvider {
  constructor(readonly db: Database) {
    createAskLearnSchema(db);
  }

  upsertTicket(row: AskTicketRow & { lastScannedAt?: number }): void {
    const lastScanned = row.lastScannedAt ?? Date.now();
    this.db
      .query(
        `INSERT INTO ask_learn_ticket (issue_key, system, created_at, last_scanned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(issue_key) DO UPDATE SET system = excluded.system,
           created_at = excluded.created_at, last_scanned_at = excluded.last_scanned_at`,
      )
      .run(row.issueKey, row.system, row.createdAt, lastScanned);
  }

  upsertComment(row: AskCommentRow & { model?: string; classifiedAt?: number }): void {
    const model = row.model ?? "default";
    const classifiedAt = row.classifiedAt ?? Date.now();
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
        model,
        classifiedAt,
      );
  }

  hasComment(commentId: string): boolean {
    return (
      this.db.query("SELECT 1 FROM ask_learn_comment WHERE comment_id = ?").get(commentId) !== null
    );
  }

  updateCommentsSystem(issueKey: string, system: string): number {
    const res = this.db
      .query("UPDATE ask_learn_comment SET system = ? WHERE issue_key = ? AND system != ?")
      .run(system, issueKey, system);
    return res.changes;
  }

  ticketsOf(system: string): AskTicketRow[] {
    const rows = this.db
      .query(
        "SELECT issue_key, system, created_at, last_scanned_at FROM ask_learn_ticket WHERE system = ?",
      )
      .all(system) as Array<{
      issue_key: string;
      system: string;
      created_at: number;
      last_scanned_at: number;
    }>;
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
      .all(system) as Array<{
      comment_id: string;
      issue_key: string;
      system: string;
      created_at: number;
      needs_info: number;
      kind: string;
      items: string;
      already_in_report: number;
      model: string;
      classified_at: number;
    }>;
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
    const rows = this.db.query("SELECT DISTINCT system FROM ask_learn_ticket").all() as Array<{
      system: string;
    }>;
    return rows.map((r) => r.system);
  }
}

const openLazy = makeOpenLazyDb({ applySchema: createAskLearnSchema, onOpenError: "throw" });

export function openAskLearnStore(dbPath: string): AskLearnStore {
  return new AskLearnStore(openLazy(dbPath));
}
