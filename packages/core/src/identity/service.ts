/**
 * Identity service (ticket A1): the register / approve / reject lifecycle plus
 * approval checking, name-code validation and extraction. Pure domain logic —
 * no Telegram, no OpenClaw, no process.env, no network.
 *
 * NGUỒN: intake `lib/storage/identity.service.ts` (`IdentityService`:
 * checkUserApproval, registerIdentity, approveUser, rejectUser,
 * validateNameCodeFormat, extractPrefix, normalizeNameCode,
 * extractNameCodeFromText).
 *
 * CRITICAL CHANGE vs intake: the intake service baked Vietnamese strings into
 * every result (`message: "❌ Name Code ... không đúng định dạng"`). Here the
 * logic returns ONLY a structured result — a status plus a machine-readable
 * `reason` code and the data behind it. The CALLER renders user-facing copy
 * (see examples/tieulinh/identity-copy.ts for Tiểu Linh's exact strings). This
 * keeps the library channel- and language-neutral.
 */
import type { IdentityRepository, UserIdentity } from "./repository";

/** Default name-code shape: a 2-4 letter uppercase prefix, `_`, then an id. */
export const NAME_CODE_REGEX = /^[A-Z]{2,4}_[A-Za-z0-9_]+$/;

/** Why a registration was refused or how it resolved — machine-readable, no copy. */
export type RegistrationReason =
  | "invalid_format"
  | "conflict"
  | "auto_approved_admin"
  | "auto_approved_prefix"
  | "auto_approved_open"
  | "pending";

export interface IdentityCheckResult {
  isApproved: boolean;
  isPending: boolean;
  isRejected: boolean;
  nameCode?: string;
  dept?: string;
  identity?: UserIdentity;
}

export interface RegistrationResult {
  success: boolean;
  autoApproved: boolean;
  nameCode?: string;
  /** Machine-readable reason; the caller maps it to user copy. */
  reason: RegistrationReason;
}

export interface ApprovalMutationResult {
  success: boolean;
  identity?: UserIdentity;
  /** Set when success is false: why. No user copy. */
  reason?: "not_found";
}

export interface IdentityServiceOptions {
  adminIds?: string[];
  requireApproval?: boolean;
  /**
   * The name-code shape. Defaults to intake's `NAME_CODE_REGEX`. A bot with a
   * different convention passes its own pattern; the prefix extractor still
   * splits on the first `_`.
   */
  nameCodePattern?: RegExp;
}

export class IdentityService {
  private readonly repo: IdentityRepository;
  private readonly adminIds: Set<string>;
  private readonly requireApproval: boolean;
  private readonly nameCodePattern: RegExp;

  constructor(repo: IdentityRepository, options: IdentityServiceOptions = {}) {
    this.repo = repo;
    this.adminIds = new Set((options.adminIds ?? []).map((id) => id.trim()));
    this.requireApproval = options.requireApproval ?? false;
    this.nameCodePattern = options.nameCodePattern ?? NAME_CODE_REGEX;
  }

  isAdmin(userId: string): boolean {
    return this.adminIds.has(String(userId).trim());
  }

  updateDepartment(userId: string, department: string): void {
    const uid = String(userId).trim();
    if (!uid) return;
    this.repo.updateDepartment(uid, department);
  }

  validateNameCodeFormat(nameCode: string): boolean {
    return this.nameCodePattern.test(nameCode.trim());
  }

  extractPrefix(nameCode: string): string {
    const idx = nameCode.indexOf("_");
    return idx > 0 ? nameCode.substring(0, idx).toUpperCase() : "";
  }

  normalizeNameCode(raw: string): string {
    const cleaned = raw.trim().replace(/^@/, "");
    const idx = cleaned.indexOf("_");
    if (idx <= 0) return cleaned;
    const prefix = cleaned.substring(0, idx).toUpperCase();
    const suffix = cleaned.substring(idx + 1);
    return `${prefix}_${suffix}`;
  }

  extractNameCodeFromText(text: string): string | null {
    const trimmed = text.trim();
    if (this.validateNameCodeFormat(this.normalizeNameCode(trimmed))) {
      return this.normalizeNameCode(trimmed);
    }
    const match = trimmed.match(/\b([A-Za-z]{2,4}_[A-Za-z0-9_]+)\b/);
    if (match) {
      const candidate = this.normalizeNameCode(match[1]);
      if (this.validateNameCodeFormat(candidate)) return candidate;
    }
    return null;
  }

