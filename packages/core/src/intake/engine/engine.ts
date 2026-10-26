/**
 * The intake conversation engine (ticket 09).
 *
 * `step(input)` is a state machine over a chat's latest draft:
 *
 *   load draft → strip channel envelope → route:
 *     • pending ticket-action awaiting a button  → match button → execute / cancel (ADR-0008)
 *     • parked draft awaiting "new / append"      → match button → park-replay / resume
 *     • expired draft                             → close, start fresh
 *     • /new flag                                 → park current, start fresh
 *     • existing-ticket command (append/edit/…)   → preview + button (ADR-0008)
 *     • already-created ticket + follow-up        → disambiguate (never overwrite ids)
 *     • otherwise collect: extract → conflict-check (TECH-928) → merge → gate →
 *       priority → optional tech review → recap + confirm (ticket 08 createTicket)
 *
 * Every invariant in research §2 is carried here; each is cited at the branch
 * that enforces it. NO Vietnamese literal lives in this file — all user-facing
 * copy is a `CopyCatalog` key, all button labels come from the catalog, all
 * identifier/ownership/domain logic is a port or a pure helper.
 */
import { stripChannelEnvelope } from "../../core";
import type {
  Clock,
  CopyCatalog,
  ChannelBindingStore,
  MediaResolver,
  TrackerPort,
  FieldExtractorPort,
  TechReviewerPort,
  OwnershipPort,
  TicketActionExecutorPort,
  TicketCommandInterpreterPort,
  TicketCommand,
  ReplyCandidate,
  PostCreateHookPort,
  ExtractedFields,
  ExtractContext,
  IdentifierKey,
  Priority,
} from "../ports";
import { IDENTIFIER_KEYS } from "../ports";
import type { DraftRepository } from "../draft/repository";
import { isExpiredDraft, INTAKE_DRAFT_TTL_MS } from "../draft/repository";
import type { IntakeDraft } from "../draft/types";
import { newDraft, CLOSED_STATUSES } from "../draft/types";
import { createTicket, type CreateTicketDeps } from "../create/create-ticket";
import type { ConfirmOptions } from "../confirm/protocol";
import { markSummaryShown } from "../confirm/protocol";
import {
  evaluateGate,
  createRecord,
  buildRecap,
  layoutButtons,
  fieldButtons,
  getVariant,
  type FieldCatalog,
  type IntakeRecord,
  type InlineButton,
} from "../gate";
import { evaluatePriorityRules, resolveRequestedPriority, type UrgencyRules } from "../priority";
import { findIdentifierConflict } from "./identifiers";
import { mentionedIdentifiers, foldButton } from "./text";
import { isDeclineAnswer, isMeaninglessInput, TECH_INFO_FIELD } from "./normalize";
import { MAX_RAW_TEXT_CHARS, MAX_RAW_TEXT_TOTAL_CHARS } from "../raw-text";
import type { StepInput, StepOutput, ChannelMessage } from "./types";
import { type ReplayOraclePort, applyReplayControlOverride } from "./oracle";

/** Max chars of ONE reporter message kept in rawText (legacy parity). */
export { MAX_RAW_TEXT_CHARS, MAX_RAW_TEXT_TOTAL_CHARS } from "../raw-text";
/** Max chars for an append/follow-up to an existing ticket (§2). */
export const MAX_FOLLOW_UP_CHARS = 4000;
/** A just-created ticket can be moved into another within this window. */
export const JUST_CREATED_WINDOW_MS = 24 * 3_600_000;

export interface IntakeEngineDeps {
  // ── ticket 08 write path ────────────────────────────────────────────────
  tracker: TrackerPort;
  drafts: DraftRepository;
  bindings: ChannelBindingStore;
  copy: CopyCatalog;
  clock: Clock;
  media?: MediaResolver;
  confirm?: ConfirmOptions;
  identifierPrefix?: string;
  // ── ticket 09 conversation ──────────────────────────────────────────────
  extractor: FieldExtractorPort;
  /** The domain field catalog (variant/gate config) — one variant key per bot flow. */
  catalog: FieldCatalog;
  /** Which catalog variant to collect under (bots with one flow pass a constant). */
  variant: string;
  /** Priority rule table (floors/ceilings) — injected data, never baked in. */
  urgencyRules: UrgencyRules;
  /** Optional one-round technical review before confirmation. */
  techReviewer?: TechReviewerPort;
  /** Ownership predicate (ADR-0008 §6). Defaults to binding-based. */
  ownership?: OwnershipPort;
  /** Executes a confirmed write to an existing ticket (append/edit/move). */
  actions?: TicketActionExecutorPort;
  /** Interprets a message against live tickets; absent ⇒ everything is `new`. */
  commands?: TicketCommandInterpreterPort;
  /** Optional post-create hook (KG/Onyx/similar) — never shipped in src. */
  postCreate?: PostCreateHookPort;
  draftTtlMs?: number;
  /** New doc ids (defaults to a monotonic clock-based id). */
  genDocId?: () => string;
  /**
   * Optional replay oracle (RFC 0002 PR 6 / ADR-0005): for shadow replay mode,
   * forces past control branches so turn t-1 reflects TL1 decisions while keeping
   * TL2 extraction, merging, and business rules untouched. Absent in production.
   */
  oracle?: ReplayOraclePort;
}

