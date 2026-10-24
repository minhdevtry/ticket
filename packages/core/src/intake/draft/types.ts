/**
 * The intake draft aggregate (ticket 08) — a trimmed, engine-owned relative of
 * intake's `IntakeDocument`. It carries only what the WRITE path needs: the
 * reporter's verbatim text, resolved ticket fields, confirmation timing marks,
 * and the created-ticket pointer. Conversation/collection state (gate fields,
 * similar tickets, KG advice, pending actions) is ticket 09's concern and is
 * deliberately NOT modelled here.
 *
 * NGUỒN: intake `lib/intake-document/types.ts` — `IntakeDocument`,
 * `IntakeDocumentStatus`, `CLOSED_STATUSES`, `summaryShownAt`, `confirmingSince`,
 * `issueCreatedAt`.
 */
import type { Priority } from "../ports";

export type DraftStatus =
  | "collecting"
  | "ready_for_confirmation"
  | "confirmed"
  | "created"
  | "canceled"
  | "expired";

/** A closed draft takes no further input; a later message is a new matter. */
export const CLOSED_STATUSES: ReadonlySet<DraftStatus> = new Set([
  "created",
  "canceled",
  "expired",
]);

/** The resolved, ready-to-write ticket content held in the draft. */
export interface DraftTicket {
  title: string;
  /** Reporter's VERBATIM words — becomes the ticket description (ADR-0010). */
  rawText: string;
  priority: Priority;
  category?: string;
  labels?: string[];
  /** Bot inference — written as a SEPARATE marked comment, never the description. */
  diagnosis?: string;
  /** Media file paths / references gathered across the conversation. */
  mediaPaths: string[];
}

export interface IntakeDraft {
  docId: string;
  chatId: string;
  revision: number;
  status: DraftStatus;
  ticket: DraftTicket;
  reporter?: { name?: string; username?: string; nameCode?: string };

  /** When the summary was shown (ISO) — gates confirm-too-soon. */
  summaryShownAt?: string;
  /** When a `confirmed` claim was taken (ISO) — a stuck claim is released after staleMs. */
  confirmingSince?: string;

  /** Created-ticket pointer, set once status is `created`. */
  issueId?: number;
  issueIdentifier?: string;
  issueUrl?: string;
  /** When the ticket was created (ISO) — bounds idempotent re-confirmation. */
  issueCreatedAt?: string;

  // ── ticket 09: conversation state (optional; the write path never reads it) ──
  /**
   * The gate's captured field values + ask counts for this chat's conversation.
   * Opaque to the write path; the conversation engine owns it. (The variant key
   * and per-field question counts live here so ask-back budgets survive turns.)
   */
  record?: {
    variant: string;
    values: Record<string, string>;
    questionCount: Record<string, number>;
    explicitlyMissing: string[];
  };
  /** Priority evidence accumulated across turns (never downgraded). */
  evidence?: Record<string, unknown>;
  /**
   * A write to an EXISTING ticket awaiting the reporter's confirm button
   * (ADR-0008). Set when a preview is shown; cleared on confirm/cancel.
   */
  pendingTicketAction?: {
    kind: "append" | "edit" | "move" | "suggest";
    identifier: string;
    content?: string;
    instruction?: string;
    from?: string;
    /** The exact button label the reporter must send to execute it. */
    confirmLabel: string;
  };
  /**
   * A conflicting-identifier or full-report park (TECH-928 / E2E 28/09): this
   * message would have been silently merged, so it is held and the reporter is
   * asked "new incident or append?". `docId` of the draft that was parked.
   */
  parkedDocId?: string;
  /** The held message/fields that triggered a park, replayed if "new incident". */
  parkedPayload?: { text: string; mediaPaths: string[] };

  createdAt: string;
  updatedAt: string;
}

/** A blank draft at revision 1 for a fresh chat. */
export function newDraft(docId: string, chatId: string, nowIso: string): IntakeDraft {
  return {
    docId,
    chatId,
    revision: 1,
    status: "collecting",
    ticket: { title: "", rawText: "", priority: "medium", mediaPaths: [] },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
