/**
 * Tiểu Linh's identity copy renderer — an EXAMPLE, not library source.
 *
 * The library's identity service is copy-free: it returns structured results
 * (status + reason code + data). A bot renders the user-facing lines. These are
 * Tiểu Linh's EXACT strings, lifted verbatim from intake
 * `lib/storage/identity.service.ts`, so the shadow-parity harness (which wraps
 * the library service with this renderer) reproduces intake's asserted messages
 * byte-for-byte. Another bot writes its own renderer (or its own language).
 */
import type { IdentityCopyRenderer } from "../../src/identity";
import type {
  IdentityCheckResult,
  RegistrationResult,
  ApprovalMutationResult,
} from "../../src/identity";
import type { RelinkResult } from "../../src/identity";

/** What an approved user may now do — intake's default invite line. */
const APPROVED_INVITE = "Anh/chị có thể bắt đầu gửi yêu cầu nhé ạ.";

function who(identity?: { fullName?: string; username?: string; userId?: string }): string {
  return identity?.fullName || identity?.username || identity?.userId || "";
}

export const tieuLinhIdentityCopy: IdentityCopyRenderer = {
  check(_result: IdentityCheckResult): string {
    // intake returned the structured check result without a rendered message;
    // nothing user-facing was asserted for check, so keep it empty.
    return "";
  },

  register(result: RegistrationResult): string {
    switch (result.reason) {
      case "invalid_format":
        return (
          `❌ Name Code \`${result.nameCode ?? ""}\` không đúng định dạng.\n\n` +
          `Quy chuẩn Name Code gồm tiền tố phòng ban (2-4 chữ cái in hoa) và mã nhân sự, ví dụ:\n` +
          `• \`TE_usera\` (Teacher / Giáo viên)\n` +
          `• \`PO_userb\` (Product Owner)\n` +
          `• \`CS_thanh\` (Customer Support / Chăm sóc khách hàng)\n` +
          `• \`OP_userc\` (Operations / Vận hành)`
        );
      case "conflict":
        return (
          `⚠️ Name Code **${result.nameCode ?? ""}** đã được đăng ký bởi một tài khoản Telegram khác.\n` +
          `Nếu đây là mã của bạn, vui lòng liên hệ Quản trị viên để được hỗ trợ xác thực.`
        );
      case "auto_approved_admin":
      case "auto_approved_prefix":
      case "auto_approved_open":
        return `✅ Name Code **${result.nameCode ?? ""}** đã được xác nhận thành công! ${APPROVED_INVITE}`;
      case "pending":
      default:
        return (
          `⏳ Đã tiếp nhận đăng ký Name Code **${result.nameCode ?? ""}**.\n\n` +
          `Yêu cầu của bạn đã được gửi tới Quản trị viên phê duyệt. Hệ thống sẽ tự động thông báo ngay khi được duyệt!`
        );
    }
  },

  approve(result: ApprovalMutationResult): string {
    if (!result.success || !result.identity) {
      return `Không tìm thấy thông tin người dùng.`;
    }
    return `✅ Đã phê duyệt Name Code **${result.identity.nameCode}** cho người dùng ${who(result.identity)}.`;
  },

  reject(result: ApprovalMutationResult): string {
    if (!result.success || !result.identity) {
      return `Không tìm thấy thông tin người dùng.`;
    }
    return `❌ Đã từ chối Name Code **${result.identity.nameCode}** của người dùng ${who(result.identity)}.`;
  },

  relink(result: RelinkResult): string {
    switch (result.reason) {
      case "ok":
        return `✅ Đã cập nhật liên kết tài khoản mới cho name code **${result.identity?.nameCode ?? ""}**.`;
      case "not_found":
        return `Không tìm thấy name code cần đổi tài khoản.`;
      case "missing_new_user_id":
        return `Thiếu id tài khoản mới để đổi liên kết.`;
      case "non_numeric_new_user_id":
        return `Id tài khoản mới phải là số.`;
      case "target_is_admin":
        return `⚠️ Không thể gán name code vào một tài khoản Quản trị viên.`;
      case "unauthorized_approver":
      default:
        return `⚠️ Chỉ Admin hoặc Lead CM mới được đổi tài khoản (BOT rule 2).`;
    }
  },

  notAdmin(): string {
    return "Chỉ Quản trị viên mới thao tác được ạ.";
  },
};