export class IntakeEngine {
  constructor(private readonly deps: IntakeEngineDeps) {}

  async step(input: StepInput): Promise<StepOutput> {
    // NOTE: the create critical section is serialized inside the ticket-08
    // `createTicket` (its own per-chat lock + atomic revision CAS). We do NOT
    // take an outer lock here — it would be re-entered by `finishCreate` and
    // deadlock, since the per-chat lock is not reentrant.
    const output = await this.run(input);
    if (this.deps.oracle) {
      const latestDraft = this.deps.drafts.getLatestByChatId(input.chatId);
      if (latestDraft) {
        const forced = await this.deps.oracle.getControlAction({
          chatId: input.chatId,
          input,
          draft: latestDraft,
          output,
        });
        if (forced) {
          const nowIso = new Date(this.deps.clock.now()).toISOString();
          const overridden = applyReplayControlOverride(latestDraft, forced, nowIso);
          this.deps.drafts.saveRevision(overridden);
        }
      }
    }
    return output;
  }

  private async run(input: StepInput): Promise<StepOutput> {
    const { deps } = this;
    const text = stripChannelEnvelope(input.message ?? "").trim(); // TECH-924: envelope never enters a ticket
    const mediaPaths = input.mediaPaths ?? [];
    const nowIso = new Date(deps.clock.now()).toISOString();

    let draft = deps.drafts.getLatestByChatId(input.chatId);

    // 1. A write to an existing ticket is awaiting the reporter's button (ADR-0008).
    if (draft?.pendingTicketAction) {
      return this.resolvePendingAction(draft, text);
    }

    // 2. A park ("new incident or append?") is awaiting the reporter's choice (TECH-928).
    if (draft?.parkedPayload) {
      const resolved = await this.resolvePark(draft, text, mediaPaths);
      if (resolved) return resolved;
      // Not a park answer → fall through and treat as ordinary input on the draft.
    }

    // 3. Expired draft → close and start fresh.
    if (
      draft &&
      !CLOSED_STATUSES.has(draft.status) &&
      isExpiredDraft(draft, deps.clock.now(), deps.draftTtlMs ?? INTAKE_DRAFT_TTL_MS)
    ) {
      draft = this.closeAndReopen(draft, nowIso);
      // continue collecting on the fresh draft below
    }

    // 3.1 Tin vô nghĩa (rỗng, hoặc token nội bộ "noop" của nút đã khoá) mà
    //      không kèm ảnh: BỎ QUA hoàn toàn — không tạo tờ khai, không tạo
    //      ticket, không làm hỏng trạng thái đang có (TECH-1148). Chỉ trả lời
    //      theo trạng thái tờ khai để người báo không bị bỏ rơi.
    if (isMeaninglessInput(text, mediaPaths)) {
      return this.respondToMeaningless(draft);
    }

    // 4. Explicit /new flag → park the open draft and open a new one.
    if (input.forceNew && draft && !CLOSED_STATUSES.has(draft.status)) {
      const fresh = this.openFresh(input.chatId, nowIso);
      fresh.parkedDocId = draft.docId;
      deps.drafts.saveRevision(fresh);
      // Fall through: collect the message onto the fresh draft.
      draft = fresh;
    }

    // 5. An already-created ticket in this chat + a follow-up: route to the
    //    existing-ticket command path, never overwrite its identifiers (TECH-956).
    if ((draft && draft.status === "created") || this.mentionsExistingTicket(text)) {
      const routed = await this.routeExistingTicket(draft, text, mediaPaths);
      if (routed) return routed;
    }

    // 6. Ordinary collection.
    return this.collect(draft, input, text, mediaPaths, nowIso);
  }

  // ── collection ────────────────────────────────────────────────────────────

