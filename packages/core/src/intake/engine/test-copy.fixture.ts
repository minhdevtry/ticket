/**
 * A full English `Record<CopyKey, string>` for tests. The library carries NO
 * Vietnamese literal; tests assert on these neutral English strings, and the
 * Tiểu Linh Vietnamese copy lives in `examples/tieulinh/`.
 *
 * Every key is present so a missing-key regression is a compile error, not a
 * mid-test throw.
 */
import type { CopyKey } from "../ports";

export const TEST_COPY: Record<CopyKey, string> = {
  // ticket 08
  "confirm.too_soon": "too soon",
  "confirm.in_progress": "in progress",
  "confirm.resend": "please resend",
  "ticket.created": "created {identifier} {url}",
  "ticket.already_created": "already {identifier}",
  "ticket.create_failed": "failed",
  // ticket 09
  "ask.opening": "What's the problem?",
  "summary.confirm_hint": "Press the button to confirm.",
  "button.confirm_create": "Confirm, create ticket",
  "button.confirm_append": "Confirm append to {identifier}",
  "button.confirm_edit": "Confirm edit {identifier}",
  "button.confirm_move": "Confirm move to {identifier}",
  "button.new_incident": "New incident",
  "button.continue_draft": "Add to current draft",
  "button.resume_parked": "Resume the parked draft",
  "button.cancel_action": "Cancel",
  "park.identifier_conflict": "New incident or append to the current one?",
  "park.full_report": "New incident or append to the current one?",
  "park.unclear":
    'Please press either "New incident" or "Add to current draft" above; I didn\'t catch that.',
  "park.canceled": "Discarded the held message. Incident «{title}» is still waiting.",
  "park.reminder": " There is also an earlier incident «{title}» waiting to be confirmed.",
  "action.preview_append": "Append to {identifier}: {content}",
  "action.preview_edit": "Edit {identifier}: {changes}",
  "action.preview_move": "Move {from} into {identifier}",
  "action.done_append": "Appended to {identifier}",
  "action.done_edit": "Edited {identifier}",
  "action.edit_done": "Edited {identifier}",
  "action.done_move": "Moved {from} into {identifier}",
  "action.move_done": "Moved {from} into {identifier}",
  "action.canceled": "Canceled {identifier}",
  "action.edit_conflict_rejected": "Conflict: {identifier} was updated elsewhere; please retry.",
  "action.edit_unclear_prompt": "Unclear what to edit in {identifier}.",
  "action.clarify_empty_append": "Please provide screenshot or content to append to {identifier}.",
  "action.not_owner_refusal": "Not your ticket {identifier}.",
  "lookup.status": "{identifier} «{title}» status: {status}",
  "lookup.not_owner": "{identifier} belongs to someone else; status only",
  "lookup.other_ticket_status": "{identifier} status: {status}",
  "lookup.tech_comment": '\nLatest tech exchange: "{comment}"',
  "lookup.clarify_identifier": "Please specify the ticket identifier.",
  "comment.edit_trace": "✏️ Edited by request of {who}:\n{lines}",
  "comment.move_target_note":
    "🔀 {who} confirmed {from} supplements this ticket:\n{body}\n\n{images}",
  "comment.move_source_note":
    "ℹ️ Duplicate of {target} (transferred by {who}). {botName} canceled duplicate.",
  "draft.expired_new": "Your previous draft expired; starting fresh",
  "draft.canceled": "Canceled. Tell me whenever you need to report an issue.",
  "draft.awaiting_confirmation": "Press the confirm button in the summary above.",
  "ask.missing_info": "Please add the missing details.",
  // PR 7
  "ask.system": "Which system does this happen on?",
  "ask.priority_reason": "Please provide a reason to prioritize as {level}:",
  "ask.unrecognized_dept":
    'Department "{dept}" is not in the catalog. Please choose one of the following:',
  "clarify.greeting": "Hello! What problem are you experiencing?",
  "ask.describe_incident": "Received {item}. Please describe the incident you are experiencing:",
  "ask.describe_incident_item": "the image/media you sent",
  "field.unknown_value": "Unknown",
  "summary.priority_line": "- Priority: {priority}",
  "ticket.fallback_title": "Technical incident",
  "priority.level.low": "Low",
  "priority.level.medium": "Medium",
  "priority.level.high": "High",
  "priority.level.urgent": "Urgent",
  // ── PR 9: split multi-incident report (RFC 0002 §1.2 B7) ───────────────────
  "split.question": "There are {count} incidents ({summary}) — split into {count} tickets?",
  "split.question_no_names": "There are {count} incidents — split into {count} tickets?",
  "split.unnamed_item": "incident",
  "split.unclear_prefix": "I did not understand your reply — the report is preserved. ",
  "split.next_ticket_notice": "Now creating ticket for the next incident:",
  "split.next_ticket_notice_student":
    "Now creating ticket for the next incident (student {studentName}):",
  "button.split_n": "Split {count} tickets",
  "button.merge_one": "Keep 1 ticket",
  "media.attachments_heading": "### 📸 Attached images",
  "media.ambiguous_notice": "*(Images shared across multiple split tickets)*",
  // PR 10
  "ticket.closed_refusal":
    "Ticket {identifier} is closed ({statusLabel}); please create a new ticket",
  "ticket.chitchat_after_create": "You are welcome! Ticket {identifier} is being handled.",
  "ticket.cancel_hint_after_create":
    'If you want to cancel ticket {identifier}, please message "cancel {identifier}".',
  "ticket.already_created_hint":
    "Ticket {identifier} was already created, no need to confirm again.",
  "action.suggest_append_lead": "Is this a follow-up for {identifier}",
  "action.suggest_conflict_lead": "This message has information different from {identifier}.",
  "action.suggest_unclear_prompt":
    "Please press a button above so I can record it in the right place.",
  "action.suggest_unclear_prompt_with_media":
    "Please press a button above so I can record it in the right place (received with {count} attachments).",
  "clarify.new_incident_prompt": "Please describe the new incident.",
  "action.suggest_append_preview":
    '{lead}{title}? Will record into {identifier}:{quoted}{files}{alternatives}\n\nPress confirm or "{newIncidentLabel}"',
  "action.suggest_append_media_note": "\n(with {count} files)",
  "action.suggest_append_other_tickets": "\n\nOther open tickets:\n{list}",
  "action.priority_uplift": "⏫ Priority uplift {from} → {to}. Reason: {reason}",
  "status.closed_done": "Done",
  "status.closed_canceled": "Canceled",
  "comment.supplement_default_content": "Supplement info",
  "reporter.default_name": "Reporter",
  "bot.default_name": "Bot",
  "edit.title_label": "Title",
  "edit.description_label": "Description",
  "edit.not_present": "(none)",
  "status.unknown": "unknown",
  "notify.on_call_supplement":
    "📢 **[{botName}]** Reporter supplemented ticket **{identifier}**:\n> {summary}",
  // ── PR 12: huỷ và đóng ticket theo yêu cầu người báo (RFC 0002 §1.4 D8, ADR-0006) ──
  "button.confirm_cancel": "Cancel {identifier}",
  "button.confirm_close": "Close {identifier}",
  "button.keep_ticket": "Keep ticket",
  "action.preview_cancel_ticket": "Confirm cancel ticket {identifier}{title}{quoted}{files}",
  "action.preview_close_ticket": "Confirm close ticket {identifier}{title}{quoted}{files}",
  "action.cancel_close_done": "Done {actionLabel} ticket {identifier}.{draftNote}",
  "action.keep_ticket_done": "Kept ticket {identifier} unchanged.",
  "action.cannot_read_status": "Cannot read status for {identifier}.",
  "action.label_close": "closed (Done)",
  "action.label_cancel": "canceled (Canceled)",
  "action.draft_kept_note": " Active draft «{title}» is preserved.",
  "ticket.cancel_close_closed_refusal": "Ticket {identifier} is already closed as {statusLabel}.",
  "comment.cancel_or_close_trace":
    "{icon} **{who}** requested {action} ticket → **{state}**.\nReason: {reason}",
  "action.word_close": "close",
  "action.word_cancel": "cancel",
  "action.icon_done": "✅",
  "action.icon_canceled": "🛑",
  "action.state_done": "Done",
  "action.state_canceled": "Canceled",
  "action.column_not_found": "Cannot find the {stateLabel} column for {identifier}.",
};
