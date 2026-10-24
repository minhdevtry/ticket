/**
 * Identity store (ticket A1): user_identities + approved_prefixes behind a
 * repository port, with a LIBRARY-OWNED schema applied through core's lazy-db
 * `applySchema` hook (draft-store style). The service depends on
 * `IdentityRepository`, not on bun:sqlite — tests pass either an in-memory DB
 * or a fake implementing the port.
 *
 * NGUỒN: intake `lib/storage/identity-repository.ts` (the whole
 * `IdentityRepository` surface) and the `user_identities` / `approved_prefixes`
 * DDL from intake `lib/storage/schema.ts`.
 *
 * ONE DELIBERATE CHANGE vs intake: the per-user key `telegramUserId` is renamed
 * to the channel-neutral `userId`. The library serves bots on channels other
 * than Telegram; for a Telegram bot this value IS the telegram user id. The
 * SQLite column keeps the historic name `telegram_user_id` so the schema stays
 * byte-identical to intake's and a bot's existing database needs no migration —
 * only the TypeScript field changed.
 */
import type { Database } from "bun:sqlite";

export type IdentityStatus = "pending" | "approved" | "rejected";

/**
 * A registered user identity.
 *
 * `userId` is the channel-neutral per-user key (for a Telegram bot = the
 * telegram user id). Stored in the `telegram_user_id` column (intake-compatible).
 */
export interface UserIdentity {
  userId: string;
  nameCode: string;
  fullName?: string;
  username?: string;
  status: IdentityStatus;
  approvedBy?: string;
  pendingReport?: string;
  department?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The persistence surface the identity service needs. Tests pass a fake. */
export interface IdentityRepository {
  getUserIdentity(userId: string): UserIdentity | null;
  getUserIdentityByNameCode(nameCode: string): UserIdentity | null;
  /**
   * Upsert. Chuỗi RỖNG coi như "không có" (`||`, như intake): không ghi đè
   * `fullName`/`username`/`pendingReport`... đã lưu bằng chuỗi rỗng.
   */
  saveUserIdentity(identity: {
    userId: string;
    nameCode: string;
    fullName?: string;
    username?: string;
    status?: IdentityStatus;
    approvedBy?: string;
    pendingReport?: string;
    department?: string;
  }): void;
  updateDepartment(userId: string, department: string): void;
  approveUserIdentity(userId: string, approvedBy: string): void;
  rejectUserIdentity(userId: string): void;
  savePendingReport(userId: string, reportJson: string): void;
  getPendingReport(userId: string): string | null;
  clearPendingReport(userId: string): void;
  isPrefixApproved(prefix: string): boolean;
  approvePrefix(prefix: string, approvedBy: string): void;
  listPendingIdentities(): UserIdentity[];
  /**
   * Rebind an existing name_code to a new userId, preserving the row (and so
   * all history keyed by name_code). The caller — relink.ts — enforces the
   * security guard; the repository only performs the write. Returns true if a
   * row was moved.
   */
  relinkUserId(nameCode: string, newUserId: string): boolean;
}

// ── library-owned schema ──────────────────────────────────────────────────────

/**
 * The identity schema owned by this library. Column names match intake's
 * `user_identities` / `approved_prefixes` verbatim so an existing bot DB is
 * compatible with no migration (ticket requirement: keep intake columns).
 */
export const IDENTITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS user_identities (
     telegram_user_id TEXT PRIMARY KEY,
     name_code TEXT NOT NULL UNIQUE,
     full_name TEXT,
     username TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     approved_by TEXT,
     pending_report TEXT,
     department TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS approved_prefixes (
     prefix TEXT PRIMARY KEY,
     approved_by TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_identities_status ON user_identities (status, updated_at DESC)`,
];

/**
 * Apply the identity schema. Shape matches core's `ApplySchema`
 * `(db, { wal }) => void`, so it passes straight into `makeOpenLazyDb`.
 */
export function identityApplySchema(db: Database, opts: { wal: boolean } = { wal: false }): void {
  if (opts.wal) {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
  }
  for (const statement of IDENTITY_SCHEMA) db.run(statement);
}

// ── bun:sqlite implementation ──────────────────────────────────────────────────

const SELECT_COLS =
  "telegram_user_id, name_code, full_name, username, status, approved_by, pending_report, department, created_at, updated_at";

function rowToIdentity(row: any): UserIdentity {
  return {
    userId: row.telegram_user_id,
    nameCode: row.name_code,
    fullName: row.full_name ?? undefined,
    username: row.username ?? undefined,
    status: row.status as IdentityStatus,
    approvedBy: row.approved_by ?? undefined,
    pendingReport: row.pending_report ?? undefined,
    department: row.department ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Database) {}

  getUserIdentity(userId: string): UserIdentity | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM user_identities WHERE telegram_user_id = ?`)
      .get(userId) as any;
    return row ? rowToIdentity(row) : null;
  }

