import type { Database } from "bun:sqlite";

export type IdentityStatus = "pending" | "approved" | "rejected";

export interface UserIdentity {
  telegramUserId: string;
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

export class IdentityRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getUserIdentity(telegramUserId: string): UserIdentity | null {
    const stmt = this.db.prepare(`
      SELECT telegram_user_id, name_code, full_name, username, status, approved_by, pending_report, department, created_at, updated_at
      FROM user_identities
      WHERE telegram_user_id = ?
    `);
    const row = stmt.get(telegramUserId) as any;
    if (!row) return null;

    return {
      telegramUserId: row.telegram_user_id,
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

  getUserIdentityByNameCode(nameCode: string): UserIdentity | null {
    const stmt = this.db.prepare(`
      SELECT telegram_user_id, name_code, full_name, username, status, approved_by, pending_report, department, created_at, updated_at
      FROM user_identities
      WHERE UPPER(name_code) = UPPER(?)
    `);
    const row = stmt.get(nameCode) as any;
    if (!row) return null;

    return {
      telegramUserId: row.telegram_user_id,
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

  saveUserIdentity(identity: {
    telegramUserId: string;
    nameCode: string;
    fullName?: string;
    username?: string;
    status?: IdentityStatus;
    approvedBy?: string;
    pendingReport?: string;
    department?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO user_identities (
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
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      identity.telegramUserId,
      identity.nameCode,
      identity.fullName || null,
      identity.username || null,
      identity.status || "pending",
      identity.approvedBy || null,
      identity.pendingReport || null,
      identity.department || null,
    );
  }

  updateDepartment(telegramUserId: string, department: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_identities
      SET department = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `);
    stmt.run(department, telegramUserId);
  }

  approveUserIdentity(telegramUserId: string, approvedBy: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_identities
      SET status = 'approved', approved_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `);
    stmt.run(approvedBy, telegramUserId);
  }

  rejectUserIdentity(telegramUserId: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_identities
      SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `);
    stmt.run(telegramUserId);
  }

  savePendingReport(telegramUserId: string, reportJson: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_identities
      SET pending_report = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `);
    stmt.run(reportJson, telegramUserId);
  }

  getPendingReport(telegramUserId: string): string | null {
    const identity = this.getUserIdentity(telegramUserId);
    return identity?.pendingReport ?? null;
  }

  clearPendingReport(telegramUserId: string): void {
    const stmt = this.db.prepare(`
      UPDATE user_identities
      SET pending_report = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `);
    stmt.run(telegramUserId);
  }

  isPrefixApproved(prefix: string): boolean {
    const stmt = this.db.prepare(`
      SELECT prefix FROM approved_prefixes WHERE UPPER(prefix) = UPPER(?)
    `);
    const row = stmt.get(prefix);
    return !!row;
  }

  approvePrefix(prefix: string, approvedBy: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO approved_prefixes (prefix, approved_by)
      VALUES (?, ?)
    `);
    stmt.run(prefix.toUpperCase(), approvedBy);
  }

  listPendingIdentities(): UserIdentity[] {
    const stmt = this.db.prepare(`
      SELECT telegram_user_id, name_code, full_name, username, status, approved_by, pending_report, created_at, updated_at
      FROM user_identities
      WHERE status = 'pending'
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      telegramUserId: row.telegram_user_id,
      nameCode: row.name_code,
      fullName: row.full_name ?? undefined,
      username: row.username ?? undefined,
      status: row.status as IdentityStatus,
      approvedBy: row.approved_by ?? undefined,
      pendingReport: row.pending_report ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
