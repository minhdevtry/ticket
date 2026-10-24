/**
 * Safe ticket creation (ticket 08) — the engine's write path.
 *
 * Guarantees:
 *  - Idempotent: a double-click or re-sent confirmation returns the SAME
 *    ticket, never a duplicate (atomic `tryInsertRevision` claim + a lookup of
 *    the ticket already created for this chat).
 *  - A bare confirmation never produces a blank ticket: the draft wins; if the
 *    draft is gone AND no content arrived, we fall back to the existing binding
 *    or, last resort, ask the reporter to resend (PO-79/PO-88).
 *  - description = reporter VERBATIM text; bot inference goes to a SEPARATE
 *    marked comment via core `markBotComment` (ADR-0010).
 *  - binding saved BEFORE media/comment side effects; the `created` revision is
 *    written immediately so a later failure can never cause a re-create.
 *  - media attached through an injected resolver.
 *
 * NGUỒN: intake `mcp/shared/tools/create-issue.ts` (handle/createIssue,
 * findIntakeCreatedTicket, attachMediaToIssue, bindIssueToChat) and
 * `lib/intake-step/pipeline.ts::createTicket` (atomic claim, write-created-first).
 */
import { markBotComment } from "../../core";
import type {
  Clock,
  CopyCatalog,
  ChannelBindingStore,
  MediaResolver,
  TrackerPort,
  TrackerIssue,
} from "../ports";
import type { DraftRepository } from "../draft/repository";
import type { IntakeDraft } from "../draft/types";
import { evaluateConfirmation, type ConfirmOptions } from "../confirm/protocol";
import { withChatLock } from "../confirm/lock";
import { isBareConfirmation, mergeOverDraft, type TicketInput } from "./merge";

/** Within this window after a create, a re-confirm is treated as the same incident. */
export const INTAKE_DUPLICATE_WINDOW_MS = 30 * 60_000;

export interface CreateTicketDeps {
  tracker: TrackerPort;
  drafts: DraftRepository;
  bindings: ChannelBindingStore;
  copy: CopyCatalog;
  clock: Clock;
  media?: MediaResolver;
  confirm?: ConfirmOptions;
  /** Identifier prefix (e.g. "TECH") to scope the fallback binding lookup. */
  identifierPrefix?: string;
}

export interface CreateTicketRequest {
  chatId: string;
  /** Confirm-turn content (usually blank for a bare confirm). */
  input?: TicketInput;
  /**
   * `userId` = khóa định danh người báo theo user id của kênh (Telegram =
   * `from.id`), bền hơn username/tên. Lưu vào binding để tra ticket theo người
   * về sau. Tùy chọn — bot chưa truyền thì binding để trống id, hành vi như cũ.
   */
  reporter?: { name?: string; username?: string; nameCode?: string; userId?: string };
}

export type CreateTicketResult =
  | { kind: "created"; issue: TrackerIssue; message: string }
  | { kind: "already_created"; issue: TrackerIssue; message: string }
  | { kind: "too_soon"; message: string }
  | { kind: "in_progress"; message: string }
  | { kind: "needs_resend"; message: string }
  | { kind: "failed"; message: string };

/**
 * Attempt to create the ticket for `chatId` from its latest draft. Serialized
 * per chat; honours the confirmation protocol; idempotent.
 */
export function createTicket(
  deps: CreateTicketDeps,
  req: CreateTicketRequest,
): Promise<CreateTicketResult> {
  return withChatLock(req.chatId, () => run(deps, req));
}

