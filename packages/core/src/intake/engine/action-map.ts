/**
 * Ánh xạ giữa `action` của hợp đồng `intake_step` (legacy) và `StepOutcome` của
 * engine (RFC 0002 mục 2.3, PR 4).
 *
 * Persona và skill OpenClaw của Tiểu Linh phụ thuộc vào TÊN `action` của
 * `intake_step`, nên hợp đồng đó phải giữ nguyên ở mọi harness. Engine có bộ
 * kết quả riêng (`StepOutcome`), nên cần một bảng ánh xạ DUY NHẤT để tên
 * legacy và tên engine không trôi lệch nhau.
 *
 * Chiều `legacy → outcome` là nhiều-một: một `action` của legacy có thể do
 * nhiều kết quả của engine đảm nhiệm (ví dụ `post_create_update` vừa là
 * `action_done` vừa là `not_owner` vừa là `closed_refusal`). Chiều ngược lấy
 * `action` ĐẦU TIÊN của danh sách — là `action` đại diện.
 *
 * NGUỒN: `docs/rfc/0002-receptionist.md` mục 2.3; legacy
 * `mcp/tieulinh/tools/intake-step.ts` (tập `action` mà tool trả về).
 */
import type { StepOutcome } from "./types";

/** Tên `action` của hợp đồng `intake_step` (legacy) — danh sách đóng. */
export const LEGACY_INTAKE_ACTIONS = [
  "ask_missing_field",
  "clarify_intent",
  "confirm_summary",
  "awaiting_user_confirmation",
  "ask_new_or_continue",
  "ask_split_or_merge",
  "confirm_ticket_action",
  "ticket_created",
  "post_create_update",
  "lookup_result",
  "already_created",
  "canceled",
  "create_failed",
  "in_progress",
] as const;

export type LegacyIntakeAction = (typeof LEGACY_INTAKE_ACTIONS)[number];

/**
 * Bảng ánh xạ `action` của legacy → các `StepOutcome` của engine đảm nhiệm.
 * Thứ tự trong mỗi danh sách: `action` đại diện đứng đầu.
 */
export const ACTION_OUTCOMES: Record<LegacyIntakeAction, readonly StepOutcome[]> = {
  ask_missing_field: ["asked"],
  clarify_intent: ["clarify"],
  confirm_summary: ["summary"],
  awaiting_user_confirmation: ["too_soon"],
  ask_new_or_continue: ["parked"],
  ask_split_or_merge: ["split_question"],
  confirm_ticket_action: ["action_preview"],
  ticket_created: ["created"],
  post_create_update: ["action_done", "not_owner", "closed_refusal"],
  lookup_result: ["lookup"],
  already_created: ["already_created"],
  canceled: ["action_canceled", "canceled"],
  create_failed: ["failed"],
  in_progress: ["in_progress"],
};

/**
 * Chiều ngược: `StepOutcome` → `action` của legacy mang nó.
 * `needs_resend` và `chitchat` là kết quả CHỈ có ở core (legacy không có) nên
 * không ánh xạ.
 */
export const LEGACY_ACTION_BY_OUTCOME: Partial<Record<StepOutcome, LegacyIntakeAction>> =
  Object.fromEntries(
    (
      Object.entries(ACTION_OUTCOMES) as Array<[LegacyIntakeAction, readonly StepOutcome[]]>
    ).flatMap(([action, outcomes]) => outcomes.map((outcome) => [outcome, action])),
  ) as Partial<Record<StepOutcome, LegacyIntakeAction>>;

/** Các kết quả của engine đảm nhiệm một `action` của legacy. */
export function outcomesForLegacyAction(action: LegacyIntakeAction): readonly StepOutcome[] {
  return ACTION_OUTCOMES[action] ?? [];
}

/** `action` của legacy đại diện cho một kết quả của engine. */
export function legacyActionForOutcome(outcome: StepOutcome): LegacyIntakeAction | null {
  return LEGACY_ACTION_BY_OUTCOME[outcome] ?? null;
}
