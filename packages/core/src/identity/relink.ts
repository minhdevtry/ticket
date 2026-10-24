/**
 * Relink (ticket A1): rebind a name_code to a NEW user account, preserving the
 * row and all history keyed by that name_code. This is the account-change path
 * (CM "đổi tài khoản Telegram giữ lịch sử theo mã") lifted into the library.
 *
 * NGUỒN: CM teacheragent `cm/lib/domain/teacher.ts` `relinkTeacherTelegram`
 * (~L285-360). That function carried the anti-takeover security fix: before it,
 * `approved_by` was a free string the model filled in, so typing any word
 * relinked any teacher's account to the attacker and redirected every webhook.
 *
 * THE LIBRARY FIX makes that guard un-bypassable by TYPE: the approver is not a
 * free string the service trusts, it is checked against an INJECTED predicate
 * `isAuthorizedApprover(approver) => boolean`. A bot wires its own notion of
 * "is this an admin or a lead" into that predicate; the library never relinks
 * on an unchecked string. Two further invariants from CM are kept:
 *   - never relink ONTO a protected admin id (would hand an admin's inbox away);
 *   - only a NUMERIC id may take the primary key (a username must not seize it).
 *
 * Pure: no Telegram, no env, no network. Reason codes only — caller renders copy.
 */
import type { IdentityRepository, UserIdentity } from "./repository";

export type RelinkReason =
  | "ok"
  | "not_found"
  | "missing_new_user_id"
  | "non_numeric_new_user_id"
  | "target_is_admin"
  | "unauthorized_approver";

export interface RelinkResult {
  success: boolean;
  reason: RelinkReason;
  identity?: UserIdentity;
}

export interface RelinkInput {
  /** The name_code whose account is being changed (its history is preserved). */
  nameCode: string;
  /** The new account id to bind the name_code to. */
  newUserId: string;
  /** Who is authorizing — passed to `isAuthorizedApprover`, never trusted raw. */
  approver: string;
}

export interface RelinkOptions {
  /**
   * The security gate. Returns true only for an approver the bot trusts
   * (configured admin, or a real lead in its staff table). The library NEVER
   * relinks when this returns false — this is the anti-takeover fix. It is a
   * predicate, NOT a free string, so a model-filled parameter cannot satisfy it.
   */
  isAuthorizedApprover: (approver: string) => boolean;
  /**
   * Protected admin ids. A relink whose NEW user id is one of these is refused
   * — nobody may hand a teacher's name_code (and its webhook stream) onto an
   * admin account. Compared as trimmed strings.
   */
  protectedAdminIds?: string[];
}

/**
 * Rebind `nameCode` to `newUserId` under the authorized-approver guard,
 * preserving the identity row (and all history keyed by name_code).
 */
export function relinkIdentity(
  repo: IdentityRepository,
  input: RelinkInput,
  options: RelinkOptions,
): RelinkResult {
  const nameCode = input.nameCode?.trim() ?? "";
  const newUserId = input.newUserId?.trim() ?? "";
  const approver = input.approver?.trim() ?? "";

  // 1. Authorized-approver guard FIRST — an unauthorized caller learns nothing
  //    about whether the name_code exists.
  if (!approver || !options.isAuthorizedApprover(approver)) {
    return { success: false, reason: "unauthorized_approver" };
  }

  // 2. A new account id is required.
  if (!newUserId) {
    return { success: false, reason: "missing_new_user_id" };
  }

  // 3. Never relink ONTO a protected admin id — checked before the numeric
  //    guard so an admin id of ANY form (numeric or not) is refused here.
  const protectedAdmins = new Set((options.protectedAdminIds ?? []).map((id) => String(id).trim()));
  if (protectedAdmins.has(newUserId)) {
    return { success: false, reason: "target_is_admin" };
  }

  // 4. Only a numeric id may take the primary key — a username cannot seize it.
  if (!/^\d+$/.test(newUserId)) {
    return { success: false, reason: "non_numeric_new_user_id" };
  }

  // 5. The name_code must exist.
  const existing = repo.getUserIdentityByNameCode(nameCode);
  if (!existing) {
    return { success: false, reason: "not_found" };
  }

  // 6. Rebind, preserving the row (history keyed by name_code is untouched).
  repo.relinkUserId(existing.nameCode, newUserId);
  const updated = repo.getUserIdentityByNameCode(existing.nameCode) ?? {
    ...existing,
    userId: newUserId,
  };
  return { success: true, reason: "ok", identity: updated };
}

/**
 * Thao tác ĐỔI TÀI KHOẢN trọn vẹn, nhất quán với lưu-theo-user-id (A1):
 *  1. relink định danh (name_code → user id mới) qua `relinkIdentity` (giữ
 *     nguyên guard chống chiếm danh);
 *  2. nếu relink OK, chuyển mọi BINDING ticket đang gắn user id CŨ sang user id
 *     MỚI, để tra ticket theo người (`getLatestBindingByUserId`) vẫn đúng và
 *     lịch sử ticket không mất.
 *
 * Lịch sử ticket giữ theo NGƯỜI (name_code + user id mới), không phụ thuộc tài
 * khoản Telegram cũ — đúng yêu cầu "giữ lịch sử theo mã khi đổi tài khoản".
 *
 * `bindings` tùy chọn: bot không lưu binding theo id (hoặc store không hỗ trợ
 * `rebindReporterUserId`) thì chỉ relink định danh, `reboundBindings = 0`.
 */
export interface RelinkWithBindingsResult extends RelinkResult {
  /** Số binding ticket đã chuyển sang user id mới. */
  reboundBindings: number;
}

export function relinkIdentityAndBindings(
  repo: IdentityRepository,
  bindings: { rebindReporterUserId?(oldUserId: string, newUserId: string): number } | undefined,
  input: RelinkInput,
  options: RelinkOptions,
): RelinkWithBindingsResult {
  // user id cũ của name_code này (để chuyển binding), đọc TRƯỚC khi relink.
  const before = repo.getUserIdentityByNameCode(input.nameCode?.trim() ?? "");
  const oldUserId = before?.userId;

  const result = relinkIdentity(repo, input, options);
  if (!result.success) return { ...result, reboundBindings: 0 };

  let reboundBindings = 0;
  const newUserId = input.newUserId?.trim() ?? "";
  if (bindings?.rebindReporterUserId && oldUserId && oldUserId !== newUserId) {
    reboundBindings = bindings.rebindReporterUserId(oldUserId, newUserId);
  }
  return { ...result, reboundBindings };
}
