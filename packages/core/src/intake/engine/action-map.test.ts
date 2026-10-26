/**
 * Bảng ánh xạ `action` của hợp đồng `intake_step` (legacy) ↔ `StepOutcome` của
 * engine (RFC 0002 mục 2.3).
 *
 * MỖI DÒNG của bảng trong RFC là MỘT test case. Hợp đồng `action` phải giữ
 * nguyên ở mọi harness vì persona và skill OpenClaw phụ thuộc vào tên đó.
 */
import { describe, expect, test } from "bun:test";
import {
  ACTION_OUTCOMES,
  LEGACY_ACTION_BY_OUTCOME,
  LEGACY_INTAKE_ACTIONS,
  legacyActionForOutcome,
  outcomesForLegacyAction,
  type LegacyIntakeAction,
} from "./action-map";
import type { StepOutcome } from "./types";

describe("bảng ánh xạ action của legacy → StepOutcome (mục 2.3)", () => {
  test("ask_missing_field → asked", () => {
    expect(outcomesForLegacyAction("ask_missing_field")).toEqual(["asked"]);
  });

  test("clarify_intent → clarify", () => {
    expect(outcomesForLegacyAction("clarify_intent")).toEqual(["clarify"]);
  });

  test("confirm_summary → summary", () => {
    expect(outcomesForLegacyAction("confirm_summary")).toEqual(["summary"]);
  });

  test("awaiting_user_confirmation → too_soon", () => {
    expect(outcomesForLegacyAction("awaiting_user_confirmation")).toEqual(["too_soon"]);
  });

  test("ask_new_or_continue → parked", () => {
    expect(outcomesForLegacyAction("ask_new_or_continue")).toEqual(["parked"]);
  });

  test("ask_split_or_merge → split_question", () => {
    expect(outcomesForLegacyAction("ask_split_or_merge")).toEqual(["split_question"]);
  });

  test("confirm_ticket_action → action_preview", () => {
    expect(outcomesForLegacyAction("confirm_ticket_action")).toEqual(["action_preview"]);
  });

  test("ticket_created → created", () => {
    expect(outcomesForLegacyAction("ticket_created")).toEqual(["created"]);
  });

  test("post_create_update → action_done, not_owner, closed_refusal", () => {
    expect(outcomesForLegacyAction("post_create_update")).toEqual([
      "action_done",
      "not_owner",
      "closed_refusal",
    ]);
  });

  test("lookup_result → lookup", () => {
    expect(outcomesForLegacyAction("lookup_result")).toEqual(["lookup"]);
  });

  test("already_created → already_created", () => {
    expect(outcomesForLegacyAction("already_created")).toEqual(["already_created"]);
  });

  test("canceled → action_canceled, canceled", () => {
    expect(outcomesForLegacyAction("canceled")).toEqual(["action_canceled", "canceled"]);
  });

  test("create_failed → failed", () => {
    expect(outcomesForLegacyAction("create_failed")).toEqual(["failed"]);
  });

  test("in_progress → in_progress", () => {
    expect(outcomesForLegacyAction("in_progress")).toEqual(["in_progress"]);
  });
});

describe("bảng ánh xạ — tính toàn vẹn", () => {
  test("mỗi action của legacy có đúng một hàng trong bảng", () => {
    for (const action of LEGACY_INTAKE_ACTIONS) {
      expect(ACTION_OUTCOMES[action].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ACTION_OUTCOMES).sort()).toEqual([...LEGACY_INTAKE_ACTIONS].sort());
  });

  test("chiều ngược lấy action của legacy mang kết quả đó", () => {
    expect(legacyActionForOutcome("asked")).toBe("ask_missing_field");
    expect(legacyActionForOutcome("action_done")).toBe("post_create_update");
    expect(legacyActionForOutcome("not_owner")).toBe("post_create_update");
    expect(legacyActionForOutcome("closed_refusal")).toBe("post_create_update");
    expect(legacyActionForOutcome("canceled")).toBe("canceled");
    expect(legacyActionForOutcome("action_canceled")).toBe("canceled");
  });

  test("mọi kết quả của engine đều tìm được action, trừ kết quả chỉ có ở core", () => {
    const coreOnly: StepOutcome[] = ["needs_resend", "chitchat"];
    for (const [outcome, action] of Object.entries(LEGACY_ACTION_BY_OUTCOME)) {
      expect(outcomesForLegacyAction(action as LegacyIntakeAction)).toContain(
        outcome as StepOutcome,
      );
    }
    for (const outcome of coreOnly) {
      expect(legacyActionForOutcome(outcome)).toBeNull();
    }
  });
});