  private async collect(
    existing: IntakeDraft | null,
    input: StepInput,
    text: string,
    mediaPaths: string[],
    nowIso: string,
  ): Promise<StepOutput> {
    const { deps } = this;
    const open = existing && !CLOSED_STATUSES.has(existing.status) ? existing : null;
    // "không biết" / "không có" — người báo nói rõ là không trả lời được câu
    // vừa hỏi (A13). Luật tất định, không nhờ LLM.
    const declined = isDeclineAnswer(text);

    const extracted = await deps.extractor.extract({
      text,
      attachments: mediaPaths.length,
      draftTitle: open?.ticket.title || undefined,
      context: this.buildExtractContext(existing),
    });

    // A plain confirm with no live draft summary is chitchat here; the write
    // path's confirmation protocol owns real confirms once a summary is shown.
    if (extracted.userIntent === "cancel") {
      if (open) {
        deps.drafts.saveRevision({ ...open, status: "canceled", updatedAt: nowIso });
      }
      return { outcome: "canceled", messages: [{ text: deps.copy.text("draft.canceled") }] };
    }

    // A completed report arriving while another draft is mid-collection, OR a
    // conflicting identifier, parks instead of silently merging (TECH-928, E2E 28/09).
    if (open) {
      const park = this.detectPark(open, extracted, text, mediaPaths, nowIso);
      if (park) return park;
    }

    // Confirm intent against an open, summary-shown draft → hand to the write path.
    if (extracted.userIntent === "confirm" && open && open.status === "ready_for_confirmation") {
      return this.finishCreate(open);
    }

    // A confirm (or any turn) against a just-created ticket → idempotent return
    // of that ticket, never a duplicate. The write path owns the dedupe window.
    if (existing && existing.status === "created" && extracted.userIntent === "confirm") {
      return this.finishCreate(existing);
    }

    // Merge this turn's fields onto the draft (draft never loses identifiers it had).
    const draft = this.mergeIntoDraft(open, input, extracted, text, mediaPaths, nowIso, declined);

    // "không biết" → trường vừa hỏi vào explicitlyMissing, bot thôi hỏi trường đó.
    if (declined && draft.lastAskedFields?.length) {
      const rec = draft.record ?? {
        variant: deps.variant,
        values: {},
        questionCount: {},
        explicitlyMissing: [],
      };
      rec.explicitlyMissing = [...new Set([...rec.explicitlyMissing, ...draft.lastAskedFields])];
      draft.record = rec;
    }

    // Gate: enough yet?
    const record = this.toRecord(draft);
    const gate = evaluateGate(deps.catalog, record);
    this.writeRecordBack(draft, record, gate.effectiveValues);

    if (!gate.isComplete) {
      // Ask the next question (ask-back budget lives in the gate + record).
      this.bumpAsked(draft, gate.fieldsToAsk);
      draft.lastAskedFields = gate.fieldsToAsk;
      deps.drafts.saveRevision(draft);
      const question = gate.questionText || deps.copy.text("ask.opening");
      const buttons = this.questionButtons(gate.fieldsToAsk[0]);
      return {
        outcome: "asked",
        messages: [{ text: question, ...(buttons ? { buttons } : {}) }],
      };
    }

    // Priority: floors raise, ceilings cap, floor wins ties; reporter request
    // honoured only with a reason and only strictly above evidence (29/09).
    draft.ticket.priority = this.resolvePriority(draft, extracted);

    // Optional one-round technical review before the summary.
    if (deps.techReviewer && !draft.techReviewDone) {
      const review = await safeReview(deps.techReviewer, {
        title: draft.ticket.title,
        description: draft.ticket.rawText,
        attachments: draft.ticket.mediaPaths.length,
        known: record.values,
      });
      if (review.missing.length > 0 && review.question) {
        draft.techReviewDone = true; // ask once, any answer proceeds
        draft.techQuestion = review.question;
        draft.lastAskedFields = [TECH_INFO_FIELD];
        deps.drafts.saveRevision(draft);
        return { outcome: "asked", messages: [{ text: review.question }] };
      }
      draft.techReviewDone = true;
    }

    // Summary + confirm button.
    const shown = markSummaryShown(draft, deps.clock);
    shown.lastAskedFields = undefined; // hỏi xong, không còn trường nào đang chờ
    deps.drafts.saveRevision(shown);
    return this.summaryOutput(shown, gate);
  }

