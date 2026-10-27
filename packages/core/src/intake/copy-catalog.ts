/**
 * A map-backed `CopyCatalog` (ticket 08). The strings themselves are a bot's
 * concern — this just resolves a key and substitutes `{named}` placeholders.
 * Tiểu Linh's own copy ships as an EXAMPLE under `examples/tieulinh/`, not here.
 */
import type { CopyCatalog, CopyKey } from "./ports";

export function makeCopyCatalog(strings: Record<CopyKey, string>): CopyCatalog {
  return {
    text(key: CopyKey, vars: Record<string, string | number> = {}): string {
      const template = strings[key];
      if (template === undefined) throw new Error(`CopyCatalog: missing key "${key}"`);
      return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
        name in vars ? String(vars[name]) : `{${name}}`,
      );
    },
  };
}

export const REQUIRED_COPY_KEYS: readonly CopyKey[] = [
  "confirm.too_soon",
  "confirm.in_progress",
  "confirm.resend",
  "ticket.created",
  "ticket.already_created",
  "ticket.create_failed",
  "ask.opening",
  "summary.confirm_hint",
  "button.confirm_create",
  "button.confirm_append",
  "button.confirm_edit",
  "button.confirm_move",
  "button.new_incident",
  "button.continue_draft",
  "button.resume_parked",
  "button.cancel_action",
  "park.identifier_conflict",
  "park.full_report",
  "park.unclear",
  "park.canceled",
  "park.reminder",
  "action.preview_append",
  "action.preview_edit",
  "action.preview_move",
  "action.done_append",
  "action.done_edit",
  "action.edit_done",
  "action.done_move",
  "action.move_done",
  "action.canceled",
  "action.edit_conflict_rejected",
  "action.edit_unclear_prompt",
  "action.clarify_empty_append",
  "action.not_owner_refusal",
  "lookup.status",
  "lookup.not_owner",
  "lookup.other_ticket_status",
  "lookup.tech_comment",
  "lookup.clarify_identifier",
  "comment.edit_trace",
  "comment.move_target_note",
  "comment.move_source_note",
  "draft.expired_new",
  "draft.canceled",
  "draft.awaiting_confirmation",
  "ask.missing_info",
  "ask.system",
  "ask.priority_reason",
  "ask.unrecognized_dept",
  "clarify.greeting",
  "ask.describe_incident",
  "ask.describe_incident_item",
  "field.unknown_value",
  "summary.priority_line",
  "ticket.fallback_title",
  "priority.level.low",
  "priority.level.medium",
  "priority.level.high",
  "priority.level.urgent",
  "split.question",
  "split.question_no_names",
  "split.unnamed_item",
  "split.unclear_prefix",
  "split.next_ticket_notice",
  "split.next_ticket_notice_student",
  "button.split_n",
  "button.merge_one",
  "media.attachments_heading",
  "media.ambiguous_notice",
  "ticket.closed_refusal",
  "ticket.chitchat_after_create",
  "ticket.cancel_hint_after_create",
  "ticket.already_created_hint",
  "action.suggest_append_lead",
  "action.suggest_conflict_lead",
  "action.suggest_unclear_prompt",
  "action.suggest_unclear_prompt_with_media",
  "clarify.new_incident_prompt",
  "action.suggest_append_preview",
  "action.suggest_append_media_note",
  "action.suggest_append_other_tickets",
  "action.priority_uplift",
  "status.closed_done",
  "status.closed_canceled",
  "comment.supplement_default_content",
  "reporter.default_name",
  "bot.default_name",
  "edit.title_label",
  "edit.description_label",
  "edit.not_present",
  "status.unknown",
  "notify.on_call_supplement",
  "button.confirm_cancel",
  "button.confirm_close",
  "button.keep_ticket",
  "action.preview_cancel_ticket",
  "action.preview_close_ticket",
  "action.cancel_close_done",
  "action.keep_ticket_done",
  "action.cannot_read_status",
  "action.label_close",
  "action.label_cancel",
  "action.draft_kept_note",
  "ticket.cancel_close_closed_refusal",
  "comment.cancel_or_close_trace",
  "action.word_close",
  "action.word_cancel",
  "action.icon_done",
  "action.icon_canceled",
  "action.state_done",
  "action.state_canceled",
  "action.column_not_found",
  "button.none",
  "checklist.header",
  "checklist.closing",
  "checklist.ask.SCREENSHOT",
  "checklist.ask.ERROR_TEXT",
  "checklist.ask.STEPS",
  "checklist.ask.EXPECTED_VS_ACTUAL",
  "checklist.ask.TIME",
  "checklist.ask.DEVICE_APP",
  "checklist.ask.STUDENT_ID",
  "checklist.ask.CARE_STUDENT_LINK",
  "checklist.ask.CRM_CONTACT_LINK",
  "checklist.ask.LMS_UID_LINK",
  "checklist.ask.ORDER_CODE",
  "checklist.ask.COURSE_CLASS_SCOPE",
  "checklist.ask.OTHER_LINK",
  "checklist.ask.EXTENT",
  "agent_instruction.wait_for_user",
  "agent_instruction.forward",
] as const;

export function validateCopyCatalog(catalog: CopyCatalog): {
  valid: boolean;
  missingKeys: CopyKey[];
} {
  const missingKeys: CopyKey[] = [];
  for (const key of REQUIRED_COPY_KEYS) {
    try {
      const val = catalog.text(key);
      if (val === undefined || val === null) {
        missingKeys.push(key);
      }
    } catch {
      missingKeys.push(key);
    }
  }
  return {
    valid: missingKeys.length === 0,
    missingKeys,
  };
}
