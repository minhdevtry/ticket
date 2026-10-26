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
  type GateResult,
} from "../gate";
import { evaluatePriorityRules, resolveRequestedPriority, type UrgencyRules } from "../priority";
import {
  findIdentifierConflict,
  extractLabelledIdentifiers,
  identityConflict,
} from "./identifiers";
import { mentionedIdentifiers, foldButton, saysNewIncident, withTypedDetail } from "./text";
import { isDeclineAnswer, isMeaninglessInput, TECH_INFO_FIELD } from "./normalize";
import { MAX_RAW_TEXT_CHARS, MAX_RAW_TEXT_TOTAL_CHARS } from "../raw-text";
import type { StepInput, StepOutput, ChannelMessage } from "./types";
import { type ReplayOraclePort, applyReplayControlOverride } from "./oracle";
import { isInvalidTitle, deriveFallbackTitle, isExplicitCancel } from "../extractor/heuristics";
import { SCOPE_RANK, EVIDENCE_FLAGS } from "../extractor/merger";

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
      return this.resolvePendingAction(draft, text);
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
    options?: { skipConflictCheck?: boolean },
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
      const out: StepOutput = {
        outcome: "canceled",
        messages: [{ text: deps.copy.text("draft.canceled") }],
      };
      return open ? this.appendParkedReminder(out, open) : out;
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
      };
    }

    if (isGreetingOnly) {
      deps.drafts.saveRevision(draft);
      return {
        outcome: "clarify",
        messages: [{ text: deps.copy.text("clarify.greeting") }],
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
    return this.deps.variant;
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
        if (deps.postCreate) {
          await safe(() =>
            deps.postCreate!.afterCreate({
              issue: result.issue,
              description: draft.ticket.rawText,
              chatId: draft.chatId,
            }),
          );
        }
        const out: StepOutput = {
          outcome: "created",
          messages: [{ text: result.message }],
          issue: {
            id: result.issue.id,
            identifier: result.issue.identifier,
            url: result.issue.url,
          },
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