  /**
   * Trả lời khi tin vô nghĩa (rỗng hoặc token nội bộ "noop"): bảng phản hồi THEO
   * TRẠNG THÁI tờ khai (A11, TECH-1148). Không ghi tờ khai mới, không tạo
   * ticket, không đụng trạng thái đang có.
   */
  private respondToMeaningless(draft: IntakeDraft | null): StepOutput {
    const { deps } = this;

    if (draft?.status === "created" && draft.issueIdentifier) {
      return {
        outcome: "already_created",
        messages: [
          { text: deps.copy.text("ticket.already_created", { identifier: draft.issueIdentifier }) },
        ],
        issue: { id: draft.issueId ?? 0, identifier: draft.issueIdentifier, url: draft.issueUrl },
      };
    }
    if (draft?.status === "confirmed") {
      return {
        outcome: "in_progress",
        messages: [{ text: deps.copy.text("confirm.in_progress") }],
      };
    }
    if (draft?.status === "ready_for_confirmation") {
      const label = deps.copy.text("button.confirm_create");
      return {
        outcome: "too_soon",
        messages: [
          {
            text: deps.copy.text("draft.awaiting_confirmation"),
            buttons: layoutButtons([{ text: label, callbackData: label }]),
          },
        ],
      };
    }
    if (draft?.status === "canceled") {
      return { outcome: "canceled", messages: [{ text: deps.copy.text("draft.canceled") }] };
    }
    if (draft?.status === "collecting") {
      const hasDescription =
        draft.ticket.rawText.trim().length > 0 || draft.ticket.title.trim().length > 0;
      if (hasDescription) {
        return { outcome: "asked", messages: [{ text: deps.copy.text("ask.missing_info") }] };
      }
    }
    // Chưa có mô tả (hoặc chưa có tờ khai): chỉ chào và hỏi, KHÔNG tạo tờ khai.
    return { outcome: "clarify", messages: [{ text: deps.copy.text("ask.opening") }] };
  }

  /** Ngữ cảnh cho bộ trích xuất: tờ khai, câu hỏi kỹ thuật, ticket vừa tạo. */
  private buildExtractContext(draft: IntakeDraft | null): ExtractContext {
    if (!draft) return {};
    const context: ExtractContext = {};
    if (draft.ticket.title) context.draftTitle = draft.ticket.title;
    if (draft.ticket.rawText) context.draftDescription = truncate(draft.ticket.rawText, 1500);
    if (draft.techQuestion) context.techQuestion = draft.techQuestion;
    if (draft.lastAskedFields?.length) context.lastAskedFields = draft.lastAskedFields;
    if (draft.status === "created" && draft.issueIdentifier) {
      context.createdTicket = {
        identifier: draft.issueIdentifier,
        title: draft.ticket.title,
        description: truncate(draft.ticket.rawText, 4000),
      };
    }
    return context;
  }

  /** Nút lựa chọn cho câu hỏi, khi trường vừa hỏi là enum có danh mục. */
  private questionButtons(fieldName: string | undefined): InlineButton[][] | undefined {
    if (!fieldName) return undefined;
    const field = getVariant(this.deps.catalog, this.deps.variant).fields[fieldName];
    if (!field) return undefined;
    return fieldButtons(this.deps.catalog, field) ?? undefined;
  }

  // ── create (delegates to the ticket-08 write path) ──────────────────────────

  private async finishCreate(draft: IntakeDraft): Promise<StepOutput> {
    const { deps } = this;
    const writeDeps: CreateTicketDeps = {
      tracker: deps.tracker,
      drafts: deps.drafts,
      bindings: deps.bindings,
      copy: deps.copy,
      clock: deps.clock,
      media: deps.media,
      confirm: deps.confirm,
      identifierPrefix: deps.identifierPrefix,
    };
    const result = await createTicket(writeDeps, {
      chatId: draft.chatId,
      reporter: draft.reporter,
    });

    switch (result.kind) {
      case "created": {
        if (deps.postCreate) {
          await safe(() =>
            deps.postCreate!.afterCreate({
              issue: result.issue,
              description: draft.ticket.rawText,
              chatId: draft.chatId,
            }),
          );
        }
        return {
          outcome: "created",
          messages: [{ text: result.message }],
          issue: {
            id: result.issue.id,
            identifier: result.issue.identifier,
            url: result.issue.url,
          },
        };
      }
      case "already_created":
        return {
          outcome: "already_created",
          messages: [{ text: result.message }],
          issue: {
            id: result.issue.id,
            identifier: result.issue.identifier,
            url: result.issue.url,
          },
        };
      case "too_soon": {
        // A7: xác nhận tới quá sớm (model tự bấm) thì nhắc bấm lại nút xác
        // nhận — nút cũ đã bị khoá sau khi bấm.
        const label = deps.copy.text("button.confirm_create");
        return {
          outcome: "too_soon",
          messages: [
            {
              text: result.message,
              buttons: layoutButtons([{ text: label, callbackData: label }]),
            },
          ],
        };
      }
      case "in_progress":
        return { outcome: "in_progress", messages: [{ text: result.message }] };
      case "needs_resend":
        return { outcome: "needs_resend", messages: [{ text: result.message }] };
      case "failed":
        return { outcome: "failed", messages: [{ text: result.message }] };
    }
  }

  // ── parking (TECH-928 / E2E 28/09) ──────────────────────────────────────────

