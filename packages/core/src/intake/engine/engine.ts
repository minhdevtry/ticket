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
import { stripChannelEnvelope, isInternalCallbackToken } from "../../core";
import type {
  Clock,
  CopyCatalog,
  CopyKey,
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
  MessageRouteStore,
} from "../ports";
import { IDENTIFIER_KEYS, bindingOwnershipPort } from "../ports";
import type { DraftRepository } from "../draft/repository";
import { isExpiredDraft, INTAKE_DRAFT_TTL_MS, chatIdVariants } from "../draft/repository";
import type { IntakeDraft, SplitBlock } from "../draft/types";
import { newDraft, CLOSED_STATUSES } from "../draft/types";
import { splitMultiIncidentReport, classifySplitReply } from "../split";
import { legacyActionForOutcome } from "./action-map";
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
  type GateResult,
} from "../gate";
import { evaluatePriorityRules, resolveRequestedPriority, type UrgencyRules } from "../priority";
import {
  findIdentifierConflict,
  extractLabelledIdentifiers,
  identityConflict,
} from "./identifiers";
import {
  mentionedIdentifiers,
  foldButton,
  saysNewIncident,
  stripNewIncidentDeclaration,
  withTypedDetail,
  stripSupplementCommandWrapper,
  classifyCancelOrCloseIntent,
  isCancelOrCloseTicketRequest,
  isProgressInquiry,
} from "./text";
import { applyEditOps, descriptionBody, planEdit, type EditOp } from "./edit";
import { markBotComment, isBotComment } from "../../core/formatting";
import { isSystemActor } from "../notify/supplement-notifier";
import { isDeclineAnswer, isMeaninglessInput, TECH_INFO_FIELD } from "./normalize";
import type { LlmConfig, CompleteFn } from "../extractor/llm-extractor";
import { MAX_RAW_TEXT_CHARS, MAX_RAW_TEXT_TOTAL_CHARS } from "../raw-text";
import type { StepInput, StepOutput } from "./types";
import { type ReplayOraclePort, applyReplayControlOverride } from "./oracle";
import {
  isInvalidTitle,
  deriveFallbackTitle,
  isExplicitCancel,
  isChitchat,
  isShortConfirmation,
} from "../extractor/heuristics";
import {
  isIssueClosed,
  resolveSupplementMentionTarget,
  formatSupplementComment,
  notifyOnCallSupplement,
} from "../notify/supplement-notifier";
import { SCOPE_RANK, EVIDENCE_FLAGS } from "../extractor/merger";