  getUserIdentityByNameCode(nameCode: string): UserIdentity | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM user_identities WHERE UPPER(name_code) = UPPER(?)`)
      .get(nameCode) as any;
    return row ? rowToIdentity(row) : null;
  }

  saveUserIdentity(identity: {
    userId: string;
    nameCode: string;
    fullName?: string;
    username?: string;
    status?: IdentityStatus;
    approvedBy?: string;
    pendingReport?: string;
    department?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO user_identities (
           telegram_user_id, name_code, full_name, username, status, approved_by, pending_report, department, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           name_code = excluded.name_code,
           full_name = COALESCE(excluded.full_name, user_identities.full_name),
           username = COALESCE(excluded.username, user_identities.username),
           status = COALESCE(excluded.status, user_identities.status),
           approved_by = COALESCE(excluded.approved_by, user_identities.approved_by),
           pending_report = COALESCE(excluded.pending_report, user_identities.pending_report),
           department = COALESCE(excluded.department, user_identities.department),
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(
        identity.userId,
        identity.nameCode,
        identity.fullName || null,
        identity.username || null,
        identity.status || "pending",
        identity.approvedBy || null,
        identity.pendingReport || null,
        identity.department || null,
      );
  }

  updateDepartment(userId: string, department: string): void {
    this.db
      .prepare(
        `UPDATE user_identities SET department = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`,
      )
      .run(department, userId);
  }

  approveUserIdentity(userId: string, approvedBy: string): void {
    this.db
      .prepare(
        `UPDATE user_identities SET status = 'approved', approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`,
      )
      .run(approvedBy, userId);
  }

  rejectUserIdentity(userId: string): void {
    this.db
      .prepare(
        `UPDATE user_identities SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`,
      )
      .run(userId);
  }

  savePendingReport(userId: string, reportJson: string): void {
    this.db
      .prepare(
        `UPDATE user_identities SET pending_report = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`,
      )
      .run(reportJson, userId);
  }

  getPendingReport(userId: string): string | null {
    return this.getUserIdentity(userId)?.pendingReport ?? null;
  }

  clearPendingReport(userId: string): void {
    this.db
      .prepare(
        `UPDATE user_identities SET pending_report = NULL, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?`,
      )
      .run(userId);
  }

  isPrefixApproved(prefix: string): boolean {
    const row = this.db
      .prepare(`SELECT prefix FROM approved_prefixes WHERE UPPER(prefix) = UPPER(?)`)
      .get(prefix);
    return !!row;
  }

  approvePrefix(prefix: string, approvedBy: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO approved_prefixes (prefix, approved_by) VALUES (?, ?)`)
      .run(prefix.toUpperCase(), approvedBy);
  }

  listPendingIdentities(): UserIdentity[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLS} FROM user_identities WHERE status = 'pending' ORDER BY updated_at DESC`,
      )
      .all() as any[];
    return rows.map(rowToIdentity);
  }

  relinkUserId(nameCode: string, newUserId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE user_identities SET telegram_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE UPPER(name_code) = UPPER(?)`,
      )
      .run(newUserId, nameCode);
    return res.changes === 1;
  }
}