  /** A conflicting identifier or a full new report while a draft is open parks. */
  private detectPark(
    open: IntakeDraft,
    extracted: ExtractedFields,
    text: string,
    mediaPaths: string[],
    nowIso: string,
  ): StepOutput | null {
    const incoming = extracted.identifiers ?? {};
    const existingIds = this.draftIdentifiers(open);
    const conflict = findIdentifierConflict(existingIds, incoming);

    const draftHasContent =
      open.ticket.rawText.trim().length > 0 || open.ticket.title.trim().length > 0;
    const isFullNewReport =
      extracted.userIntent === "report_issue" &&
      (extracted.symptoms?.length ?? 0) > 0 &&
      draftHasContent;

    if (!conflict && !isFullNewReport) return null;

    // Park: hold the message, ask "new incident or append?". We do NOT merge.
    const parked: IntakeDraft = {
      ...open,
      parkedPayload: { text, mediaPaths },
      updatedAt: nowIso,
    };
    this.deps.drafts.saveRevision(parked);

    const key = conflict ? "park.identifier_conflict" : "park.full_report";
    const newLabel = this.deps.copy.text("button.new_incident");
    const appendLabel = this.deps.copy.text("button.continue_draft");
    return {
      outcome: "parked",
      messages: [
        {
          text: this.deps.copy.text(key),
          buttons: layoutButtons([
            { text: newLabel, callbackData: newLabel },
            { text: appendLabel, callbackData: appendLabel },
          ]),
        },
      ],
    };
  }

  private async resolvePark(
    draft: IntakeDraft,
    text: string,
    _mediaPaths: string[],
  ): Promise<StepOutput | null> {
    const { deps } = this;
    const folded = foldButton(text);
    const newLabel = foldButton(deps.copy.text("button.new_incident"));
    const appendLabel = foldButton(deps.copy.text("button.continue_draft"));
    const payload = draft.parkedPayload;

    if (folded === newLabel && payload) {
      // Start a fresh draft from the held payload; park the current one.
      const nowIso = new Date(deps.clock.now()).toISOString();
      const parkedCur = draft.docId;
      const fresh = this.openFresh(draft.chatId, nowIso);
      fresh.parkedDocId = parkedCur;
      // Clear the park marker on the old draft so it isn't re-triggered.
      deps.drafts.saveRevision({ ...draft, parkedPayload: undefined, updatedAt: nowIso });
      deps.drafts.saveRevision(fresh);
      return this.collect(
        fresh,
        { chatId: draft.chatId },
        payload.text,
        payload.mediaPaths,
        nowIso,
      );
    }

    if (folded === appendLabel && payload) {
      // Append the held payload onto the existing draft (reporter chose merge).
      const nowIso = new Date(deps.clock.now()).toISOString();
      const cleared: IntakeDraft = { ...draft, parkedPayload: undefined, updatedAt: nowIso };
      deps.drafts.saveRevision(cleared);
      return this.collect(
        cleared,
        { chatId: draft.chatId },
        payload.text,
        payload.mediaPaths,
        nowIso,
      );
    }

    return null; // not a park answer
  }

  // ── existing-ticket commands (ADR-0008) ─────────────────────────────────────

  private async routeExistingTicket(
    draft: IntakeDraft | null,
    text: string,
    mediaPaths: string[],
  ): Promise<StepOutput | null> {
    const { deps } = this;
    if (!deps.commands) return null;

    const candidates = this.buildCandidates(draft, text);
    if (candidates.length === 0) return null;

    const command = await deps.commands.interpret({
      message: text,
      attachments: mediaPaths.length,
      candidates,
      draftTitle: draft && !CLOSED_STATUSES.has(draft.status) ? draft.ticket.title : undefined,
    });
    if (command.action === "new" || command.action === "unclear") return null;

    const target = candidates.find(
      (c) => c.identifier.toUpperCase() === targetId(command).toUpperCase(),
    );
    if (!target) return null;

    // Lookup is read-only; ownership gates only WRITES (ADR-0008 §6).
    if (command.action === "lookup") {
      return this.lookup(target, draft);
    }

    const own = this.isOwn(target, draft);
    if (!own) {
      return {
        outcome: "not_owner",
        messages: [{ text: deps.copy.text("lookup.not_owner", { identifier: target.identifier }) }],
      };
    }

    // A write to an existing ticket NEVER happens here — show a preview + button (ADR-0008).
    return this.previewAction(draft, command);
  }

  private lookup(target: ReplyCandidate, draft: IntakeDraft | null): StepOutput {
    const own = this.isOwn(target, draft);
    const key = own ? "lookup.status" : "lookup.not_owner";
    return {
      outcome: own ? "lookup" : "not_owner",
      messages: [{ text: this.deps.copy.text(key, { identifier: target.identifier, status: "" }) }],
      issue: { id: target.issueId, identifier: target.identifier },
    };
  }

