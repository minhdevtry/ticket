/**
 * Bare-confirmation nets (ticket 08).
 *
 * At the confirm turn a model does not restate the ticket — it only confirms.
 * The content was fixed at the summary step and lives in the draft, so the
 * draft WINS and incoming fields only fill blanks the draft left empty.
 *
 * NGUỒN: intake `mcp/shared/tools/create-issue.ts` — `isBareConfirmation`,
 * `isBlank`, `mergeOverDraft`, `CONTROL_KEYS`. Measured incidents preserved:
 *  - PO-79: shallow merge let a re-sent empty payload (plus a self-filled
 *    `priority:"medium"`) overwrite a `high` draft and blank the title. The
 *    draft must win.
 *  - TECH-637: shallow overwrite dropped mediaPaths the draft had gathered.
 *    Media is UNIONED, never overwritten.
 */
import type { DraftTicket } from "../draft/types";
import type { Priority } from "../ports";

/** A ready-to-write ticket may arrive partially filled from the model. */
export interface TicketInput {
  title?: string;
  rawText?: string;
  priority?: Priority;
  category?: string;
  labels?: string[];
  diagnosis?: string;
  mediaPaths?: string[];
}

/** "Named but carrying no content": blank string, empty array, null/undefined. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** A bare confirm: not one scrap of ticket content came with it. */
export function isBareConfirmation(input: TicketInput): boolean {
  return (
    isBlank(input.title) &&
    isBlank(input.rawText) &&
    isBlank(input.category) &&
    isBlank(input.labels) &&
    isBlank(input.diagnosis) &&
    isBlank(input.mediaPaths) &&
    // priority alone is never content — a model self-fills "medium" (PO-79).
    isBlank(input.priority)
  );
}

/**
 * Merge an incoming ticket input over a stored draft ticket. **Draft wins.**
 * Incoming values fill only the blanks; media is unioned (TECH-637).
 */
export function mergeOverDraft(draft: DraftTicket, input: TicketInput): DraftTicket {
  const merged: DraftTicket = { ...draft };

  if (isBlank(draft.title) && !isBlank(input.title)) merged.title = input.title!.trim();
  if (isBlank(draft.rawText) && !isBlank(input.rawText)) merged.rawText = input.rawText!;
  if (isBlank(draft.category) && !isBlank(input.category)) merged.category = input.category;
  if (isBlank(draft.labels) && !isBlank(input.labels)) merged.labels = input.labels;
  if (isBlank(draft.diagnosis) && !isBlank(input.diagnosis)) merged.diagnosis = input.diagnosis;
  // Priority: keep the draft's unless the draft never set a non-default one.
  if ((draft.priority === undefined || draft.priority === "medium") && !isBlank(input.priority)) {
    merged.priority = input.priority!;
  }

  const draftMedia = draft.mediaPaths ?? [];
  const inputMedia = input.mediaPaths ?? [];
  merged.mediaPaths = Array.from(new Set([...draftMedia, ...inputMedia]));
  return merged;
}
