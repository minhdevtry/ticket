/**
 * Confirmation protocol (ticket 08).
 *
 * Three time-based guards, all evaluated against the INJECTED clock so they are
 * testable:
 *
 *  - MIN_CONFIRM_DELAY_MS (5s): a "confirm" arriving sooner than this after the
 *    summary was shown is rejected — a person must read the summary before
 *    pressing, whereas a model can self-"click" the callback in the same turn
 *    (observed: gemini-flash-lite emitted "đúng rồi" 1.1s after the summary).
 *  - CONFIRM_STALE_MS (2min): a draft stuck in `confirmed` (a creating turn that
 *    never finished) is released back to `ready_for_confirmation` so the
 *    reporter can confirm again instead of being blocked.
 *  - summary-shown gate: a confirm is accepted ONLY if a summary was actually
 *    shown (summaryShownAt set) and the draft is `ready_for_confirmation`.
 *
 * NGUỒN: intake `lib/intake-step/pipeline.ts` — `MIN_CONFIRM_DELAY_MS`,
 * `CONFIRM_STALE_MS`, the `summaryShownAt` delay check, and the `confirmed`
 * staleness release.
 */
import type { Clock } from "../ports";
import type { IntakeDraft } from "../draft/types";

export const MIN_CONFIRM_DELAY_MS = 5_000;
export const CONFIRM_STALE_MS = 2 * 60_000;

export interface ConfirmOptions {
  minConfirmDelayMs?: number;
  confirmStaleMs?: number;
}

export type ConfirmDecision =
  /** Accept — the caller may proceed to create the ticket. */
  | { kind: "accept" }
  /** Reject — confirm arrived too soon after the summary; keep waiting. */
  | { kind: "too_soon" }
  /** Not confirmable — no summary was shown yet (nothing to confirm). */
  | { kind: "no_summary" }
  /** Another turn is actively creating the ticket (fresh `confirmed` claim). */
  | { kind: "in_progress" }
  /** A stuck `confirmed` claim was released; `draft` is the reopened draft to persist. */
  | { kind: "released"; draft: IntakeDraft };

/**
 * Decide what to do with an incoming confirmation against the current draft.
 * Pure: it reads the clock and the draft and returns a decision; the caller
 * (createTicket) performs the side effects.
 */
export function evaluateConfirmation(
  draft: IntakeDraft,
  clock: Clock,
  opts: ConfirmOptions = {},
): ConfirmDecision {
  const now = clock.now();
  const minDelay = opts.minConfirmDelayMs ?? MIN_CONFIRM_DELAY_MS;
  const staleMs = opts.confirmStaleMs ?? CONFIRM_STALE_MS;

  // A draft already creating: fresh claim → in progress; stale claim → release.
  if (draft.status === "confirmed") {
    const since = Date.parse(draft.confirmingSince ?? draft.updatedAt);
    if (!Number.isNaN(since) && now - since < staleMs) {
      return { kind: "in_progress" };
    }
    const released: IntakeDraft = {
      ...draft,
      status: "ready_for_confirmation",
      confirmingSince: undefined,
      updatedAt: new Date(now).toISOString(),
    };
    return { kind: "released", draft: released };
  }

  if (draft.status !== "ready_for_confirmation" || !draft.summaryShownAt) {
    return { kind: "no_summary" };
  }

  const shownAt = Date.parse(draft.summaryShownAt);
  if (!Number.isNaN(shownAt) && now - shownAt < minDelay) {
    return { kind: "too_soon" };
  }
  return { kind: "accept" };
}

/**
 * Mark a draft as having shown its summary now. Caller persists the result;
 * this is where `summaryShownAt` and `ready_for_confirmation` are stamped.
 */
export function markSummaryShown(draft: IntakeDraft, clock: Clock): IntakeDraft {
  const nowIso = new Date(clock.now()).toISOString();
  return { ...draft, status: "ready_for_confirmation", summaryShownAt: nowIso, updatedAt: nowIso };
}