  private previewAction(
    draft: IntakeDraft | null,
    command: Extract<TicketCommand, { action: "append" | "edit" | "move_created" }>,
  ): StepOutput {
    const { deps } = this;
    const nowIso = new Date(deps.clock.now()).toISOString();
    const chatId = draft?.chatId ?? "";
    const base = draft ?? this.openFresh(chatId, nowIso);

    let kind: "append" | "edit" | "move";
    let content: string | undefined;
    let instruction: string | undefined;
    let from: string | undefined;
    let previewKey: "action.preview_append" | "action.preview_edit" | "action.preview_move";
    let buttonKey: "button.confirm_append" | "button.confirm_edit" | "button.confirm_move";
    let identifier: string;

    if (command.action === "append") {
      kind = "append";
      identifier = command.identifier;
      content = cap(command.content, MAX_FOLLOW_UP_CHARS);
      previewKey = "action.preview_append";
      buttonKey = "button.confirm_append";
    } else if (command.action === "edit") {
      kind = "edit";
      identifier = command.identifier;
      instruction = command.instruction;
      previewKey = "action.preview_edit";
      buttonKey = "button.confirm_edit";
    } else {
      kind = "move";
      identifier = command.identifier;
      from = command.from;
      previewKey = "action.preview_move";
      buttonKey = "button.confirm_move";
    }

    const vars: Record<string, string> = { identifier, from: from ?? "" };
    const doLabel = deps.copy.text(buttonKey, vars);
    const cancelLabel = deps.copy.text("button.cancel_action");

    const withPending: IntakeDraft = {
      ...base,
      pendingTicketAction: { kind, identifier, content, instruction, from, confirmLabel: doLabel },
      updatedAt: nowIso,
    };
    deps.drafts.saveRevision(withPending);

    const previewVars: Record<string, string> = {
      identifier,
      from: from ?? "",
      content: content ?? "",
      instruction: instruction ?? "",
      changes: instruction ?? content ?? "",
    };
    return {
      outcome: "action_preview",
      messages: [
        {
          text: deps.copy.text(previewKey, previewVars),
          buttons: layoutButtons([
            { text: doLabel, callbackData: doLabel },
            { text: cancelLabel, callbackData: cancelLabel },
          ]),
        },
      ],
    };
  }

  private async resolvePendingAction(draft: IntakeDraft, text: string): Promise<StepOutput> {
    const { deps } = this;
    const pending = draft.pendingTicketAction!;
    const folded = foldButton(text);
    const nowIso = new Date(deps.clock.now()).toISOString();

    // Execute ONLY on an exact button match (ADR-0008; TECH-795/975/1013).
    if (folded === foldButton(pending.confirmLabel)) {
      deps.drafts.saveRevision({ ...draft, pendingTicketAction: undefined, updatedAt: nowIso });
      if (!deps.actions) {
        return {
          outcome: "action_canceled",
          messages: [{ text: deps.copy.text("action.canceled") }],
        };
      }
      const result = await deps.actions.execute({
        kind: pending.kind === "suggest" ? "append" : pending.kind,
        identifier: pending.identifier,
        content: pending.content,
        instruction: pending.instruction,
        from: pending.from,
      });
      const doneKey =
        pending.kind === "edit"
          ? "action.done_edit"
          : pending.kind === "move"
            ? "action.done_move"
            : "action.done_append";
      return {
        outcome: "action_done",
        messages: [
          {
            text: deps.copy.text(doneKey, {
              identifier: pending.identifier,
              from: pending.from ?? "",
            }),
          },
        ],
      };
    }

    const cancelLabel = foldButton(deps.copy.text("button.cancel_action"));
    if (folded === cancelLabel) {
      deps.drafts.saveRevision({ ...draft, pendingTicketAction: undefined, updatedAt: nowIso });
      return {
        outcome: "action_canceled",
        messages: [{ text: deps.copy.text("action.canceled") }],
      };
    }

    // Anything else: the reporter did not confirm — do NOT write. Keep pending.
    return { outcome: "action_preview", messages: [{ text: deps.copy.text("action.canceled") }] };
  }

  // ── small pieces ────────────────────────────────────────────────────────────

  private summaryOutput(draft: IntakeDraft, gate: ReturnType<typeof evaluateGate>): StepOutput {
    const { deps } = this;
    const recap = buildRecap(deps.catalog, this.toRecord(draft), gate);
    const hint = deps.copy.text("summary.confirm_hint");
    const confirmLabel = deps.copy.text("button.confirm_create");
    return {
      outcome: "summary",
      messages: [
        {
          text: `${recap}\n\n${hint}`.trim(),
          buttons: layoutButtons([{ text: confirmLabel, callbackData: confirmLabel }]),
        },
      ],
    };
  }

