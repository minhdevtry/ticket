/**
 * Public seam for the intake conversation engine (ticket 09).
 *
 * `step(input)` is the ONE entry point: a reporter message (text + media +
 * button payload) goes in, and a channel-agnostic `StepOutput` comes out — the
 * lines to send, the buttons to render, and the outcome tests assert on. The
 * engine never touches a channel, a clock, a tracker or a copy string
 * directly; all of those are injected (ticket 08 ports + ticket 09 ports).
 */
import type { InlineButton } from "../gate/types";

export interface StepInput {
  chatId: string;
  /** Raw reporter text — the engine strips the channel envelope itself. */
  message?: string;
  /** Media file paths/references on this turn. */
  mediaPaths?: string[];
  reporter?: { name?: string; username?: string; nameCode?: string };
  /**
   * A `/new` style flag the channel sets when the reporter explicitly starts a
   * new matter (parks the current draft). The channel decides how it is typed.
   */
  forceNew?: boolean;
}

/** One outbound message with optional buttons. */
export interface ChannelMessage {
  text: string;
  buttons?: InlineButton[][];
}

/** What the engine decided this turn did, for the channel AND for tests. */
export type StepOutcome =
  | "asked" // asked a qualification/tech-review question
  | "clarify" // no description yet / bare message — ask what the matter is
  | "summary" // showed the recap + confirm button
  | "created" // created the ticket
  | "already_created" // idempotent return of an existing ticket
  | "too_soon" // confirm arrived before the min delay
  | "in_progress" // another turn is creating
  | "needs_resend" // last-resort net
  | "failed" // tracker write errored
  | "parked" // conflict / full-report park (TECH-928, E2E 28/09)
  | "split_question" // asked "split into N tickets or keep one" (W29-SPLIT)
  | "action_preview" // preview of a write to an existing ticket (ADR-0008)
  | "action_done" // executed a confirmed write to an existing ticket
  | "action_canceled" // the previewed action was canceled
  | "closed_refusal" // the ticket is already Done/Canceled — refuse politely
  | "lookup" // reported an existing ticket's status
  | "not_owner" // someone else's ticket — status only (ADR-0008 §6)
  | "canceled" // the draft was canceled on the reporter's request
  | "chitchat"; // nothing actionable

export interface StepOutput {
  outcome: StepOutcome;
  messages: ChannelMessage[];
  /** Created/looked-up ticket, when there is one. */
  issue?: { id: number; identifier: string; url?: string };
}
