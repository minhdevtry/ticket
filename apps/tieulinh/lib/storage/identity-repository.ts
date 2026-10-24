/**
 * Adapter mỏng trên `SqliteIdentityRepository` của `@vuihoc/bot-core/identity`.
 *
 * Thư viện đặt khoá người dùng là `userId` (trung lập kênh); Tiểu Linh là bot
 * Telegram nên toàn bộ code và test của nó dùng `telegramUserId`. Lớp này chỉ
 * đổi tên trường hai chiều ở biên — logic và schema (`user_identities`,
 * `approved_prefixes`, cột `telegram_user_id`) là của thư viện, không đổi.
 */
import type { Database } from "bun:sqlite";
import {
  type IdentityStatus,
  SqliteIdentityRepository,
  type UserIdentity as LibUserIdentity,
} from "@vuihoc/bot-core/identity";

export type { IdentityStatus };

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

function toLegacy(u: LibUserIdentity | null): UserIdentity | null {
  if (!u) return null;
  const { userId, ...rest } = u;
  return { telegramUserId: userId, ...rest };
}

export class IdentityRepository {
  private readonly inner: SqliteIdentityRepository;

  constructor(db: Database) {
    this.inner = new SqliteIdentityRepository(db);
  }

  getUserIdentity(telegramUserId: string): UserIdentity | null {
    return toLegacy(this.inner.getUserIdentity(telegramUserId));
  }

  getUserIdentityByNameCode(nameCode: string): UserIdentity | null {
    return toLegacy(this.inner.getUserIdentityByNameCode(nameCode));
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
    const { telegramUserId, ...rest } = identity;
    this.inner.saveUserIdentity({ userId: telegramUserId, ...rest });
  }

  updateDepartment(telegramUserId: string, department: string): void {
    this.inner.updateDepartment(telegramUserId, department);
  }

  approveUserIdentity(telegramUserId: string, approvedBy: string): void {
    this.inner.approveUserIdentity(telegramUserId, approvedBy);
  }

  rejectUserIdentity(telegramUserId: string): void {
    this.inner.rejectUserIdentity(telegramUserId);
  }

  savePendingReport(telegramUserId: string, reportJson: string): void {
    this.inner.savePendingReport(telegramUserId, reportJson);
  }

  getPendingReport(telegramUserId: string): string | null {
    return this.inner.getPendingReport(telegramUserId);
  }

  clearPendingReport(telegramUserId: string): void {
    this.inner.clearPendingReport(telegramUserId);
  }

  isPrefixApproved(prefix: string): boolean {
    return this.inner.isPrefixApproved(prefix);
  }

  approvePrefix(prefix: string, approvedBy: string): void {
    this.inner.approvePrefix(prefix, approvedBy);
  }

  listPendingIdentities(): UserIdentity[] {
    return this.inner.listPendingIdentities().map((u) => toLegacy(u) as UserIdentity);
  }
}