  checkUserApproval(userId: string): IdentityCheckResult {
    const uid = String(userId).trim();

    // 1. Admin always approved.
    if (this.isAdmin(uid)) {
      const identity = this.repo.getUserIdentity(uid);
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity?.nameCode ?? "ADMIN",
        dept: identity?.department,
        identity: identity ?? undefined,
      };
    }

    // 2. Approval disabled globally — everyone passes.
    if (!this.requireApproval) {
      const identity = this.repo.getUserIdentity(uid);
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity?.nameCode,
        dept: identity?.department,
        identity: identity ?? undefined,
      };
    }

    // 3. Look up the stored identity.
    const identity = this.repo.getUserIdentity(uid);
    if (!identity) {
      return { isApproved: false, isPending: false, isRejected: false };
    }

    if (identity.status === "approved") {
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity.nameCode,
        dept: identity.department,
        identity,
      };
    }

    // Prefix auto-promote: a pending user whose prefix is now approved is
    // promoted on the spot. (Checked before the rejected branch so a prefix
    // approval un-sticks a user, matching intake.)
    const prefix = this.extractPrefix(identity.nameCode);
    if (identity.status !== "rejected" && prefix && this.repo.isPrefixApproved(prefix)) {
      this.repo.approveUserIdentity(uid, "prefix_rule");
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity.nameCode,
        dept: identity.department,
        identity: { ...identity, status: "approved", approvedBy: "prefix_rule" },
      };
    }

    if (identity.status === "rejected") {
      return {
        isApproved: false,
        isPending: false,
        isRejected: true,
        nameCode: identity.nameCode,
        identity,
      };
    }

    return {
      isApproved: false,
      isPending: true,
      isRejected: false,
      nameCode: identity.nameCode,
      identity,
    };
  }

  registerIdentity(params: {
    userId: string;
    nameCode: string;
    fullName?: string;
    username?: string;
    pendingReport?: string;
  }): RegistrationResult {
    const uid = String(params.userId).trim();
    const normalizedCode = this.normalizeNameCode(params.nameCode);

    if (!this.validateNameCodeFormat(normalizedCode)) {
      return { success: false, autoApproved: false, reason: "invalid_format" };
    }

    // Anti-spoof: the code is already bound to a DIFFERENT user.
    const existing = this.repo.getUserIdentityByNameCode(normalizedCode);
    if (existing && existing.userId !== uid) {
      return { success: false, autoApproved: false, reason: "conflict" };
    }

    const prefix = this.extractPrefix(normalizedCode);
    const prefixApproved = prefix ? this.repo.isPrefixApproved(prefix) : false;
    const isAdmin = this.isAdmin(uid);
    const shouldAutoApprove = !this.requireApproval || isAdmin || prefixApproved;

    this.repo.saveUserIdentity({
      userId: uid,
      nameCode: normalizedCode,
      fullName: params.fullName,
      username: params.username,
      status: shouldAutoApprove ? "approved" : "pending",
      approvedBy: shouldAutoApprove
        ? isAdmin
          ? "admin"
          : prefixApproved
            ? "prefix_rule"
            : "open"
        : undefined,
      pendingReport: params.pendingReport,
    });

    if (shouldAutoApprove) {
      const reason: RegistrationReason = isAdmin
        ? "auto_approved_admin"
        : prefixApproved
          ? "auto_approved_prefix"
          : "auto_approved_open";
      return { success: true, autoApproved: true, nameCode: normalizedCode, reason };
    }

    return { success: true, autoApproved: false, nameCode: normalizedCode, reason: "pending" };
  }

  approveUser(userId: string, approvedBy: string): ApprovalMutationResult {
    const uid = String(userId).trim();
    const identity = this.repo.getUserIdentity(uid);
    if (!identity) return { success: false, reason: "not_found" };
    this.repo.approveUserIdentity(uid, approvedBy);
    return { success: true, identity: { ...identity, status: "approved", approvedBy } };
  }

  rejectUser(userId: string): ApprovalMutationResult {
    const uid = String(userId).trim();
    const identity = this.repo.getUserIdentity(uid);
    if (!identity) return { success: false, reason: "not_found" };
    this.repo.rejectUserIdentity(uid);
    return { success: true, identity: { ...identity, status: "rejected" } };
  }
}