async function run(deps: CreateTicketDeps, req: CreateTicketRequest): Promise<CreateTicketResult> {
  const { tracker, drafts, bindings, copy, clock } = deps;
  const now = clock.now();
  const input: TicketInput = req.input ?? {};

  let draft = drafts.getLatestByChatId(req.chatId);

  // Idempotent: a ticket already created for this chat in the dedupe window → return it.
  const existing = findCreatedTicket(draft, now);
  if (existing) {
    return {
      kind: "already_created",
      issue: {
        id: existing.issueId!,
        identifier: existing.issueIdentifier!,
        title: existing.ticket.title,
        url: existing.issueUrl,
      },
      message: copy.text("ticket.already_created", { identifier: existing.issueIdentifier! }),
    };
  }

  // No draft at all. If content came with this turn we could not have shown a
  // summary, so there is nothing to confirm; if it is bare, try the binding
  // fallback, else ask to resend. Never fabricate a blank ticket.
  if (!draft) {
    return bareFallback(deps, req, now);
  }

  // Honour the confirmation protocol (delay / stale / summary-shown).
  const decision = evaluateConfirmation(draft, clock, deps.confirm);
  if (decision.kind === "too_soon")
    return { kind: "too_soon", message: copy.text("confirm.too_soon") };
  if (decision.kind === "in_progress")
    return { kind: "in_progress", message: copy.text("confirm.in_progress") };
  if (decision.kind === "no_summary") {
    // Draft exists but no summary was shown — bare confirm cannot create.
    if (isBareConfirmation(input)) return bareFallback(deps, req, now);
    return { kind: "too_soon", message: copy.text("confirm.too_soon") };
  }
  if (decision.kind === "released") {
    draft = decision.draft;
    drafts.saveRevision(draft);
  }

  // Draft wins; incoming fields only fill blanks (PO-79, TECH-637).
  const ticket = mergeOverDraft(draft.ticket, input);

  // Last-resort net: nothing to write. Thà xin lại còn hơn ghi ticket trắng.
  if (!ticket.rawText.trim() && !ticket.title.trim()) {
    return { kind: "needs_resend", message: copy.text("confirm.resend") };
  }

  // Atomic claim: write the next `confirmed` revision ONLY if nobody else did.
  // The summary lives at `draft.revision`; the claim races for revision+1, so two
  // concurrent confirm-clicks both target the same next revision and one loses.
  const nowIso = new Date(now).toISOString();
  const claim: IntakeDraft = {
    ...draft,
    revision: draft.revision + 1,
    status: "confirmed",
    confirmingSince: nowIso,
    ticket,
    updatedAt: nowIso,
  };
  if (!drafts.tryInsertRevision(claim)) {
    const latest = drafts.getLatestByChatId(req.chatId);
    if (latest?.status === "created" && latest.issueId && latest.issueIdentifier) {
      return {
        kind: "already_created",
        issue: {
          id: latest.issueId,
          identifier: latest.issueIdentifier,
          title: latest.ticket.title,
          url: latest.issueUrl,
        },
        message: copy.text("ticket.already_created", { identifier: latest.issueIdentifier }),
      };
    }
    return { kind: "in_progress", message: copy.text("confirm.in_progress") };
  }

  // Write to the tracker. Description = reporter verbatim text.
  let issue: TrackerIssue;
  try {
    issue = await tracker.createIssue({
      title: ticket.title || ticket.rawText.slice(0, 80),
      description: ticket.rawText,
      priority: ticket.priority,
      category: ticket.category,
      labels: ticket.labels,
    });
  } catch {
    // Keep the draft recoverable: step back to ready_for_confirmation.
    const back: IntakeDraft = {
      ...claim,
      revision: claim.revision + 1,
      status: "ready_for_confirmation",
      confirmingSince: undefined,
      updatedAt: new Date(clock.now()).toISOString(),
    };
    drafts.saveRevision(back);
    return { kind: "failed", message: copy.text("ticket.create_failed") };
  }

  // Write the `created` revision IMMEDIATELY — nothing below may cause a recreate.
  const createdDoc: IntakeDraft = {
    ...claim,
    revision: claim.revision + 1,
    status: "created",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    issueCreatedAt: new Date(clock.now()).toISOString(),
    confirmingSince: undefined,
    updatedAt: new Date(clock.now()).toISOString(),
  };
  drafts.saveRevision(createdDoc);

  // Binding saved BEFORE media/comment side effects (so report-back survives their failure).
  try {
    bindings.saveBinding({
      issueId: issue.id,
      chatId: req.chatId,
      identifier: issue.identifier,
      title: issue.title,
      reporterUserId: req.reporter?.userId,
      reporterUsername: req.reporter?.username ?? req.reporter?.nameCode,
    });
  } catch {
    // Binding failure must not fail the create.
  }

  // Media via injected resolver; per-file failures are swallowed by the port.
  const resolver = deps.media;
  const mediaPaths = resolver
    ? resolver.resolve(ticket.mediaPaths, [ticket.title, ticket.rawText])
    : ticket.mediaPaths;
  if (mediaPaths.length > 0) {
    await tracker.attach(issue.id, ticket.rawText, mediaPaths).catch(() => 0);
  }

  // Bot inference → a SEPARATE marked comment, never the description (ADR-0010).
  if (ticket.diagnosis && ticket.diagnosis.trim()) {
    await tracker.addComment(issue.id, markBotComment(ticket.diagnosis.trim())).catch(() => {});
  }

  return {
    kind: "created",
    issue,
    message: copy.text("ticket.created", { identifier: issue.identifier, url: issue.url ?? "" }),
  };
}

/** A draft whose created ticket is still inside the dedupe window. */
function findCreatedTicket(draft: IntakeDraft | null, now: number): IntakeDraft | null {
  if (!draft || draft.status !== "created" || !draft.issueId || !draft.issueIdentifier) return null;
  const createdAt = Date.parse(draft.issueCreatedAt ?? draft.updatedAt);
  if (Number.isNaN(createdAt) || now - createdAt > INTAKE_DUPLICATE_WINDOW_MS) return null;
  return draft;
}

/**
 * No usable draft to create from. Return the existing binding if there is one
 * (a re-clicked old confirm button), else ask the reporter to resend. Never a
 * blank ticket. (PO-88 lived outside the chatId branch; here it is unconditional.)
 */
function bareFallback(
  deps: CreateTicketDeps,
  req: CreateTicketRequest,
  _now: number,
): CreateTicketResult {
  const binding = deps.bindings.getLatestBinding(req.chatId, deps.identifierPrefix);
  if (binding) {
    return {
      kind: "already_created",
      issue: { id: binding.issueId, identifier: binding.identifier, title: binding.title ?? "" },
      message: deps.copy.text("ticket.already_created", { identifier: binding.identifier }),
    };
  }
  return { kind: "needs_resend", message: deps.copy.text("confirm.resend") };
}