/** Max chars of ONE reporter message kept in rawText (legacy parity). */
export { MAX_RAW_TEXT_CHARS, MAX_RAW_TEXT_TOTAL_CHARS } from "../raw-text";
/** Max chars for an append/follow-up to an existing ticket (§2). */
export const MAX_FOLLOW_UP_CHARS = 4000;
/** A just-created ticket can be moved into another within this window. */
export const JUST_CREATED_WINDOW_MS = 24 * 3_600_000;
/** Tech question window through message routes (72 hours). */
export const TECH_QUESTION_WINDOW_MS = 72 * 3_600_000;
/** Progress lookup window without identifier (30 minutes). */
export const LOOKUP_WINDOW_MS = 30 * 60_000;

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
  /** Which catalog variant to collect under, or a function resolving it per turn. */
  variant: string | ((draft: IntakeDraft, record: IntakeRecord) => string);
  /** Optional system field name (e.g. "he_thong" or "system"). Auto-detected if omitted. */
  systemField?: string;
  /** Optional department field name (e.g. "phong_ban" or "reporting_dept"). Auto-detected if omitted. */
  departmentField?: string;
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
  notifier?: { broadcastAlert?: (text: string) => Promise<void> };
  /** Display name of the bot for alerts / logs (defaults to "Bot"). */
  botName?: string;
  /** Specific actor names or pattern to ignore when resolving mention targets (e.g. other bots). */
  ignoredActors?: string[] | RegExp;
  /** Route store for tracking technical questions sent to the reporter. */
  routes?: MessageRouteStore;
  /** Custom edit planner for editing tickets. */
  editPlanner?: (input: {
    title: string;
    description: string;
    instruction: string;
  }) => Promise<EditOp[]>;
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

    // 0. Bấm nút "Tiếp tục sự cố đang chờ" — nhắc ở ticket_created/canceled của sự
    //    cố vừa xong. Đưa tờ khai bị gác lại trở thành tài liệu đang mở.
    const resumeLabel = foldButton(deps.copy.text("button.resume_parked"));
    if (
      draft?.parkedDocId &&
      CLOSED_STATUSES.has(draft.status) &&
      foldButton(text) === resumeLabel
    ) {
      const resumed = await this.resumeParkedDraft(draft.parkedDocId, nowIso);
      if (resumed) return resumed;
    }

    // 1. A write to an existing ticket is awaiting the reporter's button (ADR-0008).
    if (draft?.pendingTicketAction) {
      return this.resolvePendingAction(draft, text, mediaPaths, nowIso);
    }

    // 2. A park ("new incident or append?") is awaiting the reporter's choice (TECH-928).
    if (draft?.parkedPayload) {
      return this.resolvePark(draft, text, mediaPaths);
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

    // 3.05. A split question ("split N tickets or keep 1?") is awaiting the reporter's choice (W29-SPLIT).
    if (draft?.pendingSplit) {
      return this.resolvePendingSplit(draft, input, text, mediaPaths, nowIso);
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

    // 5. Existing ticket commands (e.g. "bổ sung TECH-X", "sửa TECH-X", lookup)
    const routed = await this.routeExistingTicket(draft, input.chatId, text, mediaPaths);
    if (routed) return routed;

    // 5.1 Post-create ticket flow (RFC 0002 PR 10, C1-C4, G2, B8):
    if (draft && draft.status === "created" && draft.issueId) {
      return this.handlePostCreate(draft, input, text, mediaPaths, nowIso);
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
    options?: { skipConflictCheck?: boolean; preExtracted?: ExtractedFields },
  ): Promise<StepOutput> {
    const { deps } = this;
    const open = existing && !CLOSED_STATUSES.has(existing.status) ? existing : null;
    // "không biết" / "không có" — người báo nói rõ là không trả lời được câu
    // vừa hỏi (A13). Luật tất định, không nhờ LLM.
    const declined = isDeclineAnswer(text);

    const extracted =
      options?.preExtracted ??
      (await deps.extractor.extract({
        text,
        attachments: mediaPaths.length,
        draftTitle: open?.ticket.title || undefined,
        context: this.buildExtractContext(existing),
      }));

    // A plain confirm with no live draft summary is chitchat here; the write
    // path's confirmation protocol owns real confirms once a summary is shown.
    if (extracted.userIntent === "cancel") {
      if (open) {
        deps.drafts.saveRevision({
          ...open,
          status: "canceled",
          pendingSplit: undefined,
          pendingSplitQueue: undefined,
          updatedAt: nowIso,
        });
      }
      const out: StepOutput = {
        outcome: "canceled",
        messages: [{ text: deps.copy.text("draft.canceled") }],
        docId: open?.docId,
      };
      return open ? this.appendParkedReminder(out, open) : out;
    }

    // PR 9: Nhận diện báo cáo có nhiều học sinh/sự cố trong cùng một tin nhắn (W29-SPLIT, TECH-1146)
    if (!options?.skipConflictCheck && (!open || !open.ticket.rawText.trim())) {
      const splitBlocks = splitMultiIncidentReport(text);
      if (splitBlocks && splitBlocks.length >= 2) {
        return this.parkForSplitDecision(
          open ?? this.openFresh(input.chatId, nowIso),
          splitBlocks,
          mediaPaths,
          nowIso,
        );
      }
    }

    // A completed report arriving while another draft is mid-collection, OR a
    // conflicting identifier, parks instead of silently merging (TECH-928, E2E 28/09).
    if (open && !options?.skipConflictCheck) {
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
    const draft = this.mergeIntoDraft(
      open,
      input,
      extracted,
      text,
      mediaPaths,
      nowIso,
      declined,
      options?.skipConflictCheck,
    );

    // A2: Chưa có mô tả sự cố (chỉ có ảnh hoặc chào thuần tuý)
    const onlyMedia = mediaPaths.length > 0 && text.trim().length === 0;
    const isGreetingOnly =
      extracted.userIntent === "chitchat" &&
      !draft.ticket.rawText.trim() &&
      !draft.ticket.title.trim() &&
      (draft.symptoms?.length ?? 0) === 0;

    if (onlyMedia && !this.hasDescription(draft)) {
      draft.status = "collecting";
      this.bumpAsked(draft, ["short_description"]);
      draft.lastAskedFields = ["short_description"];
      deps.drafts.saveRevision(draft);
      const item = deps.copy.text("ask.describe_incident_item");
      return {
        outcome: "asked",
        messages: [{ text: deps.copy.text("ask.describe_incident", { item }) }],
        missingFields: ["short_description"],
        docId: draft.docId,
      };
    }

    if (isGreetingOnly) {
      deps.drafts.saveRevision(draft);
      return {
        outcome: "clarify",
        messages: [{ text: deps.copy.text("clarify.greeting") }],
        docId: draft.docId,
      };
    }

    // "không biết" → trường vừa hỏi vào explicitlyMissing, bot thôi hỏi trường đó.
    if (declined && draft.lastAskedFields?.length) {
      const rec = draft.record ?? {
        variant: this.resolveVariant(draft),
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
      const firstField = gate.fieldsToAsk[0];
      const deptField = this.resolveDeptField(record.variant);
      let question: string;
      if (
        draft.unrecognizedDept &&
        gate.fieldsToAsk.length === 1 &&
        deptField &&
        firstField === deptField
      ) {
        question = deps.copy.text("ask.unrecognized_dept", { dept: draft.unrecognizedDept });
      } else {
        question = gate.questionText || deps.copy.text("ask.opening");
      }
      const buttons = this.questionButtons(firstField, draft);
      return {
        outcome: "asked",
        messages: [{ text: question, ...(buttons ? { buttons } : {}) }],
        missingFields: gate.missingRequired,
        docId: draft.docId,
      };
    }

    // Kịch bản B' (A3): hỏi hệ thống MỘT lần kèm nút ngoài gate
    const systemField = this.resolveSystemField(record.variant);
    if (systemField) {
      const systemValue = record.values[systemField];
      const systemKnown = Boolean(systemValue && systemValue.trim().length > 0);
      const explicitlyMissing = new Set(draft.record?.explicitlyMissing ?? []);
      const askedCount = draft.record?.questionCount?.[systemField] ?? 0;
      const systemSettled = explicitlyMissing.has(systemField) || askedCount >= 1;
      if (!systemKnown && !systemSettled) {
        this.bumpAsked(draft, [systemField]);
        draft.lastAskedFields = [systemField];
        deps.drafts.saveRevision(draft);
        const question = deps.copy.text("ask.system");
        const buttons = this.questionButtons(systemField, draft);
        return {
          outcome: "asked",
          messages: [{ text: question, ...(buttons ? { buttons } : {}) }],
          missingFields: [systemField],
          docId: draft.docId,
        };
      }
    }

    // Xin gấp mà chưa nói lý do (A4): hỏi MỘT lần
    const reqPri = draft.requestedPriority;
    const level = reqPri?.level;
    const hasReason = Boolean(reqPri?.reason?.trim());
    const askedPriorityReason = (draft.record?.questionCount?.priority_reason ?? 0) >= 1;
    if (level && !hasReason && !askedPriorityReason) {
      this.bumpAsked(draft, ["priority_reason"]);
      draft.lastAskedFields = ["priority_reason"];
      deps.drafts.saveRevision(draft);
      const want = deps.copy.text(`priority.level.${level}` as const);
      const question = deps.copy.text("ask.priority_reason", { level: want });
      return {
        outcome: "asked",
        messages: [{ text: question }],
        missingFields: [],
        docId: draft.docId,
      };
    }

    // Chốt tiêu đề (B3): tiêu đề không bao giờ là tên người hay mã trần
    if (!draft.ticket.title || isInvalidTitle(draft.ticket.title, draft.ticket.rawText)) {
      const fallback = deriveFallbackTitle(draft.ticket.rawText, draft.symptoms);
      const defaultTitle = deps.copy.text("ticket.fallback_title");
      draft.ticket.title = fallback && !isInvalidTitle(fallback) ? fallback : defaultTitle;
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
        return { outcome: "asked", messages: [{ text: review.question }], docId: draft.docId };
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
  private resolveVariant(draft: IntakeDraft | null, record?: IntakeRecord): string {
    if (typeof this.deps.variant === "function") {
      const d = draft ?? ({} as IntakeDraft);
      const r = record ??
        d.record ?? {
          variant: "",
          values: {},
          questionCount: {},
          explicitlyMissing: [],
        };
      return this.deps.variant(d, r);
    }
    return this.deps.variant ?? Object.keys(this.deps.catalog.variants)[0] ?? "default";
  }

  private resolveSystemField(variantKey?: string): string | undefined {
    if (this.deps.systemField) return this.deps.systemField;
    const vKey = variantKey ?? this.resolveVariant(null);
    const variant = this.deps.catalog.variants[vKey];
    if (!variant) return undefined;
    for (const [name, field] of Object.entries(variant.fields)) {
      if (field.role === "system" || name === "system") {
        return name;
      }
    }
    return undefined;
  }

  private resolveDeptField(variantKey?: string): string | undefined {
    if (this.deps.departmentField) return this.deps.departmentField;
    const vKey = variantKey ?? this.resolveVariant(null);
    const variant = this.deps.catalog.variants[vKey];
    if (!variant) return undefined;
    for (const [name, field] of Object.entries(variant.fields)) {
      if (field.role === "department" || name === "department") {
        return name;
      }
    }
    return undefined;
  }

  private hasDescription(draft: IntakeDraft): boolean {
    const title = draft.ticket.title;
    const rawText = draft.ticket.rawText;
    const symptoms = (draft.symptoms ?? []).filter((s) => !isInternalCallbackToken(s));
    const hasTitle = Boolean(title && !isInternalCallbackToken(title));
    const hasRaw = Boolean(rawText && !isInternalCallbackToken(rawText));
    return hasTitle || symptoms.length > 0 || hasRaw;
  }

  /** Nút lựa chọn cho câu hỏi, khi trường vừa hỏi là enum có danh mục. */
  private questionButtons(
    fieldName: string | undefined,
    draft?: IntakeDraft | null,
  ): InlineButton[][] | undefined {
    if (!fieldName) return undefined;
    const variantKey = this.resolveVariant(draft ?? null);
    const variant = this.deps.catalog.variants[variantKey];
    const field = variant?.fields[fieldName];
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
        const post = deps.postCreate;
        if (post) {
          await safe(() =>
            post.afterCreate({
              issue: result.issue,
              description: draft.ticket.rawText,
              chatId: draft.chatId,
            }),
          );
        }
        const nowIso = new Date(deps.clock.now()).toISOString();

        // PR 9: Nếu còn sự cố trong hàng đợi tách (W29-SPLIT): tự động chuyển sang sự cố tiếp theo
        if (draft.pendingSplitQueue && draft.pendingSplitQueue.length > 0) {
          const [nextBlock, ...remainingQueue] = draft.pendingSplitQueue;
          const nextDoc = this.openFresh(draft.chatId, nowIso);
          nextDoc.pendingSplitQueue = remainingQueue.length > 0 ? remainingQueue : undefined;
          nextDoc.mediaAmbiguous = draft.mediaAmbiguous;
          nextDoc.parkedDocId = draft.docId;

          const deptField = this.resolveDeptField(draft.record?.variant);
          const inheritedDept =
            nextBlock.reportingDept ??
            (deptField && draft.record?.values?.[deptField]
              ? draft.record.values[deptField]
              : undefined);
          if (inheritedDept && deptField) {
            nextDoc.record = {
              variant: this.resolveVariant(nextDoc),
              values: { [deptField]: inheritedDept },
              questionCount: {},
              explicitlyMissing: [],
            };
          }
          if (draft.reporter) {
            nextDoc.reporter = draft.reporter;
          }
          deps.drafts.saveRevision(nextDoc);

          const nextResult = await this.collect(
            nextDoc,
            { chatId: draft.chatId },
            nextBlock.text,
            nextBlock.mediaPaths ?? [],
            nowIso,
            { skipConflictCheck: true },
          );

          const voiceNotice = nextBlock.studentName
            ? deps.copy.text("split.next_ticket_notice_student", {
                identifier: result.issue.identifier,
                studentName: nextBlock.studentName,
              })
            : deps.copy.text("split.next_ticket_notice", {
                identifier: result.issue.identifier,
              });

          const latestNextDoc = deps.drafts.getByDocId(nextDoc.docId) ?? nextDoc;
          const out: StepOutput = {
            outcome: "created",
            messages: [{ text: `${result.message} ${voiceNotice}` }, ...nextResult.messages],
            issue: {
              id: result.issue.id,
              identifier: result.issue.identifier,
              url: result.issue.url,
            },
            createdIssue: {
              id: result.issue.id,
              identifier: result.issue.identifier,
              title: result.issue.title,
              url: result.issue.url,
            },
            nextDraft: {
              docId: nextDoc.docId,
              outcome: nextResult.outcome,
              status: latestNextDoc.status,
              action: legacyActionForOutcome(nextResult.outcome) ?? undefined,
            },
            docId: nextDoc.docId,
          };
          return out;
        }

        const out: StepOutput = {
          outcome: "created",
          messages: [{ text: result.message }],
          issue: {
            id: result.issue.id,
            identifier: result.issue.identifier,
            url: result.issue.url,
          },
          docId: draft.docId,
        };
        return this.appendParkedReminder(out, draft);
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
    const existingLabelled = extractLabelledIdentifiers(open.ticket.rawText, {
      allowBarePhone: true,
    });
    const incomingLabelled = extractLabelledIdentifiers(text);
    const labelledConflict = identityConflict(existingLabelled, incomingLabelled);

    const incoming = extracted.identifiers ?? {};
    const existingIds = this.draftIdentifiers(open);
    const structuredConflict = findIdentifierConflict(existingIds, incoming);

    const conflict = labelledConflict != null || structuredConflict != null;

    const answeringTechQuestion = open.lastAskedFields?.includes(TECH_INFO_FIELD) === true;
    const answeringDescription = open.lastAskedFields?.includes("short_description") === true;
    const draftInProgress =
      Boolean(open.ticket.title) &&
      (Boolean(open.lastAskedFields?.length) || open.status === "ready_for_confirmation");

    const isFullNewReport =
      draftInProgress &&
      !answeringTechQuestion &&
      !answeringDescription &&
      extracted.userIntent === "report_issue" &&
      (extracted.symptoms?.length ?? 0) > 0 &&
      text.length > 0;

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
    mediaPaths: string[],
  ): Promise<StepOutput> {
    const { deps } = this;
    const folded = foldButton(text);
    const newLabel = foldButton(deps.copy.text("button.new_incident"));
    const appendLabel = foldButton(deps.copy.text("button.continue_draft"));
    const payload = draft.parkedPayload;
    if (!payload) {
      return {
        outcome: "parked",
        messages: [{ text: deps.copy.text("park.unclear") }],
      };
    }

    const bufferedMedia = Array.from(new Set([...payload.mediaPaths, ...mediaPaths]));

    // 1. Chọn "Sự cố mới" (bấm nút hoặc gõ "ticket mới ạ")
    if (folded === newLabel || saysNewIncident(text)) {
      const nowIso = new Date(deps.clock.now()).toISOString();
      const parkedCur = draft.docId;
      const fresh = this.openFresh(draft.chatId, nowIso);
      fresh.parkedDocId = parkedCur;
      // Clear the park marker on the old draft so it isn't re-triggered.
      deps.drafts.saveRevision({ ...draft, parkedPayload: undefined, updatedAt: nowIso });
      deps.drafts.saveRevision(fresh);
      const replayText = withTypedDetail(payload.text, text);
      return this.collect(fresh, { chatId: draft.chatId }, replayText, bufferedMedia, nowIso);
    }

    // 2. Chọn "Bổ sung sự cố đang chờ" (gộp tin B vào tờ khai A)
    if (
      folded === appendLabel ||
      text.toLowerCase().includes(deps.copy.text("button.continue_draft").toLowerCase())
    ) {
      const nowIso = new Date(deps.clock.now()).toISOString();
      const cleared: IntakeDraft = { ...draft, parkedPayload: undefined, updatedAt: nowIso };
      deps.drafts.saveRevision(cleared);
      return this.collect(cleared, { chatId: draft.chatId }, payload.text, bufferedMedia, nowIso, {
        skipConflictCheck: true,
      });
    }

    // 3. Người dùng gõ "thôi huỷ": bỏ tin vừa park, tờ khai A giữ nguyên
    if (isExplicitCancel(text)) {
      const nowIso = new Date(deps.clock.now()).toISOString();
      const cleared: IntakeDraft = { ...draft, parkedPayload: undefined, updatedAt: nowIso };
      deps.drafts.saveRevision(cleared);
      const title = cleared.ticket.title || "";
      return {
        outcome: "canceled",
        messages: [{ text: deps.copy.text("park.canceled", { title }) }],
      };
    }

    // 4. Trả lời không rõ (không bấm 1 trong 2 nút): hỏi lại, không đoán, không mất dữ liệu bên nào
    const newIncidentButton = deps.copy.text("button.new_incident");
    const continueDraftButton = deps.copy.text("button.continue_draft");
    return {
      outcome: "parked",
      messages: [
        {
          text: deps.copy.text("park.unclear"),
          buttons: layoutButtons([
            { text: newIncidentButton, callbackData: newIncidentButton },
            { text: continueDraftButton, callbackData: continueDraftButton },
          ]),
        },
      ],
    };
  }

  private appendParkedReminder(output: StepOutput, draft: IntakeDraft): StepOutput {
    if (!draft.parkedDocId) return output;
    const parked = this.deps.drafts.getByDocId(draft.parkedDocId);
    if (
      !parked ||
      CLOSED_STATUSES.has(parked.status) ||
      isExpiredDraft(parked, this.deps.clock.now(), this.deps.draftTtlMs ?? INTAKE_DRAFT_TTL_MS)
    ) {
      return output;
    }

    const title = parked.ticket.title || "";
    const reminder = this.deps.copy.text("park.reminder", { title });
    const resumeButton = this.deps.copy.text("button.resume_parked");

    const messages = output.messages.map((m, idx) => {
      if (idx !== output.messages.length - 1) return m;
      return {
        ...m,
        text: m.text + reminder,
        buttons: [...(m.buttons ?? []), [{ text: resumeButton, callbackData: resumeButton }]],
      };
    });

    return {
      ...output,
      messages,
    };
  }

  // ── split multi-incident report (W29-SPLIT, TECH-1146, PR 9) ───────────────

  private parkForSplitDecision(
    draft: IntakeDraft,
    blocks: SplitBlock[],
    mediaPaths: string[],
    nowIso: string,
  ): StepOutput {
    const parked: IntakeDraft = {
      ...draft,
      revision: draft.revision + 1,
      updatedAt: nowIso,
      pendingSplit: {
        blocks,
        mediaPaths,
        askedAt: nowIso,
      },
    };
    this.deps.drafts.saveRevision(parked);
    return this.splitQuestionOutput(parked, blocks);
  }

  private splitQuestionOutput(draft: IntakeDraft, blocks: SplitBlock[], prefix = ""): StepOutput {
    const { deps } = this;
    const names = blocks
      .map((b) => b.studentName || b.customerId)
      .filter((name): name is string => Boolean(name));
    const count = blocks.length;
    const questionText = `${prefix}${
      names.length > 0
        ? deps.copy.text("split.question", {
            count,
            summary: names.join(", "),
          })
        : deps.copy.text("split.question_no_names", {
            count,
          })
    }`;
    const splitLabel = deps.copy.text("button.split_n", { count });
    const mergeLabel = deps.copy.text("button.merge_one");
    return {
      outcome: "split_question",
      messages: [
        {
          text: questionText,
          buttons: [
            [
              { text: splitLabel, callbackData: splitLabel },
              { text: mergeLabel, callbackData: mergeLabel },
            ],
          ],
        },
      ],
      docId: draft.docId,
    };
  }

  private async resolvePendingSplit(
    draft: IntakeDraft,
    input: StepInput,
    message: string,
    mediaPaths: string[],
    nowIso: string,
  ): Promise<StepOutput> {
    const buffered = draft.pendingSplit;
    if (!buffered) {
      return { outcome: "clarify", messages: [] };
    }
    const decision = classifySplitReply(message);

    if (decision === "split") {
      const [firstBlock, ...restBlocks] = buffered.blocks;
      const sharedMedia = Array.from(new Set([...buffered.mediaPaths, ...mediaPaths]));
      const ambiguous = sharedMedia.length > 0 && buffered.blocks.length > 1;
      for (const b of restBlocks) {
        b.mediaPaths = sharedMedia;
      }

      const activeDoc: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        pendingSplit: undefined,
        pendingSplitQueue: restBlocks.length > 0 ? restBlocks : undefined,
        mediaAmbiguous: ambiguous,
        updatedAt: nowIso,
      };
      this.deps.drafts.saveRevision(activeDoc);

      const firstText = [firstBlock.text, ...(buffered.extraText ?? [])]
        .filter(Boolean)
        .join("\n\n");
      return this.collect(activeDoc, input, firstText, sharedMedia, nowIso, {
        skipConflictCheck: true,
      });
    }

    if (decision === "merge") {
      return this.mergeParkedSplit(
        draft,
        input,
        buffered,
        buffered.extraText ?? [],
        Array.from(new Set([...buffered.mediaPaths, ...mediaPaths])),
        nowIso,
      );
    }

    const extracted = await this.deps.extractor
      .extract({
        text: message,
        attachments: mediaPaths.length,
        context: this.buildExtractContext(draft),
      })
      .catch(() => null);

    if (extracted?.userIntent === "cancel") {
      const movedOn: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        pendingSplit: undefined,
        pendingSplitQueue: undefined,
        updatedAt: nowIso,
      };
      this.deps.drafts.saveRevision(movedOn);
      return this.collect(movedOn, input, message, mediaPaths, nowIso, {
        skipConflictCheck: true,
      });
    }

    return this.handleUnclearSplitReply(draft, input, message, mediaPaths, buffered, nowIso);
  }

  private async handleUnclearSplitReply(
    draft: IntakeDraft,
    input: StepInput,
    message: string,
    mediaPaths: string[],
    buffered: NonNullable<IntakeDraft["pendingSplit"]>,
    nowIso: string,
  ): Promise<StepOutput> {
    const carriedText = message.trim() && !isInternalCallbackToken(message) ? message.trim() : "";
    const duplicated =
      carriedText !== "" && buffered.blocks.some((b) => b.text.includes(carriedText));
    const extraText =
      carriedText && !duplicated
        ? [...(buffered.extraText ?? []), carriedText]
        : (buffered.extraText ?? []);
    const mergedMedia = Array.from(new Set([...buffered.mediaPaths, ...mediaPaths]));
    const reasked = (buffered.clarifyCount ?? 0) >= 1;

    if (!reasked) {
      const retry: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        pendingSplit: { ...buffered, mediaPaths: mergedMedia, extraText, clarifyCount: 1 },
        updatedAt: nowIso,
      };
      this.deps.drafts.saveRevision(retry);
      const prefix = this.deps.copy.text("split.unclear_prefix");
      return this.splitQuestionOutput(retry, buffered.blocks, prefix);
    }

    return this.mergeParkedSplit(draft, input, buffered, extraText, mergedMedia, nowIso);
  }

  private async mergeParkedSplit(
    draft: IntakeDraft,
    input: StepInput,
    buffered: NonNullable<IntakeDraft["pendingSplit"]>,
    extraText: string[],
    mediaPaths: string[],
    nowIso: string,
  ): Promise<StepOutput> {
    const combinedText = [...buffered.blocks.map((b) => b.text), ...extraText]
      .filter(Boolean)
      .join("\n\n");
    const studentNames = buffered.blocks.map((b) => b.studentName).filter(Boolean) as string[];
    const mergedDoc: IntakeDraft = {
      ...draft,
      revision: draft.revision + 1,
      pendingSplit: undefined,
      pendingSplitQueue: undefined,
      updatedAt: nowIso,
    };
    this.deps.drafts.saveRevision(mergedDoc);

    const out = await this.collect(mergedDoc, input, combinedText, mediaPaths, nowIso, {
      skipConflictCheck: true,
    });

    const latest = this.deps.drafts.getByDocId(draft.docId) ?? mergedDoc;
    if (!latest.ticket.title || isInvalidTitle(latest.ticket.title, latest.ticket.rawText)) {
      const derived = deriveFallbackTitle(combinedText, latest.symptoms, studentNames);
      if (derived && !isInvalidTitle(derived)) {
        latest.ticket.title = derived;
        this.deps.drafts.saveRevision(latest);
      }
    }
    return out;
  }

  private async resumeParkedDraft(parkedDocId: string, nowIso: string): Promise<StepOutput | null> {
    const { deps } = this;
    const parked = deps.drafts.getByDocId(parkedDocId);
    if (
      !parked ||
      CLOSED_STATUSES.has(parked.status) ||
      isExpiredDraft(parked, deps.clock.now(), deps.draftTtlMs ?? INTAKE_DRAFT_TTL_MS)
    ) {
      return null;
    }

    const touched: IntakeDraft = {
      ...parked,
      revision: parked.revision + 1,
      updatedAt: nowIso,
    };
    deps.drafts.saveRevision(touched);
    const record = this.toRecord(touched);
    const gate = evaluateGate(deps.catalog, record);
    this.writeRecordBack(touched, record, gate.effectiveValues);

    if (touched.status === "ready_for_confirmation") {
      const shown = markSummaryShown(touched, deps.clock);
      deps.drafts.saveRevision(shown);
      return this.summaryOutput(shown, gate);
    }

    if (!gate.isComplete) {
      this.bumpAsked(touched, gate.fieldsToAsk);
      touched.lastAskedFields = gate.fieldsToAsk;
      deps.drafts.saveRevision(touched);
      const firstField = gate.fieldsToAsk[0];
      const deptField = this.resolveDeptField(record.variant);
      let question: string;
      if (
        touched.unrecognizedDept &&
        gate.fieldsToAsk.length === 1 &&
        deptField &&
        firstField === deptField
      ) {
        question = deps.copy.text("ask.unrecognized_dept", { dept: touched.unrecognizedDept });
      } else {
        question = gate.questionText || deps.copy.text("ask.missing_info");
      }
      const buttons = firstField ? this.questionButtons(firstField, touched) : undefined;
      return {
        outcome: "asked",
        missingFields: gate.missingRequired,
        messages: [{ text: question, ...(buttons ? { buttons } : {}) }],
      };
    }

    const shown = markSummaryShown(touched, deps.clock);
    deps.drafts.saveRevision(shown);
    return this.summaryOutput(shown, gate);
  }

  // ── existing-ticket commands (ADR-0008) ─────────────────────────────────────

  private async routeExistingTicket(
    draft: IntakeDraft | null,
    chatId: string,
    text: string,
    mediaPaths: string[],
  ): Promise<StepOutput | null> {
    const { deps } = this;
    const trimmed = text.trim();
    if (!trimmed && mediaPaths.length === 0) return null;

    const hasMentions = this.mentionsExistingTicket(trimmed);

    // Filter early chitchat / cancel / decline when no ticket is mentioned
    if (!hasMentions) {
      if (isChitchat(trimmed) || isDeclineAnswer(trimmed) || isExplicitCancel(trimmed)) {
        return null;
      }
      const navButtons = [
        deps.copy.text("button.new_incident"),
        deps.copy.text("button.continue_draft"),
        deps.copy.text("button.resume_parked"),
      ];
      if (navButtons.some((b) => trimmed.toLowerCase().includes(b.toLowerCase()))) {
        return null;
      }
      // D9: Tra cứu tiến độ không nêu mã
      if (isProgressInquiry(trimmed)) {
        const latest = deps.bindings.getLatestBinding(chatId, deps.identifierPrefix);
        if (latest) {
          const updatedAt = latest.updatedAt
            ? Date.parse(
                latest.updatedAt.includes("T")
                  ? latest.updatedAt
                  : `${latest.updatedAt.replace(" ", "T")}Z`,
              )
            : draft?.issueIdentifier === latest.identifier
              ? Date.parse(draft.issueCreatedAt ?? draft.updatedAt)
              : NaN;
          const diff = deps.clock.now() - updatedAt;
          const fresh = !Number.isNaN(updatedAt) && diff >= 0 && diff <= LOOKUP_WINDOW_MS;
          if (fresh) {
            return this.lookup(
              {
                identifier: latest.identifier,
                issueId: latest.issueId,
                title: latest.title,
                ownTicket: true,
                mentioned: false,
              },
              draft,
            );
          }
        }
        return {
          outcome: "clarify",
          messages: [{ text: deps.copy.text("lookup.clarify_identifier") }],
          docId: draft?.docId,
        };
      }
    }

    const candidates = await this.buildCandidates(chatId, draft, trimmed);
    if (candidates.length === 0) return null;

    let command: TicketCommand | null = null;
    if (deps.commands) {
      command = await deps.commands.interpret({
        message: trimmed,
        attachments: mediaPaths.length,
        candidates,
        draftTitle: draft && !CLOSED_STATUSES.has(draft.status) ? draft.ticket.title : undefined,
      });
    } else {
      const mentionedCandidate =
        candidates.find((c) => c.mentioned && c.ownTicket) ?? candidates.find((c) => c.mentioned);
      if (mentionedCandidate) {
        const isLookup =
          /(?:tới\s*đâu\s*rồi|đến\s*đâu\s*rồi|tình\s*trạng|tiến\s*độ|check|kiểm\s*tra|xem|xong\s*chưa)/iu.test(
            trimmed,
          ) ||
          /^(?:dạ\s+|vâng\s+)?(?:ticket\s+|tick\s+|tk\s+|vé\s+)?[A-Z0-9_]{2,10}[-\s_:#]*\d+(?:\s+ạ)?$/iu.test(
            trimmed,
          );
        if (isLookup) {
          command = { action: "lookup", identifier: mentionedCandidate.identifier };
        } else {
          const cancelIntent = classifyCancelOrCloseIntent(trimmed);
          if (cancelIntent) {
            command = {
              action: "cancel_or_close",
              identifier: mentionedCandidate.identifier,
              content: trimmed,
              intent: cancelIntent,
            };
          } else {
            const editMatch =
              /(?:sửa|đổi|chỉnh|cập\s*nhật)\s+([A-Z0-9_]+-\d+)(?:\s*[:\-–]?\s*(.*))?$/iu.exec(
                trimmed,
              );
            if (editMatch) {
              command = {
                action: "edit",
                identifier: editMatch[1].toUpperCase(),
                instruction: editMatch[2]?.trim() || trimmed,
              };
            } else {
              const supp = stripSupplementCommandWrapper(trimmed);
              command = {
                action: "append",
                identifier: mentionedCandidate.identifier,
                content: supp.isSupplementCommand ? supp.content : trimmed,
              };
            }
          }
        }
      }
    }

    if (!command || command.action === "new") return null;

    // If unclear: only propose suggestion if candidate is recently relayed or mentioned own ticket
    if (command.action === "unclear") {
      const strong =
        candidates.find((c) => c.mentioned && c.ownTicket) ??
        candidates.find((c) => c.recentlyRelayed);
      if (!strong) return null;
      const supp = stripSupplementCommandWrapper(trimmed);
      if (strong.mentioned && supp.isSupplementCommand) {
        command = { action: "append", identifier: strong.identifier, content: supp.content };
      } else {
        return this.previewAction(
          draft,
          chatId,
          { action: "append", identifier: strong.identifier, content: trimmed },
          strong,
          mediaPaths,
          "suggest",
        );
      }
    }

    const cmd = command;
    const target = candidates.find(
      (c) => c.identifier.toUpperCase() === targetId(cmd).toUpperCase(),
    );
    if (!target) return null;

    // Check if target ticket is closed (W29-NOTIFY / test 18)
    const isClosed = await this.checkIssueClosed(target.issueId);
    if (isClosed) {
      return this.buildClosedRefusal(target.issueId, target.identifier);
    }

    // Lookup is read-only; ownership gates only WRITES (ADR-0008 §6).
    if (command.action === "lookup") {
      return this.lookup(target, draft);
    }

    // Ownership check for writes (D7)
    const issue = await deps.tracker.getIssue(target.issueId).catch(() => null);
    const own = this.isOwn(target, chatId, issue?.description);
    if (!own) {
      return {
        outcome: "not_owner",
        messages: [
          { text: deps.copy.text("action.not_owner_refusal", { identifier: target.identifier }) },
        ],
        docId: draft?.docId,
      };
    }

    // Bare supplement command handling (TECH-1218)
    if (command.action === "append") {
      const supp = stripSupplementCommandWrapper(trimmed);
      const cleanContent =
        supp.isSupplementCommand &&
        (!supp.content || command.content.trim().toLowerCase() === trimmed.toLowerCase())
          ? supp.content
          : command.content;
      if (!cleanContent.trim() && mediaPaths.length === 0) {
        const nowIso = new Date(deps.clock.now()).toISOString();
        const base = draft ?? this.openFresh(chatId, nowIso);
        const cancelLabel = deps.copy.text("button.cancel_action");
        const doLabel = deps.copy.text("button.confirm_append", { identifier: target.identifier });
        const withPending: IntakeDraft = {
          ...base,
          pendingTicketAction: {
            kind: "append",
            identifier: target.identifier,
            issueId: target.issueId,
            content: "",
            message: "",
            mediaPaths: [],
            confirmLabel: doLabel,
            askedAt: nowIso,
          },
          updatedAt: nowIso,
        };
        deps.drafts.saveRevision(withPending);
        return {
          outcome: "clarify",
          messages: [
            {
              text: deps.copy.text("action.clarify_empty_append", {
                identifier: target.identifier,
              }),
              buttons: layoutButtons([{ text: cancelLabel, callbackData: cancelLabel }]),
            },
          ],
          docId: base.docId,
        };
      }
      command = { ...command, content: cleanContent };
    }

    if (command.action === "cancel_or_close") {
      return null;
    }

    const isSuggest = Boolean(target.recentlyRelayed && !hasMentions);
    return this.previewAction(
      draft,
      chatId,
      command,
      target,
      mediaPaths,
      isSuggest ? "suggest" : undefined,
    );
  }

  private async lookup(target: ReplyCandidate, draft: IntakeDraft | null): Promise<StepOutput> {
    const { deps } = this;
    const chatId = draft?.chatId ?? "";
    const issue = await deps.tracker.getIssue(target.issueId).catch(() => null);
    const title = issue?.title ?? target.title ?? "";
    const columns =
      (await deps.tracker.listProjectColumns?.(deps.identifierPrefix).catch(() => [])) ?? [];
    const column = columns.find((c) => c.id === issue?.columnId);
    const status = column?.name ?? issue?.stateType ?? "chưa rõ";

    const own = this.isOwn(target, chatId, issue?.description);
    if (!own) {
      return {
        outcome: "lookup",
        messages: [
          {
            text: deps.copy.text("lookup.other_ticket_status", {
              identifier: target.identifier,
              status,
            }),
          },
        ],
        issue: { id: target.issueId, identifier: target.identifier },
        docId: draft?.docId,
      };
    }

    const last = await this.lastTechComment(target.issueId);
    const techComment = last
      ? deps.copy.text("lookup.tech_comment", {
          comment: cap(
            last
              .replace(/[#*`_~]/g, " ")
              .replace(/\s+/g, " ")
              .trim(),
            300,
          ),
        })
      : "";
    return {
      outcome: "lookup",
      messages: [
        {
          text: deps.copy.text("lookup.status", {
            identifier: target.identifier,
            title,
            status,
            techComment,
          }),
        },
      ],
      issue: { id: target.issueId, identifier: target.identifier },
      docId: draft?.docId,
    };
  }

  private async previewAction(
    draft: IntakeDraft | null,
    chatId: string,
    command: Extract<TicketCommand, { action: "append" | "edit" | "move_created" }>,
    target: ReplyCandidate,
    mediaPaths: string[] = [],
    forcedKind?: "append" | "edit" | "move" | "suggest",
  ): Promise<StepOutput> {
    const { deps } = this;
    const nowIso = new Date(deps.clock.now()).toISOString();
    const base = draft ?? this.openFresh(chatId, nowIso);

    if (command.action === "edit" || forcedKind === "edit") {
      const issue = await deps.tracker.getIssue(target.issueId).catch(() => null);
      let ops: EditOp[] = [];
      const editInput = {
        title: issue?.title ?? target.title ?? "",
        description: issue?.description ?? "",
        instruction: "instruction" in command ? command.instruction : "",
      };
      if (deps.editPlanner) {
        ops = await deps.editPlanner(editInput);
      } else if (deps.extractor && typeof deps.extractor === "object") {
        const ext = deps.extractor as {
          llmConfig?: LlmConfig;
          completeFn?: CompleteFn;
        };
        if (ext.llmConfig) {
          ops = await planEdit(ext.llmConfig, editInput, ext.completeFn);
        }
      }
      const applied = applyEditOps(
        issue?.title ?? target.title ?? "",
        issue?.description ?? "",
        ops,
      );
      if (applied.changes.length === 0 && !deps.actions) {
        return {
          outcome: "action_done",
          messages: [
            {
              text: deps.copy.text("action.edit_unclear_prompt", {
                identifier: target.identifier,
              }),
            },
          ],
          docId: base.docId,
        };
      }
      const changesText =
        applied.changes.length > 0
          ? applied.changes.map((c) => `- ${c.what}: ${c.before} → ${c.after}`).join("\n")
          : "instruction" in command
            ? command.instruction
            : "";
      const doLabel = deps.copy.text("button.confirm_edit", { identifier: target.identifier });
      const cancelLabel = deps.copy.text("button.cancel_action");
      const withPending: IntakeDraft = {
        ...base,
        pendingTicketAction: {
          kind: "edit",
          identifier: target.identifier,
          issueId: target.issueId,
          instruction: "instruction" in command ? command.instruction : "",
          confirmLabel: doLabel,
          askedAt: nowIso,
          edit:
            applied.changes.length > 0
              ? {
                  baseTitle: issue?.title ?? target.title ?? "",
                  baseDescription: issue?.description ?? "",
                  title: applied.title,
                  description: applied.description,
                  changes: applied.changes,
                }
              : undefined,
        },
        updatedAt: nowIso,
      };
      deps.drafts.saveRevision(withPending);
      return {
        outcome: "action_preview",
        messages: [
          {
            text: deps.copy.text("action.preview_edit", {
              identifier: target.identifier,
              changes: changesText,
            }),
            buttons: layoutButtons([
              { text: doLabel, callbackData: doLabel },
              { text: cancelLabel, callbackData: cancelLabel },
            ]),
          },
        ],
        docId: base.docId,
      };
    }

    if (command.action === "move_created" || forcedKind === "move") {
      const from = "from" in command ? command.from : "";
      const doLabel = deps.copy.text("button.confirm_move", { identifier: target.identifier });
      const cancelLabel = deps.copy.text("button.cancel_action");
      const withPending: IntakeDraft = {
        ...base,
        pendingTicketAction: {
          kind: "move",
          identifier: target.identifier,
          issueId: target.issueId,
          from,
          confirmLabel: doLabel,
          askedAt: nowIso,
        },
        updatedAt: nowIso,
      };
      deps.drafts.saveRevision(withPending);
      return {
        outcome: "action_preview",
        messages: [
          {
            text: deps.copy.text("action.preview_move", {
              from,
              identifier: target.identifier,
            }),
            buttons: layoutButtons([
              { text: doLabel, callbackData: doLabel },
              { text: cancelLabel, callbackData: cancelLabel },
            ]),
          },
        ],
        docId: base.docId,
      };
    }

    // Append or Suggest
    if (forcedKind === "suggest") {
      const content = command.content;
      const doLabel = deps.copy.text("button.confirm_append", { identifier: target.identifier });
      const newIncidentLabel = deps.copy.text("button.new_incident");
      const withPending: IntakeDraft = {
        ...base,
        pendingTicketAction: {
          kind: "suggest",
          identifier: target.identifier,
          issueId: target.issueId,
          content,
          message: content,
          mediaPaths,
          confirmLabel: doLabel,
          askedAt: nowIso,
        },
        updatedAt: nowIso,
      };
      deps.drafts.saveRevision(withPending);
      const quoted = content ? `> ${cap(content, 500)}` : "";
      const filesNote =
        mediaPaths.length > 0
          ? deps.copy.text("action.suggest_append_media_note", { count: mediaPaths.length })
          : "";
      const preview = deps.copy.text("action.suggest_append_preview", {
        lead: deps.copy.text("action.suggest_append_lead", { identifier: target.identifier }),
        title: target.title ? ` «${target.title}»` : "",
        identifier: target.identifier,
        quoted,
        files: filesNote,
        alternatives: "",
        newIncidentLabel,
      });
      return {
        outcome: "action_preview",
        messages: [
          {
            text: preview,
            buttons: layoutButtons([
              { text: doLabel, callbackData: doLabel },
              { text: newIncidentLabel, callbackData: newIncidentLabel },
            ]),
          },
        ],
        docId: base.docId,
      };
    }

    // Standard append preview
    const content = command.content;
    const doLabel = deps.copy.text("button.confirm_append", { identifier: target.identifier });
    const cancelLabel = deps.copy.text("button.cancel_action");
    const withPending: IntakeDraft = {
      ...base,
      pendingTicketAction: {
        kind: "append",
        identifier: target.identifier,
        issueId: target.issueId,
        content,
        message: content,
        mediaPaths,
        confirmLabel: doLabel,
        askedAt: nowIso,
      },
      updatedAt: nowIso,
    };
    deps.drafts.saveRevision(withPending);

    const filesNote = mediaPaths.length > 0 ? ` (kèm ${mediaPaths.length} ảnh/tệp)` : "";
    const quoted = content ? `> ${cap(content, 500)}` : "";
    const contentWithFiles = [quoted, filesNote].filter(Boolean).join("\n");

    return {
      outcome: "action_preview",
      messages: [
        {
          text: deps.copy.text("action.preview_append", {
            identifier: target.identifier,
            content: contentWithFiles,
          }),
          buttons: layoutButtons([
            { text: doLabel, callbackData: doLabel },
            { text: cancelLabel, callbackData: cancelLabel },
          ]),
        },
      ],
      docId: base.docId,
    };
  }

  // ── post-create ticket flow (RFC 0002 PR 10, C1-C4, G2, B8) ───────────────────

  private async handlePostCreate(
    draft: IntakeDraft,
    input: StepInput,
    text: string,
    mediaPaths: string[],
    nowIso: string,
  ): Promise<StepOutput> {
    const { deps } = this;
    const issueId = draft.issueId ?? 0;
    const identifier = draft.issueIdentifier || `TECH-${issueId}`;

    // 1. Kiểm tra trạng thái đóng của ticket đã tạo (W29-NOTIFY)
    const isClosed = await this.checkIssueClosed(issueId);
    if (isClosed) {
      const statusLabel = await this.resolveClosedStatusLabel(issueId);
      if (saysNewIncident(text)) {
        return this.startNewIncidentFromPostCreate(draft, input, text, mediaPaths, nowIso);
      }
      const extractedEarly = await deps.extractor.extract({
        text,
        attachments: mediaPaths.length,
        draftTitle: draft.ticket.title,
        context: this.buildExtractContext(draft),
      });
      if (extractedEarly.userIntent === "report_issue") {
        return this.startNewIncidentFromPostCreate(
          draft,
          input,
          text,
          mediaPaths,
          nowIso,
          extractedEarly,
        );
      }
      return this.buildClosedRefusal(issueId, identifier, draft.issueUrl);
    }

    // 2. Ticket đang mở: trích xuất ý định với createdTicket context
    const extracted = await deps.extractor.extract({
      text,
      attachments: mediaPaths.length,
      draftTitle: draft.ticket.title,
      context: this.buildExtractContext(draft),
    });
    // 3. Phân loại ý định:
    // 3.0. Nếu có ảnh: luôn coi là bổ sung (ADR-0008, TECH-1013), không bao giờ là chitchat
    if (mediaPaths.length > 0) {
      const lead = deps.copy.text("action.suggest_append_lead", { identifier });
      return this.proposeSuggestAction(draft, input, text, mediaPaths, lead, nowIso);
    }

    // 3.1. Chitchat / Cảm ơn (C1)
    if (extracted.userIntent === "chitchat" || isChitchat(text)) {
      return {
        outcome: "already_created",
        messages: [{ text: deps.copy.text("ticket.chitchat_after_create", { identifier }) }],
        issue: { id: issueId, identifier, url: draft.issueUrl },
      };
    }

    // 3.2. Huỷ chung chung (C1, ADR-0006)
    if (extracted.userIntent === "cancel" || isExplicitCancel(text)) {
      return {
        outcome: "already_created",
        messages: [{ text: deps.copy.text("ticket.cancel_hint_after_create", { identifier }) }],
        issue: { id: issueId, identifier, url: draft.issueUrl },
      };
    }

    // 3.3. Xác nhận lại (C1)
    if (extracted.userIntent === "confirm" || isShortConfirmation(text)) {
      return {
        outcome: "already_created",
        messages: [{ text: deps.copy.text("ticket.already_created_hint", { identifier }) }],
        issue: { id: issueId, identifier, url: draft.issueUrl },
      };
    }

    // 3.4. Nhận diện "ticket mới ạ" (C2, TECH-1013)
    if (saysNewIncident(text)) {
      const stripped = stripNewIncidentDeclaration(text);
      if (stripped.length < 12 && mediaPaths.length === 0) {
        const fresh = this.openFresh(input.chatId, nowIso);
        deps.drafts.saveRevision(fresh);
        return {
          outcome: "clarify",
          messages: [{ text: deps.copy.text("clarify.new_incident_prompt") }],
          docId: fresh.docId,
        };
      }
      return this.startNewIncidentFromPostCreate(draft, input, text, mediaPaths, nowIso, extracted);
    }

    // 3.5. Báo sự cố mới (C1)
    if (extracted.userIntent === "report_issue") {
      return this.startNewIncidentFromPostCreate(draft, input, text, mediaPaths, nowIso, extracted);
    }

    // 3.6. Định danh xung đột so với ticket đã tạo (C3)
    const conflictField = this.findConflictingField(draft, extracted);
    if (conflictField && text) {
      const lead = deps.copy.text("action.suggest_conflict_lead", { identifier });
      return this.proposeSuggestAction(draft, input, text, mediaPaths, lead, nowIso);
    }

    // 3.7. Bổ sung thông tin hoặc gửi ảnh (C2, ADR-0008)
    const lead = deps.copy.text("action.suggest_append_lead", { identifier });
    return this.proposeSuggestAction(draft, input, text, mediaPaths, lead, nowIso);
  }

  private async startNewIncidentFromPostCreate(
    _draft: IntakeDraft,
    input: StepInput,
    text: string,
    mediaPaths: string[],
    nowIso: string,
    preExtracted?: ExtractedFields,
  ): Promise<StepOutput> {
    const fresh = this.openFresh(input.chatId, nowIso);
    let messageToCollect = text;
    if (saysNewIncident(text)) {
      const stripped = stripNewIncidentDeclaration(text);
      if (stripped.length >= 12) {
        messageToCollect = stripped;
      }
    }
    return this.collect(fresh, input, messageToCollect, mediaPaths, nowIso, {
      preExtracted,
    });
  }

  private async proposeSuggestAction(
    draft: IntakeDraft,
    input: StepInput,
    text: string,
    mediaPaths: string[],
    lead: string,
    nowIso: string,
  ): Promise<StepOutput> {
    const { deps } = this;
    const issueId = draft.issueId ?? 0;
    const createdId = draft.issueIdentifier || `TECH-${issueId}`;
    const created: ReplyCandidate = {
      identifier: createdId,
      issueId,
      title: draft.ticket.title,
      ownTicket: true,
      mentioned: false,
      justCreated: true,
    };

    const others = await this.otherOpenTickets(input.chatId, createdId);
    let primary = created;
    if (others.length > 0 && text && deps.commands) {
      const command = await deps.commands
        .interpret({
          message: text,
          attachments: mediaPaths.length,
          candidates: [created, ...others],
        })
        .catch(() => ({ action: "unclear" }) as TicketCommand);
      if (command.action === "append") {
        primary =
          [created, ...others].find(
            (c) => c.identifier.toUpperCase() === command.identifier.toUpperCase(),
          ) ?? created;
      }
    }

    const alternatives = [created, ...others]
      .filter((c) => c.identifier.toUpperCase() !== primary.identifier.toUpperCase())
      .slice(0, 3);

    const title = primary.title ? ` «${primary.title}»` : "";
    const quoted = text ? `\n\n> ${cap(text, 500).replace(/\n/g, "\n> ")}` : "";
    const files = mediaPaths.length
      ? deps.copy.text("action.suggest_append_media_note", { count: mediaPaths.length })
      : "";
    const altsList = alternatives
      .map((a) => `- ${a.identifier}${a.title ? ` «${a.title}»` : ""}`)
      .join("\n");
    const alts = alternatives.length
      ? deps.copy.text("action.suggest_append_other_tickets", { list: altsList })
      : "";

    const newIncidentLabel = deps.copy.text("button.new_incident");
    const doLabel = deps.copy.text("button.confirm_append", { identifier: primary.identifier });

    const adjustedLead =
      primary.identifier === createdId ? lead : lead.replace(createdId, primary.identifier);
    const messageText = deps.copy.text("action.suggest_append_preview", {
      lead: adjustedLead,
      title,
      identifier: primary.identifier,
      quoted,
      files,
      alternatives: alts,
      newIncidentLabel,
    });

    const pending: NonNullable<IntakeDraft["pendingTicketAction"]> = {
      kind: "suggest",
      identifier: primary.identifier,
      issueId: primary.issueId,
      content: text,
      message: text,
      mediaPaths,
      lead: adjustedLead,
      alternatives: alternatives.map((a) => ({
        identifier: a.identifier,
        issueId: a.issueId,
        title: a.title,
      })),
      confirmLabel: doLabel,
      askedAt: nowIso,
    };

    const saved: IntakeDraft = {
      ...draft,
      revision: draft.revision + 1,
      updatedAt: nowIso,
      pendingTicketAction: pending,
    };
    deps.drafts.saveRevision(saved);

    const buttons = this.buildTicketActionButtons(pending);

    return {
      outcome: "action_preview",
      messages: [
        {
          text: messageText,
          buttons,
        },
      ],
      issue: { id: primary.issueId, identifier: primary.identifier },
      docId: draft.docId,
    };
  }

  private buildTicketActionButtons(
    pending: NonNullable<IntakeDraft["pendingTicketAction"]>,
  ): InlineButton[][] {
    const { deps } = this;
    const buttons: InlineButton[][] = [];
    buttons.push([{ text: pending.confirmLabel, callbackData: pending.confirmLabel }]);
    for (const alt of pending.alternatives ?? []) {
      const altLabel = deps.copy.text("button.confirm_append", { identifier: alt.identifier });
      buttons.push([{ text: altLabel, callbackData: altLabel }]);
    }
    if (pending.kind === "suggest") {
      const newIncLabel = deps.copy.text("button.new_incident");
      buttons.push([{ text: newIncLabel, callbackData: newIncLabel }]);
    } else {
      const cancelLabel = deps.copy.text("button.cancel_action");
      buttons.push([{ text: cancelLabel, callbackData: cancelLabel }]);
    }
    return buttons;
  }

  private async resolvePendingAction(
    draft: IntakeDraft,
    text: string,
    mediaPaths: string[],
    nowIso: string,
  ): Promise<StepOutput> {
    const { deps } = this;
    const pending = draft.pendingTicketAction;
    if (!pending) {
      return {
        outcome: "action_canceled",
        messages: [{ text: deps.copy.text("action.canceled") }],
      };
    }
    const folded = foldButton(text);

    // 1. Khớp nút của ticket chính
    if (folded === foldButton(pending.confirmLabel)) {
      return this.executeConfirmedTicketAction(draft, pending, mediaPaths, nowIso);
    }

    // 2. Khớp nút của một ticket thay thế (B8)
    const alt = (pending.alternatives ?? []).find(
      (a) =>
        folded ===
        foldButton(deps.copy.text("button.confirm_append", { identifier: a.identifier })),
    );
    if (alt) {
      const altPending = {
        ...pending,
        identifier: alt.identifier,
        issueId: alt.issueId,
        alternatives: undefined,
      };
      return this.executeConfirmedTicketAction(draft, altPending, mediaPaths, nowIso);
    }

    // 3. Người báo bấm "Sự cố mới" hoặc gõ câu mang ý sự cố mới (C2, TECH-1013)
    const newIncidentLabel = foldButton(deps.copy.text("button.new_incident"));
    if (pending.kind === "suggest" && (folded === newIncidentLabel || saysNewIncident(text))) {
      const cleared: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        pendingTicketAction: undefined,
        updatedAt: nowIso,
      };
      deps.drafts.saveRevision(cleared);
      const base = CLOSED_STATUSES.has(cleared.status)
        ? this.openFresh(draft.chatId, nowIso)
        : cleared;
      const combinedMessage = withTypedDetail(pending.message ?? pending.content ?? "", text);
      const combinedMedia = Array.from(new Set([...(pending.mediaPaths ?? []), ...mediaPaths]));
      return this.collect(base, { chatId: draft.chatId }, combinedMessage, combinedMedia, nowIso);
    }

    // 4. Huỷ / Abort
    const cancelLabel = foldButton(deps.copy.text("button.cancel_action"));
    const isAbort =
      folded === cancelLabel ||
      (!mentionedIdentifiers(text, deps.identifierPrefix ?? "").length && isExplicitCancel(text));
    if (isAbort) {
      const cleared: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        pendingTicketAction: undefined,
        updatedAt: nowIso,
      };
      deps.drafts.saveRevision(cleared);
      return {
        outcome: "action_canceled",
        messages: [{ text: deps.copy.text("action.canceled", { identifier: pending.identifier }) }],
        docId: draft.docId,
      };
    }

    // 5. Đang ở append mà lượt trước chưa có nội dung/ảnh HOẶC gửi thêm ảnh đính kèm
    const hasMentions = mentionedIdentifiers(text, deps.identifierPrefix ?? "TECH").length > 0;
    if (pending.kind === "append" && !hasMentions) {
      const waitingForPayload = !pending.content?.trim() && (pending.mediaPaths ?? []).length === 0;
      if (
        (waitingForPayload && (text || mediaPaths.length > 0)) ||
        (!text && mediaPaths.length > 0)
      ) {
        const nextContent = withTypedDetail(pending.content ?? "", text);
        const nextMedia = Array.from(new Set([...(pending.mediaPaths ?? []), ...mediaPaths]));
        return this.previewAction(
          draft,
          draft.chatId,
          { action: "append", identifier: pending.identifier, content: nextContent },
          {
            identifier: pending.identifier,
            issueId: pending.issueId ?? 0,
            ownTicket: true,
            mentioned: true,
          },
          nextMedia,
        );
      }
    }

    // 6. Đang ở suggest: gửi thêm ảnh
    if (pending.kind === "suggest" && !hasMentions) {
      if (mediaPaths.length > 0) {
        const nextMedia = Array.from(new Set([...(pending.mediaPaths ?? []), ...mediaPaths]));
        const updatedPending = { ...pending, mediaPaths: nextMedia };
        const updatedDoc: IntakeDraft = {
          ...draft,
          revision: draft.revision + 1,
          updatedAt: nowIso,
          pendingTicketAction: updatedPending,
        };
        deps.drafts.saveRevision(updatedDoc);
        return {
          outcome: "action_preview",
          messages: [
            {
              text: deps.copy.text("action.suggest_unclear_prompt_with_media", {
                count: nextMedia.length,
              }),
              buttons: this.buildTicketActionButtons(updatedPending),
            },
          ],
          docId: draft.docId,
        };
      }
      return {
        outcome: "action_preview",
        messages: [
          {
            text: deps.copy.text("action.suggest_unclear_prompt"),
            buttons: this.buildTicketActionButtons(pending),
          },
        ],
        docId: draft.docId,
      };
    }

    // 8. Đang ở append / edit / move mà nhắn việc khác hoàn toàn
    // Nếu tin nhắn rõ ràng là sự cố mới (hoặc bộ đọc lệnh trả về "new"): bỏ bản xem trước và xử lý sự cố mới
    let isNewIncident = saysNewIncident(text);
    if (
      !isNewIncident &&
      deps.commands &&
      text.length >= 15 &&
      /(?:lỗi|hỏng|không|ko|chưa|app|crm|web|bị|sập|treo|đứng|văng)/iu.test(text)
    ) {
      const cmd = await deps.commands
        .interpret({
          message: text,
          attachments: mediaPaths.length,
          candidates: [
            {
              identifier: pending.identifier,
              issueId: pending.issueId ?? 0,
              ownTicket: true,
              mentioned: false,
            },
          ],
        })
        .catch(() => null);
      if (cmd?.action === "new") isNewIncident = true;
    }

    const supp = stripSupplementCommandWrapper(text);
    const shouldSwitch = isNewIncident || hasMentions || supp.isSupplementCommand;

    if (shouldSwitch) {
      const cleared: IntakeDraft = {
        ...draft,
        revision: draft.revision + 1,
        pendingTicketAction: undefined,
        updatedAt: nowIso,
      };
      deps.drafts.saveRevision(cleared);

      const preservePayload =
        (pending.kind === "suggest" || pending.kind === "append") &&
        !isCancelOrCloseTicketRequest(text) &&
        (supp.isSupplementCommand ||
          mentionedIdentifiers(text, deps.identifierPrefix ?? "TECH").includes(pending.identifier));
      const nextMedia = preservePayload
        ? Array.from(new Set([...(pending.mediaPaths ?? []), ...mediaPaths]))
        : mediaPaths;
      const nextMessage =
        preservePayload && supp.isSupplementCommand && !supp.content && pending.content?.trim()
          ? `${text}: ${pending.content.trim()}`
          : text;

      return this.step({
        chatId: draft.chatId,
        message: nextMessage,
        mediaPaths: nextMedia,
        reporter: draft.reporter,
      });
    }

    // Nếu không phải sự cố mới: giữ nguyên bản xem trước và nhắc lại nút xác nhận
    return {
      outcome: "action_preview",
      messages: [
        {
          text: deps.copy.text("action.suggest_unclear_prompt"),
          buttons: this.buildTicketActionButtons(pending),
        },
      ],
      docId: draft.docId,
    };
  }

  private async executeConfirmedTicketAction(
    draft: IntakeDraft,
    pending: NonNullable<IntakeDraft["pendingTicketAction"]>,
    extraMedia: string[],
    nowIso: string,
  ): Promise<StepOutput> {
    const { deps } = this;
    const issueId =
      pending.issueId ?? (draft.issueIdentifier === pending.identifier ? draft.issueId : undefined);
    const identifier = pending.identifier;

    // Clear pendingTicketAction
    const cleared: IntakeDraft = {
      ...draft,
      revision: draft.revision + 1,
      pendingTicketAction: undefined,
      updatedAt: nowIso,
    };
    deps.drafts.saveRevision(cleared);

    // ── Edit ticket ──
    if (pending.kind === "edit") {
      const targetIssueId = issueId;
      if (targetIssueId === undefined) {
        return {
          outcome: "action_canceled",
          messages: [{ text: deps.copy.text("action.canceled", { identifier }) }],
          docId: draft.docId,
        };
      }
      const current = await deps.tracker.getIssue(targetIssueId).catch(() => null);
      if (pending.edit && current) {
        const baseDesc = (pending.edit.baseDescription ?? "").trimEnd();
        const currDesc = (current.description ?? "").trimEnd();
        const baseTitle = (pending.edit.baseTitle ?? "").trimEnd();
        const currTitle = (current.title ?? "").trimEnd();
        if (baseDesc !== currDesc || baseTitle !== currTitle) {
          return {
            outcome: "action_done",
            messages: [{ text: deps.copy.text("action.edit_conflict_rejected", { identifier }) }],
            docId: draft.docId,
          };
        }
        if (deps.tracker.updateIssue) {
          await deps.tracker.updateIssue(targetIssueId, {
            title: pending.edit.title,
            description: pending.edit.description,
          });
        }
        const lines = pending.edit.changes
          .map((c) => `- ${c.what}: ${c.before} → ${c.after}`)
          .join("\n");
        const who = draft.reporter?.username
          ? `@${draft.reporter.username}`
          : draft.chatId || deps.copy.text("reporter.default_name");
        const traceComment = markBotComment(deps.copy.text("comment.edit_trace", { who, lines }));
        await deps.tracker.addComment(targetIssueId, traceComment).catch(() => {});
        return {
          outcome: "action_done",
          messages: [{ text: deps.copy.text("action.edit_done", { identifier }) }],
          docId: draft.docId,
        };
      }
      if (deps.actions) {
        await deps.actions.execute({
          kind: "edit",
          identifier,
          instruction: pending.instruction,
        });
      }
      return {
        outcome: "action_done",
        messages: [{ text: deps.copy.text("action.edit_done", { identifier }) }],
        docId: draft.docId,
      };
    }

    // ── Move ticket ──
    if (pending.kind === "move") {
      const fromId = pending.from ?? "";
      const fromIssue =
        (await deps.tracker.findByIdentifier(fromId).catch(() => null)) ??
        (draft.issueIdentifier === fromId && draft.issueId
          ? await deps.tracker.getIssue(draft.issueId).catch(() => null)
          : null);
      const { body, images } = descriptionBody(fromIssue?.description ?? "");
      const who = draft.reporter?.username
        ? `@${draft.reporter.username}`
        : draft.chatId || deps.copy.text("reporter.default_name");
      const imagesText = images.join("\n");
      const targetComment = markBotComment(
        deps.copy.text("comment.move_target_note", {
          who,
          from: fromId,
          body,
          images: imagesText,
        }),
      );
      if (issueId !== undefined) {
        await deps.tracker.addComment(issueId, targetComment).catch(() => {});
        if (fromIssue && deps.tracker.linkIssues) {
          await deps.tracker.linkIssues(fromIssue.id, issueId, "duplicates").catch(() => {});
        }
      }
      if (fromIssue) {
        const botName = deps.botName ?? "Tiểu Linh";
        const sourceComment = markBotComment(
          deps.copy.text("comment.move_source_note", {
            who,
            target: identifier,
            botName,
          }),
        );
        await deps.tracker.addComment(fromIssue.id, sourceComment).catch(() => {});
        const columns =
          (await deps.tracker.listProjectColumns?.(deps.identifierPrefix).catch(() => [])) ?? [];
        const canceledCol = columns.find(
          (c) => c.stateType === "canceled" || c.name.toLowerCase().includes("cancel"),
        );
        if (deps.tracker.updateIssue) {
          await deps.tracker
            .updateIssue(fromIssue.id, { columnId: canceledCol?.id ?? 9 })
            .catch(() => {});
        }
      }
      if (draft.issueIdentifier === fromId) {
        cleared.status = "canceled";
        deps.drafts.saveRevision(cleared);
      }
      return {
        outcome: "action_done",
        messages: [
          {
            text: deps.copy.text("action.move_done", {
              from: fromId,
              identifier,
            }),
          },
        ],
        docId: draft.docId,
      };
    }
    // ── Supplement (kind === "suggest" or "append") ──
    if (issueId !== undefined) {
      const isClosed = await this.checkIssueClosed(issueId);
      if (isClosed) {
        return this.buildClosedRefusal(issueId, identifier);
      }
    }

    const textContent = (pending.content ?? pending.message ?? "").trim();
    const media = Array.from(new Set([...(pending.mediaPaths ?? []), ...extraMedia]));
    const parts: string[] = [];
    if (textContent) {
      parts.push(cap(textContent, MAX_FOLLOW_UP_CHARS));
    }

    if (media.length > 0 && issueId !== undefined) {
      await deps.tracker.attach(issueId, "", media).catch(() => 0);
      for (const m of media) {
        parts.push(`![](${m})`);
      }
    }

    // G2: Priority escalation
    if (pending.message) {
      const asked = await deps.extractor
        .extract({
          text: pending.message,
          attachments: media.length,
          draftTitle: draft.ticket.title,
          context: { createdTicket: { identifier } },
        })
        .catch(() => null);

      if (
        asked?.requestedPriority &&
        asked.requestedPriorityReason &&
        (asked.requestedPriority === "high" || asked.requestedPriority === "urgent")
      ) {
        const reqPrio = asked.requestedPriority as Priority;
        const targetIssue =
          issueId !== undefined ? await deps.tracker.getIssue(issueId).catch(() => null) : null;
        const currentPrio = (targetIssue?.priority ??
          (draft.issueId === issueId ? draft.ticket.priority : "medium")) as Priority;
        const prioOrder: Record<Priority, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
        const currentPrioLabel = deps.copy.text(`priority.level.${currentPrio}` as CopyKey);
        const reqPrioLabel = deps.copy.text(`priority.level.${reqPrio}` as CopyKey);
        if (prioOrder[reqPrio] > prioOrder[currentPrio]) {
          if (issueId !== undefined && deps.tracker.updateIssue) {
            await deps.tracker.updateIssue(issueId, { priority: reqPrio }).catch(() => {});
          }
          if (draft.issueId === issueId) {
            cleared.ticket.priority = reqPrio;
            cleared.requestedPriority = {
              level: reqPrio as "high" | "urgent",
              reason: asked.requestedPriorityReason,
            };
            deps.drafts.saveRevision(cleared);
          }
          parts.push(
            deps.copy.text("action.priority_uplift", {
              from: currentPrioLabel,
              to: reqPrioLabel,
              reason: asked.requestedPriorityReason,
            }),
          );
        }
      }
    }

    // Mention resolution
    let mentionUsername: string | null = null;
    if (issueId !== undefined) {
      const issueObj = await deps.tracker.getIssue(issueId).catch(() => null);
      const mention = await resolveSupplementMentionTarget({
        tracker: deps.tracker,
        issue: { id: issueId, assigneeUserId: issueObj?.assigneeUserId },
        reporterNames: [draft.reporter?.name],
        ignoredActors: deps.ignoredActors,
      }).catch(() => null);
      mentionUsername = mention?.username ?? null;
    }

    if (parts.length === 0) {
      parts.push(textContent || deps.copy.text("comment.supplement_default_content"));
    }

    const commentBody = formatSupplementComment({
      who: draft.reporter?.name || deps.copy.text("reporter.default_name"),
      parts,
      mention: mentionUsername,
      style: draft.issueId === issueId ? "user_update" : "who_supplement",
    });

    if (issueId !== undefined) {
      await deps.tracker.addComment(issueId, commentBody);
    }

    if (deps.notifier) {
      const botName = deps.botName || "Bot";
      const summaryText = parts.join(" ");
      const template = deps.copy.text("notify.on_call_supplement", {
        botName,
        identifier,
        summary: summaryText,
      });
      await notifyOnCallSupplement({
        notifier: deps.notifier,
        identifier,
        summary: summaryText,
        botName,
        template,
      }).catch(() => {});
    }

    if (deps.actions) {
      await deps.actions
        .execute({
          kind: "append",
          identifier,
          content: textContent,
        })
        .catch(() => ({ ok: true }));
    }

    return {
      outcome: "action_done",
      messages: [
        {
          text: deps.copy.text("action.done_append", { identifier }),
        },
      ],
      issue: { id: issueId ?? 0, identifier },
      docId: draft.docId,
    };
  }

  private async otherOpenTickets(
    chatId: string,
    exceptIdentifier: string,
  ): Promise<ReplyCandidate[]> {
    const { deps } = this;
    if (!deps.bindings || typeof deps.bindings.listBindingsForChat !== "function") return [];
    const list = deps.bindings.listBindingsForChat(chatId, 8, deps.identifierPrefix);
    const out: ReplyCandidate[] = [];
    for (const b of list) {
      if (b.identifier.toUpperCase() === exceptIdentifier.toUpperCase() || out.length >= 3)
        continue;
      try {
        const isClosed = await this.checkIssueClosed(b.issueId);
        if (isClosed) continue;
        const issue = await deps.tracker.getIssue(b.issueId).catch(() => null);
        out.push({
          identifier: b.identifier,
          issueId: b.issueId,
          title: issue?.title ?? b.title,
          ownTicket: true,
          mentioned: false,
        });
      } catch {
        // ignore errors reading one ticket
      }
    }
    return out;
  }

  private async checkIssueClosed(issueId: number): Promise<boolean> {
    const { deps } = this;
    if (deps.tracker.isIssueClosed) {
      try {
        return await deps.tracker.isIssueClosed(issueId);
      } catch {
        return false;
      }
    }
    if (deps.tracker.getIssueState) {
      try {
        const stateObj = await deps.tracker.getIssueState(issueId);
        return stateObj?.state === "done" || stateObj?.state === "canceled";
      } catch {
        return false;
      }
    }
    const issue = await deps.tracker.getIssue(issueId).catch(() => null);
    if (!issue) return false;
    return isIssueClosed(issue);
  }

  private async resolveClosedStatusLabel(issueId: number): Promise<string> {
    const { deps } = this;
    let isCanceled = false;
    if (deps.tracker.getIssueState) {
      try {
        const stateObj = await deps.tracker.getIssueState(issueId);
        if (stateObj?.state === "canceled" || stateObj?.stateType === "canceled") {
          isCanceled = true;
        }
      } catch {
        // ignore
      }
    }
    if (!isCanceled) {
      const issue = await deps.tracker.getIssue(issueId).catch(() => null);
      if (issue?.stateType === "canceled") {
        isCanceled = true;
      }
    }
    return deps.copy.text(isCanceled ? "status.closed_canceled" : "status.closed_done");
  }

  private async buildClosedRefusal(
    issueId: number,
    identifier: string,
    url?: string,
  ): Promise<StepOutput> {
    const statusLabel = await this.resolveClosedStatusLabel(issueId);
    return {
      outcome: "closed_refusal",
      messages: [
        {
          text: this.deps.copy.text("ticket.closed_refusal", {
            identifier,
            statusLabel,
          }),
        },
      ],
      issue: { id: issueId, identifier, url },
    };
  }

  private findConflictingField(draft: IntakeDraft, extracted: ExtractedFields): string | null {
    const existingIds = this.draftIdentifiers(draft);
    const incomingIds: Partial<Record<IdentifierKey, string>> = {
      ...(extracted.identifiers ?? {}),
    };
    for (const key of IDENTIFIER_KEYS) {
      const val = (extracted as unknown as Record<string, unknown>)[key] ?? extracted.values?.[key];
      if (typeof val === "string" && val.trim()) incomingIds[key] = val.trim();
    }
    return findIdentifierConflict(existingIds, incomingIds);
  }

  // ── small pieces ────────────────────────────────────────────────────────────
  private summaryOutput(draft: IntakeDraft, gate: GateResult): StepOutput {
    const { deps } = this;
    const priority = draft.ticket.priority || "medium";
    const priorityLabel = deps.copy.text(`priority.level.${priority}` as const);
    const derived: Record<string, string> = {
      priority: priorityLabel,
      muc_do_uu_tien: priorityLabel,
      muc_khan_cap: priorityLabel,
    };
    const systemField = this.resolveSystemField(draft.record?.variant);
    if (systemField && (!gate.effectiveValues[systemField] || !draft.record?.values[systemField])) {
      const unknownValue = deps.copy.text("field.unknown_value");
      derived[systemField] = unknownValue;
      gate.effectiveValues[systemField] = unknownValue;
    }
    const recap = buildRecap(deps.catalog, this.toRecord(draft), gate, { derived });
    let recapText = recap;
    const variant = getVariant(deps.catalog, this.resolveVariant(draft, draft.record));
    const blocked = new Set(deps.catalog.recapBlocklist);
    const hasPriorityInRecap = variant.recapFields.some(
      (f) =>
        (f === "priority" || f === "muc_do_uu_tien" || f === "muc_khan_cap") && !blocked.has(f),
    );
    if (!hasPriorityInRecap) {
      const priorityLine = deps.copy.text("summary.priority_line", { priority: priorityLabel });
      recapText = recap ? `${recap}\n${priorityLine}` : priorityLine;
    }
    const hint = deps.copy.text("summary.confirm_hint");
    const confirmLabel = deps.copy.text("button.confirm_create");
    return {
      outcome: "summary",
      messages: [
        {
          text: `${recapText}\n\n${hint}`.trim(),
          buttons: layoutButtons([{ text: confirmLabel, callbackData: confirmLabel }]),
        },
      ],
      docId: draft.docId,
    };
  }

  private resolvePriority(draft: IntakeDraft, extracted: ExtractedFields): Priority {
    const { deps } = this;
    const evidence = { ...(draft.evidence ?? {}) };
    const verdict = evaluatePriorityRules(deps.urgencyRules, "Medium", evidence);
    const reqPri = draft.requestedPriority;
    const requested =
      reqPri && reqPri.reason?.trim()
        ? {
            level: titleCase(reqPri.level),
            reason: reqPri.reason,
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
    skipConflictCheck?: boolean,
  ): IntakeDraft {
    const { deps } = this;
    const base = open ?? this.openFresh(input.chatId, nowIso);
    const ticket = { ...base.ticket };

    // structuredOnly = true khi tin xác nhận, huỷ, cảm ơn hoặc từ chối (B4)
    const isConfirmOrCancel =
      extracted.userIntent === "confirm" ||
      extracted.userIntent === "cancel" ||
      extracted.userIntent === "chitchat";
    const structuredOnly = declined || isConfirmOrCancel;

    // Title: fill if empty, or refresh when new content arrives (not locked).
    const carriesNewContent = (extracted.symptoms?.length ?? 0) > 0;
    if (
      !structuredOnly &&
      extracted.title &&
      (extracted.titleExplicit || !ticket.title || (carriesNewContent && !ticket.titleExplicit))
    ) {
      const candidate = cap(extracted.title.trim(), 120);
      const reportContext = `${ticket.rawText}\n${text}`;
      if (!isInvalidTitle(candidate, reportContext)) {
        ticket.title = candidate;
        if (extracted.titleExplicit) ticket.titleExplicit = true;
      }
    }

    // Symptoms (B4): union, dedupe, removals applied
    const prevSymptoms = base.symptoms ?? [];
    const removals = (extracted.removeSymptoms ?? [])
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    const keptPrev = prevSymptoms.filter((s) => !removals.some((r) => s.toLowerCase().includes(r)));
    const incomingSymptoms = structuredOnly
      ? []
      : (extracted.symptoms ?? [])
          .map((s) => truncate(s.trim(), 1500))
          .filter((s) => !isInternalCallbackToken(s));
    const mergedSymptoms = Array.from(
      new Set([...keptPrev, ...incomingSymptoms].filter(Boolean)),
    ).slice(-30);

    // rawText = reporter VERBATIM, appended across turns, capped (ADR-0010, §2).
    const message = truncate(text.trim(), MAX_RAW_TEXT_CHARS);
    const answeringTechQuestion =
      base.lastAskedFields?.includes(TECH_INFO_FIELD) === true && !declined;
    const answeringDescription =
      base.lastAskedFields?.includes("short_description") === true && !declined;
    const carriesText =
      !structuredOnly &&
      (incomingSymptoms.length > 0 ||
        hasIdentifier(extracted) ||
        extracted.userIntent === "report_issue" ||
        extracted.userIntent === "provide_info" ||
        answeringTechQuestion ||
        answeringDescription);
    if (carriesText && message && !isInternalCallbackToken(message)) {
      ticket.rawText =
        ticket.rawText && !ticket.rawText.includes(message)
          ? cap(`${ticket.rawText}\n${message}`, MAX_RAW_TEXT_TOTAL_CHARS)
          : ticket.rawText || cap(message, MAX_RAW_TEXT_TOTAL_CHARS);
    }
    if (answeringDescription && message && !ticket.rawText) {
      ticket.rawText = cap(message, MAX_RAW_TEXT_TOTAL_CHARS);
    }

    // Priority reason: answer to priority_reason question
    const answeringPriorityReason = base.lastAskedFields?.includes("priority_reason") === true;
    let requestedPriority = base.requestedPriority;
    if (extracted.requestedPriority) {
      const norm = extracted.requestedPriority.toLowerCase();
      const level: "high" | "urgent" = norm === "urgent" ? "urgent" : "high";
      requestedPriority = {
        level,
        reason: extracted.requestedPriorityReason
          ? truncate(extracted.requestedPriorityReason.trim(), 300)
          : requestedPriority?.reason,
      };
    }
    if (answeringPriorityReason) {
      if (declined) {
        if (requestedPriority) requestedPriority = { ...requestedPriority, reason: undefined };
      } else if (message) {
        const reason = truncate(message, 300);
        if (requestedPriority) requestedPriority = { ...requestedPriority, reason };
        else requestedPriority = { level: "high", reason };
      }
    }

    // Identifiers: fill blanks only — a created/collected id is never overwritten.
    const record = base.record ?? {
      variant: this.resolveVariant(base),
      values: {},
      questionCount: {},
      explicitlyMissing: [],
    };
    const values = { ...record.values, ...(extracted.values ?? {}) };
    for (const key of IDENTIFIER_KEYS) {
      const incoming = extracted.identifiers?.[key];
      if (incoming) {
        if (!values[key] || skipConflictCheck) {
          values[key] = incoming;
        }
      }
    }

    // Evidence monotonic ("bằng chứng chỉ nới" — B4):
    const evidence: Record<string, unknown> = { ...(base.evidence ?? {}) };
    const incomingScope = extracted.scope ?? (extracted.evidence?.scope as string | undefined);
    if (incomingScope) {
      const currentScope = (evidence.scope as string | undefined) ?? "none";
      if ((SCOPE_RANK[incomingScope] ?? 0) > (SCOPE_RANK[currentScope] ?? 0)) {
        evidence.scope = incomingScope;
      }
    }
    for (const flag of EVIDENCE_FLAGS) {
      const val = extracted[flag] ?? extracted.evidence?.[flag];
      if (typeof val === "boolean" && evidence[flag] !== true) {
        evidence[flag] = val;
      }
    }

    // Unrecognized dept (A5):
    let unrecognizedDept = base.unrecognizedDept;
    const unrecognizedCandidate =
      extracted.reportingDeptUnrecognized ??
      (extracted.values?.reportingDeptUnrecognized as string | undefined);
    if (unrecognizedCandidate && unrecognizedCandidate.trim() !== "") {
      unrecognizedDept = unrecognizedCandidate.trim();
    }
    const deptField = this.resolveDeptField(record.variant);
    if (deptField && values[deptField]) {
      unrecognizedDept = undefined;
    }

    // Media unioned, de-duped (§2).
    ticket.mediaPaths = Array.from(new Set([...(ticket.mediaPaths ?? []), ...mediaPaths]));

    return {
      ...base,
      status: "collecting",
      ticket,
      reporter: input.reporter ?? base.reporter,
      record: {
        ...record,
        variant: this.resolveVariant(base, { ...record, values }),
        values,
      },
      evidence,
      symptoms: mergedSymptoms,
      unrecognizedDept,
      requestedPriority,
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
    const record = createRecord(this.resolveVariant(draft, r), { ...(r?.values ?? {}) });
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
      variant: this.resolveVariant(draft),
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
    if (prefix && mentionedIdentifiers(text, prefix).length > 0) return true;
    return /\b[A-Z0-9_]+-\d+\b/i.test(text);
  }

  private async buildCandidates(
    chatId: string,
    draft: IntakeDraft | null,
    text: string,
  ): Promise<ReplyCandidate[]> {
    const { deps } = this;
    const out = new Map<string, ReplyCandidate>();
    const projectKey = deps.identifierPrefix ?? "TECH";

    // Explicitly mentioned ids resolve against the binding store.
    const mentioned = deps.identifierPrefix
      ? mentionedIdentifiers(text, deps.identifierPrefix)
      : (text.match(/\b[A-Z0-9_]+-\d+\b/gi) ?? []);

    const allBindings =
      typeof deps.bindings.listBindingsForChat === "function"
        ? deps.bindings.listBindingsForChat(chatId, 20)
        : [];

    // Bare numbers (/(?<!\d)(\d{3,5})(?!\d)/g): CHỈ tính khi khớp đúng một ticket CỦA CHÍNH người báo
    for (const m of text.matchAll(/(?<!\d)(\d{3,5})(?!\d)/g)) {
      const id = `${projectKey.toUpperCase()}-${Number(m[1])}`;
      if (
        !mentioned.some((x) => x.toUpperCase() === id.toUpperCase()) &&
        allBindings.some((b) => b.identifier.toUpperCase() === id.toUpperCase())
      ) {
        mentioned.push(id);
      }
    }

    for (const id of mentioned) {
      const prefix = id.split("-")[0];
      const binding =
        allBindings.find((b) => b.identifier.toUpperCase() === id.toUpperCase()) ??
        deps.bindings.getLatestBinding(chatId, prefix);
      const issue = await deps.tracker.findByIdentifier(id).catch(() => null);
      const isMatched = binding?.identifier?.toUpperCase() === id.toUpperCase();
      const issueId = issue?.id ?? (isMatched ? binding.issueId : 0);
      const title = issue?.title ?? (isMatched ? binding.title : undefined);
      const isOwn = this.isOwn(
        { identifier: id, issueId, ownTicket: isMatched, mentioned: true },
        chatId,
        issue?.description,
      );
      const existing = out.get(id.toUpperCase());
      if (existing) {
        existing.mentioned = true;
      } else {
        out.set(id.toUpperCase(), {
          identifier: id,
          issueId,
          title,
          ownTicket: isOwn,
          mentioned: true,
        });
      }
    }

    // The just-created ticket in this chat (a move_created candidate when another ticket is mentioned).
    if (
      out.size > 0 &&
      draft?.status === "created" &&
      draft.issueId &&
      draft.issueIdentifier &&
      !out.has(draft.issueIdentifier.toUpperCase())
    ) {
      const createdAt = Date.parse(draft.issueCreatedAt ?? draft.updatedAt);
      const fresh =
        !Number.isNaN(createdAt) && deps.clock.now() - createdAt <= JUST_CREATED_WINDOW_MS;
      if (fresh) {
        out.set(draft.issueIdentifier.toUpperCase(), {
          identifier: draft.issueIdentifier,
          issueId: draft.issueId,
          title: draft.ticket.title,
          ownTicket: true,
          mentioned: false,
          justCreated: true,
        });
      }
    }

    // Ticket kỹ thuật vừa hỏi (72h) qua message routes
    if (deps.routes && typeof deps.routes.getLatestMessageRouteForChat === "function") {
      const sinceMs = deps.clock.now() - TECH_QUESTION_WINDOW_MS;
      const chatIds = chatIdVariants(chatId);
      const route = deps.routes.getLatestMessageRouteForChat(
        "telegram",
        chatIds,
        sinceMs,
        "comment",
      );
      if (route) {
        const routeAt = route.createdAt ? Date.parse(`${route.createdAt.replace(" ", "T")}Z`) : NaN;
        const lastActivity = draft ? Date.parse(draft.updatedAt) : NaN;
        const routeIsFresh =
          !Number.isNaN(routeAt) && (Number.isNaN(lastActivity) || routeAt > lastActivity);
        const draftOpen = Boolean(
          draft &&
            !CLOSED_STATUSES.has(draft.status) &&
            Boolean(draft.ticket.title || draft.ticket.rawText?.trim()),
        );
        if (routeIsFresh && !draftOpen) {
          const isClosed = await this.checkIssueClosed(route.issueId);
          if (!isClosed) {
            const existing = out.get(route.identifier.toUpperCase());
            const techQuestion = await this.lastTechComment(route.issueId);
            out.set(route.identifier.toUpperCase(), {
              identifier: route.identifier,
              issueId: route.issueId,
              title: existing?.title,
              techQuestion,
              recentlyRelayed: true,
              ownTicket: true,
              mentioned: existing?.mentioned ?? false,
              justCreated: existing?.justCreated,
            });
          }
        }
      }
    }

    return [...out.values()].slice(0, 4);
  }

  private async lastTechComment(issueId: number): Promise<string | undefined> {
    try {
      if (!this.deps.tracker.getIssueTimeline) return undefined;
      const timeline = await this.deps.tracker.getIssueTimeline(issueId);
      if (!Array.isArray(timeline)) return undefined;
      const human = timeline.filter((e) => {
        if (!e || typeof e !== "object") return false;
        const entry = e as {
          kind?: string;
          body?: string;
          actorName?: string;
          actorKind?: string;
        };
        if (entry.kind !== "comment" || !entry.body || entry.actorKind === "agent") return false;
        if (isBotComment(entry.body)) return false;
        const actor = String(entry.actorName ?? "").trim();
        if (isSystemActor(actor, this.deps.ignoredActors)) return false;
        return true;
      }) as Array<{ body: string }>;
      return human.length ? human[human.length - 1].body : undefined;
    } catch {
      return undefined;
    }
  }

  private isOwn(target: ReplyCandidate, chatId: string, description?: string): boolean {
    if (target.ownTicket) return true;
    if (this.deps.ownership) {
      return this.deps.ownership.isOwnTicket({
        identifier: target.identifier,
        chatId,
        description,
      });
    }
    return bindingOwnershipPort(this.deps.bindings).isOwnTicket({
      identifier: target.identifier,
      chatId,
      description,
    });
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