  private resolvePriority(draft: IntakeDraft, extracted: ExtractedFields): Priority {
    const { deps } = this;
    const evidence = { ...(draft.evidence ?? {}), ...(extracted.evidence ?? {}) };
    const verdict = evaluatePriorityRules(deps.urgencyRules, "Medium", evidence);
    const requested =
      extracted.requestedPriority && extracted.requestedPriorityReason
        ? {
            level: titleCase(extracted.requestedPriority),
            reason: extracted.requestedPriorityReason,
          }
        : undefined;
    const resolved = resolveRequestedPriority(
      deps.urgencyRules.levels,
      verdict.allowedLevel,
      requested,
    );
    draft.evidence = evidence;
    return toPriority(resolved.level);
  }

  private mergeIntoDraft(
    open: IntakeDraft | null,
    input: StepInput,
    extracted: ExtractedFields,
    text: string,
    mediaPaths: string[],
    nowIso: string,
    declined: boolean,
  ): IntakeDraft {
    const { deps } = this;
    const base = open ?? this.openFresh(input.chatId, nowIso);
    const ticket = { ...base.ticket };

    // Title: fill if empty, or refresh when new content arrives (not locked).
    // Câu trả lời từ chối ("không biết") KHÔNG đổi tiêu đề (legacy: structuredOnly).
    if (
      !declined &&
      extracted.title &&
      (extracted.titleExplicit || !ticket.title || (extracted.symptoms?.length ?? 0) > 0)
    ) {
      ticket.title = cap(extracted.title.trim(), 120);
    }

    // rawText = reporter VERBATIM, appended across turns, capped (ADR-0010, §2).
    // - Một tin dài hơn MAX_RAW_TEXT_CHARS bị cắt; tổng cả cuộc cắt ở
    //   MAX_RAW_TEXT_TOTAL_CHARS (đúng trần của legacy).
    // - Câu trả lời cho câu hỏi dữ kiện kỹ thuật LUÔN vào mô tả, kể cả khi
    //   chỉ là một mã (appendRawText của legacy).
    // - Câu trả lời từ chối ("không biết") KHÔNG vào mô tả.
    const message = truncate(text.trim(), MAX_RAW_TEXT_CHARS);
    const answeringTechQuestion =
      base.lastAskedFields?.includes(TECH_INFO_FIELD) === true && !declined;
    const carriesText =
      !declined &&
      ((extracted.symptoms?.length ?? 0) > 0 ||
        hasIdentifier(extracted) ||
        extracted.userIntent === "provide_info" ||
        answeringTechQuestion);
    if (carriesText && message) {
      ticket.rawText =
        ticket.rawText && !ticket.rawText.includes(message)
          ? cap(`${ticket.rawText}\n${message}`, MAX_RAW_TEXT_TOTAL_CHARS)
          : ticket.rawText || cap(message, MAX_RAW_TEXT_TOTAL_CHARS);
    }

    // Identifiers: fill blanks only — a created/collected id is never overwritten.
    const record = base.record ?? {
      variant: deps.variant,
      values: {},
      questionCount: {},
      explicitlyMissing: [],
    };
    const values = { ...record.values, ...(extracted.values ?? {}) };
    for (const key of IDENTIFIER_KEYS) {
      const incoming = extracted.identifiers?.[key];
      if (incoming && !values[key]) values[key] = incoming;
    }

    // Media unioned, de-duped (§2).
    ticket.mediaPaths = Array.from(new Set([...(ticket.mediaPaths ?? []), ...mediaPaths]));

    return {
      ...base,
      status: "collecting",
      ticket,
      reporter: input.reporter ?? base.reporter,
      record: { ...record, variant: deps.variant, values },
      evidence: { ...(base.evidence ?? {}), ...(extracted.evidence ?? {}) },
      updatedAt: nowIso,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private openFresh(chatId: string, nowIso: string): IntakeDraft {
    return newDraft(this.genDocId(), chatId, nowIso);
  }

  private closeAndReopen(draft: IntakeDraft, nowIso: string): IntakeDraft {
    this.deps.drafts.saveRevision({ ...draft, status: "expired", updatedAt: nowIso });
    const fresh = this.openFresh(draft.chatId, nowIso);
    this.deps.drafts.saveRevision(fresh);
    return fresh;
  }

  private genDocId(): string {
    return this.deps.genDocId
      ? this.deps.genDocId()
      : `doc-${this.deps.clock.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private toRecord(draft: IntakeDraft): IntakeRecord {
    const r = draft.record;
    const record = createRecord(r?.variant ?? this.deps.variant, { ...(r?.values ?? {}) });
    record.questionCount = { ...(r?.questionCount ?? {}) };
    record.explicitlyMissing = [...(r?.explicitlyMissing ?? [])].filter((f) => f !== "__tech");
    return record;
  }

  private writeRecordBack(
    draft: IntakeDraft,
    record: IntakeRecord,
    effective: Record<string, string>,
  ): void {
    draft.record = {
      variant: record.variant,
      values: { ...record.values, ...effective },
      questionCount: { ...record.questionCount, ...(draft.record?.questionCount ?? {}) },
      explicitlyMissing: [
        ...new Set([...(draft.record?.explicitlyMissing ?? []), ...record.explicitlyMissing]),
      ],
    };
  }

  private bumpAsked(draft: IntakeDraft, fields: string[]): void {
    const rec = draft.record ?? {
      variant: this.deps.variant,
      values: {},
      questionCount: {},
      explicitlyMissing: [],
    };
    for (const f of fields) rec.questionCount[f] = (rec.questionCount[f] ?? 0) + 1;
    draft.record = rec;
  }

  private draftIdentifiers(draft: IntakeDraft): Partial<Record<IdentifierKey, string>> {
    const out: Partial<Record<IdentifierKey, string>> = {};
    const values = draft.record?.values ?? {};
    for (const key of IDENTIFIER_KEYS) if (values[key]) out[key] = values[key];
    return out;
  }

  private mentionsExistingTicket(text: string): boolean {
    const prefix = this.deps.identifierPrefix;
    if (!prefix) return false;
    return mentionedIdentifiers(text, prefix).length > 0;
  }

  private buildCandidates(draft: IntakeDraft | null, text: string): ReplyCandidate[] {
    const { deps } = this;
    const out = new Map<string, ReplyCandidate>();

    // The just-created ticket in this chat (a move_created candidate).
    if (draft?.status === "created" && draft.issueId && draft.issueIdentifier) {
      const createdAt = Date.parse(draft.issueCreatedAt ?? draft.updatedAt);
      const fresh =
        !Number.isNaN(createdAt) && deps.clock.now() - createdAt <= JUST_CREATED_WINDOW_MS;
      out.set(draft.issueIdentifier.toUpperCase(), {
        identifier: draft.issueIdentifier,
        issueId: draft.issueId,
        title: draft.ticket.title,
        ownTicket: true,
        mentioned: false,
        justCreated: fresh,
      });
    }

    // Explicitly mentioned ids resolve against the binding store.
    if (deps.identifierPrefix) {
      for (const id of mentionedIdentifiers(text, deps.identifierPrefix)) {
        const binding = deps.bindings.getLatestBinding(draft?.chatId ?? "", deps.identifierPrefix);
        const existing = out.get(id.toUpperCase());
        if (existing) {
          existing.mentioned = true;
        } else {
          out.set(id.toUpperCase(), {
            identifier: id,
            issueId: binding?.identifier?.toUpperCase() === id.toUpperCase() ? binding.issueId : 0,
            title: binding?.title,
            ownTicket: binding?.identifier?.toUpperCase() === id.toUpperCase(),
            mentioned: true,
          });
        }
      }
    }
    return [...out.values()];
  }

  private isOwn(target: ReplyCandidate, draft: IntakeDraft | null): boolean {
    if (target.ownTicket) return true;
    const ownership = this.deps.ownership;
    if (!ownership) return false;
    return ownership.isOwnTicket({ identifier: target.identifier, chatId: draft?.chatId ?? "" });
  }
}

// ── module-level pure helpers ────────────────────────────────────────────────

function hasIdentifier(e: ExtractedFields): boolean {
  const ids = e.identifiers ?? {};
  return IDENTIFIER_KEYS.some((k) => (ids[k] ?? "").trim() !== "");
}

function cap(text: string | undefined, max: number): string {
  const s = text ?? "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Cắt thẳng, không thêm dấu "…" (dùng cho ngữ cảnh và cho phần tin gốc). */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function toPriority(level: string): Priority {
  const l = level.toLowerCase();
  return (["urgent", "high", "medium", "low"] as const).find((x) => x === l) ?? "medium";
}

function targetId(command: TicketCommand): string {
  if (
    command.action === "append" ||
    command.action === "edit" ||
    command.action === "lookup" ||
    command.action === "move_created"
  ) {
    return command.identifier;
  }
  return "";
}

function command_chatId(_command: TicketCommand, draft: IntakeDraft | null): string {
  return draft?.chatId ?? "";
}

async function safeReview(
  reviewer: TechReviewerPort,
  input: {
    title?: string;
    description: string;
    attachments: number;
    known: Record<string, string>;
  },
): Promise<{ missing: string[]; question?: string }> {
  try {
    return await reviewer.review(input);
  } catch {
    return { missing: [] }; // any failure/timeout proceeds (§2 tech-review)
  }
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* post-create hooks never block the reporter */
  }
}
