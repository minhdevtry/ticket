import type { IdentityRepository, UserIdentity } from "../storage/identity-repository";

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
  message: string;
  reason?: "invalid_format" | "conflict" | "error";
}

export interface IdentityServiceOptions {
  adminIds?: string[];
  requireApproval?: boolean;
  /** What the user may now do, appended to the approval confirmation. */
  approvedInvite?: string;
}

const NAME_CODE_REGEX = /^[A-Z]{2,4}_[A-Za-z0-9_]+$/;

export class IdentityService {
  private readonly identityRepo: IdentityRepository;
  private readonly adminIds: Set<string>;
  private readonly requireApproval: boolean;
  private readonly approvedInvite: string;

  constructor(identityRepo: IdentityRepository, options: IdentityServiceOptions = {}) {
    this.identityRepo = identityRepo;
    this.adminIds = new Set((options.adminIds ?? []).map((id) => id.trim()));
    this.requireApproval = options.requireApproval ?? true;
    this.approvedInvite = options.approvedInvite ?? "Anh/chị có thể bắt đầu gửi yêu cầu nhé ạ.";
  }

  isAdmin(telegramUserId: string): boolean {
    return this.adminIds.has(String(telegramUserId).trim());
  }

  updateDepartment(telegramUserId: string, department: string): void {
    const tid = String(telegramUserId).trim();
    if (!tid) return;
    this.identityRepo.updateDepartment(tid, department);
  }

  validateNameCodeFormat(nameCode: string): boolean {
    return NAME_CODE_REGEX.test(nameCode.trim());
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
    // Direct match if message is just the code
    if (this.validateNameCodeFormat(this.normalizeNameCode(trimmed))) {
      return this.normalizeNameCode(trimmed);
    }

    // Match in sentences like "mã của em là TE_user_a", "TE_user_a nhé"
    const match = trimmed.match(/\b([A-Za-z]{2,4}_[A-Za-z0-9_]+)\b/);
    if (match) {
      const candidate = this.normalizeNameCode(match[1]);
      if (this.validateNameCodeFormat(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  checkUserApproval(telegramUserId: string): IdentityCheckResult {
    const tid = String(telegramUserId).trim();

    // 1. Admin always approved
    if (this.isAdmin(tid)) {
      const identity = this.identityRepo.getUserIdentity(tid);
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity?.nameCode ?? "ADMIN",
        dept: identity?.department,
        identity: identity ?? undefined,
      };
    }

    // 2. If approval is disabled globally
    if (!this.requireApproval) {
      const identity = this.identityRepo.getUserIdentity(tid);
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity?.nameCode,
        dept: identity?.department,
        identity: identity ?? undefined,
      };
    }

    // 3. Query repository
    const identity = this.identityRepo.getUserIdentity(tid);
    if (!identity) {
      return {
        isApproved: false,
        isPending: false,
        isRejected: false,
      };
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

    // Check if user's prefix is approved
    const prefix = this.extractPrefix(identity.nameCode);
    if (prefix && this.identityRepo.isPrefixApproved(prefix)) {
      // Auto-promote to approved
      this.identityRepo.approveUserIdentity(tid, "prefix_rule");
      return {
        isApproved: true,
        isPending: false,
        isRejected: false,
        nameCode: identity.nameCode,
        dept: identity.department,
        identity: {
          ...identity,
          status: "approved",
        },
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

  async registerIdentity(params: {
    telegramUserId: string;
    nameCode: string;
    fullName?: string;
    username?: string;
    pendingReport?: string;
  }): Promise<RegistrationResult> {
    const tid = String(params.telegramUserId).trim();
    const normalizedCode = this.normalizeNameCode(params.nameCode);

    if (!this.validateNameCodeFormat(normalizedCode)) {
      return {
        success: false,
        autoApproved: false,
        reason: "invalid_format",
        message:
          `❌ Name Code \`${params.nameCode}\` không đúng định dạng.\n\n` +
          `Quy chuẩn Name Code gồm tiền tố phòng ban (2-4 chữ cái in hoa) và mã nhân sự, ví dụ:\n` +
          `• \`TE_user_a\` (Teacher / Giáo viên)\n` +
          `• \`PO_user_b\` (Product Owner)\n` +
          `• \`CS_user_c\` (Customer Support / Chăm sóc khách hàng)\n` +
          `• \`OP_user_d\` (Operations / Vận hành)`,
      };
    }

    // Anti-spoofing: Check if Name Code is already bound to a different Telegram user
    const existing = this.identityRepo.getUserIdentityByNameCode(normalizedCode);
    if (existing && existing.telegramUserId !== tid) {
      return {
        success: false,
        autoApproved: false,
        reason: "conflict",
        message:
          `⚠️ Name Code **${normalizedCode}** đã được đăng ký bởi một tài khoản Telegram khác.\n` +
          `Nếu đây là mã của bạn, vui lòng liên hệ Quản trị viên để được hỗ trợ xác thực.`,
      };
    }

    const prefix = this.extractPrefix(normalizedCode);
    const prefixApproved = prefix ? this.identityRepo.isPrefixApproved(prefix) : false;
    const shouldAutoApprove =
      !this.requireApproval || this.isAdmin(tid) || prefixApproved;

    this.identityRepo.saveUserIdentity({
      telegramUserId: tid,
      nameCode: normalizedCode,
      fullName: params.fullName,
      username: params.username,
      status: shouldAutoApprove ? "approved" : "pending",
      approvedBy: shouldAutoApprove ? (this.isAdmin(tid) ? "admin" : "prefix_rule") : undefined,
      pendingReport: params.pendingReport,
    });

    if (shouldAutoApprove) {
      return {
        success: true,
        autoApproved: true,
        nameCode: normalizedCode,
        message: `✅ Name Code **${normalizedCode}** đã được xác nhận thành công! ${this.approvedInvite}`,
      };
    }

    return {
      success: true,
      autoApproved: false,
      nameCode: normalizedCode,
      message:
        `⏳ Đã tiếp nhận đăng ký Name Code **${normalizedCode}**.\n\n` +
        `Yêu cầu của bạn đã được gửi tới Quản trị viên phê duyệt. Hệ thống sẽ tự động thông báo ngay khi được duyệt!`,
    };
  }

  approveUser(
    telegramUserId: string,
    approvedBy: string,
  ): { success: boolean; identity?: UserIdentity; message: string } {
    const tid = String(telegramUserId).trim();
    const identity = this.identityRepo.getUserIdentity(tid);
    if (!identity) {
      return {
        success: false,
        message: `Không tìm thấy thông tin người dùng với ID ${tid}.`,
      };
    }

    this.identityRepo.approveUserIdentity(tid, approvedBy);

    return {
      success: true,
      identity: { ...identity, status: "approved" },
      message: `✅ Đã phê duyệt Name Code **${identity.nameCode}** cho người dùng ${identity.fullName || identity.username || tid}.`,
    };
  }

  rejectUser(
    telegramUserId: string,
  ): { success: boolean; identity?: UserIdentity; message: string } {
    const tid = String(telegramUserId).trim();
    const identity = this.identityRepo.getUserIdentity(tid);
    if (!identity) {
      return {
        success: false,
        message: `Không tìm thấy thông tin người dùng với ID ${tid}.`,
      };
    }

    this.identityRepo.rejectUserIdentity(tid);

    return {
      success: true,
      identity: { ...identity, status: "rejected" },
      message: `❌ Đã từ chối Name Code **${identity.nameCode}** của người dùng ${identity.fullName || identity.username || tid}.`,
    };
  }
}
