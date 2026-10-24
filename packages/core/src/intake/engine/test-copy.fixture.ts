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
};
