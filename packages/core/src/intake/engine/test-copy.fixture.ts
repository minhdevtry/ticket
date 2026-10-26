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
  "action.done_move": "Moved {from} into {identifier}",
  "action.canceled": "Canceled",
  "lookup.status": "{identifier} status: {status}",
  "lookup.not_owner": "{identifier} belongs to someone else; status only",
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
  // PR 9
  "split.question": "There are {count} incidents ({summary}) — split into {count} tickets?",
  "split.question_no_names": "There are {count} incidents — split into {count} tickets?",
  "split.unclear_prefix": "I did not understand your reply — the report is preserved. ",
  "split.next_ticket_notice": "Now creating ticket for the next incident:",
  "split.next_ticket_notice_student":
    "Now creating ticket for the next incident (student {studentName}):",
  "button.split_n": "Split {count} tickets",
  "button.merge_one": "Keep 1 ticket",
  "media.ambiguous_notice": "*(Images shared across multiple split tickets)*",
};
