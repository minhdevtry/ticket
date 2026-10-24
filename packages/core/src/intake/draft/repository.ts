/**
 * Draft store (ticket 08): a revisioned aggregate over SQLite behind a
 * repository interface. The engine depends on `DraftRepository`, not on
 * bun:sqlite — tests pass either an in-memory DB or a fake implementing the
 * interface.
 *
 * NGUỒN: intake `lib/intake-document/repository.ts` —
 * `IntakeDocumentRepository.tryInsertRevision` (atomic CAS on (doc_id,
 * revision)), `saveRevision`, `getLatestByChatId` (ordered by updated_at, NOT
 * revision), `chatIdVariants`, `parseSqliteTimestamp`, `INTAKE_DRAFT_TTL_MS`.
 */
import type { Database } from "bun:sqlite";
import type { IntakeDraft } from "./types";

/** A draft left idle longer than this is stale — a later message opens a new one. */
export const INTAKE_DRAFT_TTL_MS = 24 * 3_600_000;

/**
 * Numeric chat ids reach us as `"telegram:123"` or `"123"` depending on the
 * layer. Only expand when the id is genuinely numeric (optionally prefixed), so
 * `chat_123` never matches `123`.
 */
export function chatIdVariants(chatId: string): string[] {
  const raw = String(chatId).trim();
  const m = /^(?:telegram:|tg:)?(-?\d+)$/i.exec(raw);
  if (!m) return [raw];
  return Array.from(new Set([raw, m[1], `telegram:${m[1]}`]));
}

/** SQLite `updated_at` is "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
export function parseSqliteTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export interface DraftRepository {
  /** Upsert a revision (overwrites if the (docId, revision) row already exists). */
  saveRevision(draft: IntakeDraft): void;
  /**
   * Atomic compare-and-set: write this revision ONLY if nobody else has. Two
   * concurrent confirm-clicks both read revision N and try to write N+1; only
   * one `INSERT OR IGNORE` changes a row, so only one wins. Returns true for
   * the winner. This is the cross-process guard the in-process lock cannot give.
   */
  tryInsertRevision(draft: IntakeDraft): boolean;
  /** Most recently WRITTEN revision for a chat (ordered by updated_at, then rowid). */
  getLatestByChatId(chatId: string): IntakeDraft | null;
  getByDocId(docId: string, revision?: number): IntakeDraft | null;
}

export class SqliteDraftRepository implements DraftRepository {
  constructor(private readonly db: Database) {}

  saveRevision(draft: IntakeDraft): void {
    this.db
      .prepare(
        `INSERT INTO intake_documents (doc_id, chat_id, revision, status, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(doc_id, revision) DO UPDATE SET
           status = excluded.status,
           state_json = excluded.state_json,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(draft.docId, draft.chatId, draft.revision, draft.status, JSON.stringify(draft));
  }

  tryInsertRevision(draft: IntakeDraft): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO intake_documents (doc_id, chat_id, revision, status, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(draft.docId, draft.chatId, draft.revision, draft.status, JSON.stringify(draft));
    return res.changes === 1;
  }

  getLatestByChatId(chatId: string): IntakeDraft | null {
    const keys = chatIdVariants(chatId);
    const row = this.db
      .prepare(
        `SELECT state_json FROM intake_documents
         WHERE chat_id IN (${keys.map(() => "?").join(", ")})
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(...keys) as { state_json: string } | null;
    return row ? safeParse(row.state_json) : null;
  }

  getByDocId(docId: string, revision?: number): IntakeDraft | null {
    const row = (
      revision !== undefined
        ? this.db
            .prepare(`SELECT state_json FROM intake_documents WHERE doc_id = ? AND revision = ?`)
            .get(docId, revision)
        : this.db
            .prepare(
              `SELECT state_json FROM intake_documents WHERE doc_id = ? ORDER BY revision DESC LIMIT 1`,
            )
            .get(docId)
    ) as { state_json: string } | null;
    return row ? safeParse(row.state_json) : null;
  }
}

function safeParse(json: string): IntakeDraft | null {
  try {
    return JSON.parse(json) as IntakeDraft;
  } catch {
    return null;
  }
}

/** True if a draft has been idle longer than its TTL and should be reopened fresh. */
export function isExpiredDraft(
  draft: IntakeDraft,
  now: number,
  ttlMs = INTAKE_DRAFT_TTL_MS,
): boolean {
  const updated = Date.parse(draft.updatedAt);
  if (Number.isNaN(updated)) return false;
  return now - updated > ttlMs;
}
