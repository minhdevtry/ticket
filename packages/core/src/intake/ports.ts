/**
 * Ports for the intake write engine (ticket 08).
 *
 * The engine never touches a tracker, a clock, a channel or a copy string
 * directly — every one of those is an injected interface. Ticket 04's Itsaplan
 * client satisfies `TrackerPort` through `itsaplanTrackerPort` (adapter.ts);
 * time is injected so the confirm-delay / stale guards are testable with a fake
 * clock; all user-facing Vietnamese lives in a `CopyCatalog` keyed by id, with
 * Tiểu Linh's own copy under `examples/tieulinh/` rather than in `src`.
 *
 * NGUỒN: intake `mcp/shared/tools/create-issue.ts` (TrackerConfig + the itsaplan
 * calls the write path makes), `lib/storage/binding-repository.ts`
 * (TicketBindingRepository), `lib/intake-step/pipeline.ts` (injected `now`,
 * minConfirmDelayMs). Spec §Implementation Decisions "Ports for the intake
 * engine".
 */

export type Priority = "urgent" | "high" | "medium" | "low";

/** A tracker ticket, trimmed to what the write path reads back. */
export interface TrackerIssue {
  id: number;
  identifier: string;
  title: string;
  /** Resolved web URL, if the port could build one. */
  url?: string;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  priority: Priority;
  /** Error-category label plus any explicit labels; the adapter resolves ids. */
  category?: string;
  labels?: string[];
}

/**
 * The write surface the intake engine needs. Deliberately minimal: create, read
 * back, comment, attach media, find an existing ticket by human identifier.
 * The Itsaplan client is one implementation (see adapter.ts); tests pass a fake.
 */
export interface TrackerPort {
  createIssue(input: CreateIssueInput): Promise<TrackerIssue>;
  getIssue(issueId: number): Promise<TrackerIssue | null>;
  addComment(issueId: number, body: string): Promise<void>;
  /**
   * Attach media files to a created issue and splice links into its
   * description. Per-file failures must not throw. Returns how many attached.
   */
  attach(issueId: number, description: string, mediaPaths: string[]): Promise<number>;
  findByIdentifier(identifier: string): Promise<TrackerIssue | null>;
}

/** Injected time source — one knob so the confirm/stale guards are testable. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * All user-facing strings, keyed. No Vietnamese literal ever lives in engine
 * logic — the engine asks the catalog for a key and interpolates `{named}`
 * placeholders. Tiểu Linh's defaults are an EXAMPLE catalog under
 * `examples/tieulinh/`, not part of the shipped library source.
 */
export interface CopyCatalog {
  /**
   * Resolve a copy key, substituting `{name}` placeholders from `vars`.
   * An unknown key throws — a missing string is a bug, not a silent blank.
   */
  text(key: CopyKey, vars?: Record<string, string | number>): string;
}

/** Copy keys the write engine emits. Kept as a closed union so a typo is a type error. */
export type CopyKey =
  // ── ticket 08: write path ──────────────────────────────────────────────────
  | "confirm.too_soon" // reject a confirm that arrived before minConfirmDelayMs
  | "confirm.in_progress" // another turn is creating the ticket right now
  | "confirm.resend" // last-resort net: draft lost + bare confirm, ask to resend
  | "ticket.created" // success; {identifier} {url}
  | "ticket.already_created" // idempotent return of an existing ticket; {identifier}
  | "ticket.create_failed" // tracker write errored; draft kept for retry
  // ── ticket 09: conversation engine ──────────────────────────────────────────
  | "ask.opening" // first open question when a fresh draft starts
  | "summary.confirm_hint" // trailing line under a recap asking to press the confirm button
  | "button.confirm_create" // label for the create-ticket confirm button
  | "button.confirm_append" // label for the "confirm append to {identifier}" button
  | "button.confirm_edit" // label for the "confirm edit {identifier}" button
  | "button.confirm_move" // label for the "confirm move to {identifier}" button
  | "button.new_incident" // label for "this is a new incident" (TECH-928 park)
  | "button.continue_draft" // label for "add to the draft I'm collecting"
  | "button.resume_parked" // label for "resume the parked draft" after the new one closed
  | "button.cancel_action" // label for cancelling a preview of a write to an existing ticket
  | "park.identifier_conflict" // a conflicting identifier arrived; new incident or append? (TECH-928)
  | "park.full_report" // a complete report arrived while another draft was mid-collection
  | "park.unclear" // reporter's answer to park was unclear; prompt again with buttons
  | "park.canceled" // reporter canceled the held park message
  | "park.reminder" // reminder appended when creating/canceling ticket that an earlier draft is waiting; {title}
  | "action.preview_append" // preview before appending to an existing ticket; {identifier} {content}
  | "action.preview_edit" // preview before editing an existing ticket; {identifier} {changes}
  | "action.preview_move" // preview before moving the just-created ticket; {from} {identifier}
  | "action.done_append" // append executed; {identifier}
  | "action.done_edit" // edit executed; {identifier}
  | "action.done_move" // move executed; {from} {identifier}
  | "action.canceled" // the previewed action was canceled
  | "lookup.status" // report an existing ticket's status; {identifier} {status}
  | "lookup.not_owner" // the ticket is someone else's — status only, no edits (ADR-0008 §6)
  | "draft.expired_new" // the previous draft expired; starting fresh
  | "draft.canceled" // the reporter canceled the draft on request
  | "draft.awaiting_confirmation" // a summary is shown; waiting for the reporter to press the button
  | "ask.missing_info" // still missing fields — ask the reporter to fill them in
  // ── PR 7: hỏi bổ sung theo luật (RFC 0002 §1.5 A1-A5) ─────────────────────
  | "ask.system" // ask system once with buttons (A3)
  | "ask.priority_reason" // ask priority reason once when urgent/high requested (A4); {level}
  | "ask.unrecognized_dept" // department mentioned but not in catalog (A5); {dept}
  | "clarify.greeting" // greeting when no description yet (A2)
  | "ask.describe_incident" // acknowledge media/input and ask description (A2); {item}
  | "ask.describe_incident_item" // default item description for ask.describe_incident ("ảnh anh/chị gửi")
  | "field.unknown_value" // default label when a field value is unknown/unspecified ("Chưa xác định")
  | "summary.priority_line" // priority line in summary when not in catalog recap fields; {priority}
  | "ticket.fallback_title" // fallback title when title is invalid/empty (B3)
  | "priority.level.low" // priority level label for Low
  | "priority.level.medium" // priority level label for Medium
  | "priority.level.high" // priority level label for High
  | "priority.level.urgent"; // priority level label for Urgent

/**
 * The chat↔ticket binding store, so a worker can report back to the reporter.
 * NGUỒN: `TicketBindingRepository.saveBinding` / `getLatestBinding`, narrowed to
 * what the write path uses.
 */
export interface ChannelBindingStore {
  saveBinding(binding: {
    issueId: number;
    chatId: string;
    identifier: string;
    title?: string;
    /**
     * KHÓA ĐỊNH DANH NGƯỜI BÁO: user id của kênh (Telegram = `from.id`). Đây là
     * cái bền — username đổi được, tên hiển thị đổi được, chat id của nhóm khác
     * với của cá nhân; user id thì cố định theo người. Lưu theo id để sau này
     * tra "ticket nào của người này" không lệ thuộc username/tên. Nullable để
     * tương thích ngược: DB cũ (và bot chưa truyền) vẫn chạy, chỉ thiếu trường.
     */
    reporterUserId?: string;
    /** Username hiển thị (phụ, có thể đổi) — KHÔNG dùng làm khóa định danh. */
    reporterUsername?: string;
  }): void;
  /** Most recent ticket bound to this chat (optionally scoped by identifier prefix). */
  getLatestBinding(
    chatId: string,
    identifierPrefix?: string,
  ): { issueId: number; identifier: string; title?: string } | null;
  /**
   * Ticket mới nhất gắn với MỘT NGƯỜI BÁO theo user id (khóa định danh bền), độc
   * lập với chat id. Tùy chọn vì không phải bot nào cũng tra theo người; bot
   * Telegram lưu `reporterUserId` thì dùng được. Không có id → null.
   */
  getLatestBindingByUserId?(
    reporterUserId: string,
    identifierPrefix?: string,
  ): { issueId: number; identifier: string; title?: string } | null;
  /**
   * Đổi tài khoản (A1): chuyển MỌI binding đang gắn `oldUserId` sang `newUserId`.
   * Khi người dùng đổi tài khoản Telegram, định danh (name_code) được relink sang
   * user id mới; các binding ticket cũ cũng phải theo người sang id mới để tra
   * ticket theo người (`getLatestBindingByUserId`) vẫn đúng và lịch sử ticket
   * không mất. Trả số binding đã chuyển. Tùy chọn — bot không lưu theo id thì
   * không cần. KHÔNG đụng `chat_id`: chat mới sẽ tự cập nhật khi có tin mới.
   */
  rebindReporterUserId?(oldUserId: string, newUserId: string): number;
}

/**
 * Turns the media references a reporter sent (paths, or "gửi ảnh giúp em") into
 * concrete file paths to upload. Injected so the engine stays channel-free —
 * `findRecentInboundMedia` lives in a bot, not the library.
 */
export interface MediaResolver {
  resolve(explicitPaths: string[], texts: string[]): string[];
}

/** Default resolver: pass explicit paths through, ignore text hints. */
export const passthroughMediaResolver: MediaResolver = {
  resolve: (explicitPaths) => Array.from(new Set(explicitPaths.filter(Boolean))),
};

// ── ticket 09: conversation-engine ports ────────────────────────────────────

/**
 * The fields a reporter's message can yield, extracted by an LLM. Channel-free
 * and tracker-free: the engine hands the extractor the stripped user text plus
 * light conversation context, and gets back a plain bag. One structured intent
 * (`report_issue`/`provide_info`/`confirm`/`cancel`/`chitchat`) plus whatever
 * fields and priority evidence it could read. Tests pass a scripted fake.
 *
 * NGUỒN: intake `lib/intake-step/extractor-schema.ts` (`ExtractedFields`), with
 * the Tiểu Linh-specific closed vocabularies left to the catalog/domain config.
 */
export type UserIntent = "report_issue" | "provide_info" | "confirm" | "cancel" | "chitchat";

export interface ExtractedFields {
  userIntent: UserIntent;
  title?: string | null;
  /** True only when the reporter explicitly asked to change the title. */
  titleExplicit?: boolean;
  /** Observed symptoms — these drive whether a message "carries new content". */
  symptoms?: string[];
  /** Symptoms explicitly asked to be removed (A14 / "bỏ ý ..."). */
  removeSymptoms?: string[];
  /** Structured identifier fields (phone/student/order/room/transaction/assignment). */
  identifiers?: Partial<Record<IdentifierKey, string>>;
  /** Catalog field name -> captured value (variant-specific; opaque to the engine). */
  values?: Record<string, string>;
  /** Priority evidence bag, fed straight to the priority rules. */
  evidence?: Record<string, unknown>;
  /** Reporter-requested priority level, honoured only with a reason (29/09 decision). */
  requestedPriority?: string | null;
  requestedPriorityReason?: string | null;

  // Trường miền cho bộ trích xuất: bộ trích xuất ghi thẳng tên trường đã chuẩn hoá
  // về danh mục, để công cụ khác (ví dụ bộ định danh) đọc mà không phải tra
  // `values`. Core không đoán tên miền: bộ trích xuất nhận danh mục từ app.
  product?: string;
  system?: string;
  errorCategory?: string;
  reportingDept?: string;
  reportingDeptUnrecognized?: string;
  deviceType?: string;
  deviceOs?: string;
  appVersion?: string;
  browser?: string;
  customerId?: string;
  studentAccount?: string;
  roomCode?: string;
  transactionId?: string;
  assignmentId?: string;
  scope?: "single_user" | "group" | "entire_system";
  blocksPayment?: boolean;
  reconciliationMismatch?: boolean;
  blocksLearning?: boolean;
  dataLoss?: boolean;
  hasWorkaround?: boolean;
  singleDeviceOnly?: boolean;
}

export const IDENTIFIER_KEYS = [
  "customerId",
  "studentAccount",
  "roomCode",
  "transactionId",
  "assignmentId",
] as const;
export type IdentifierKey = (typeof IDENTIFIER_KEYS)[number];

export interface ExtractInput {
  /** Channel-stripped reporter text (envelope already removed by the engine). */
  text: string;
  /** Number of media files on this turn — the extractor may use it as context. */
  attachments: number;
  /** The draft title so far, if any — context for intent classification. */
  draftTitle?: string;
  /**
   * Ngữ cảnh đầy đủ của lượt: tờ khai đang gom, câu hỏi kỹ thuật vừa hỏi,
   * ticket vừa tạo. Bộ trích xuất cần để phân biệt "câu trả lời cho câu hỏi
   * vừa hỏi" với "lời báo sự cố mới" (RFC 0002 mục 1.5, E6).
   */
  context?: ExtractContext;
}

/**
 * Ngữ cảnh mà engine đưa cho bộ trích xuất. Mọi trường đều do engine cắt
 * sẵn theo trần của legacy nên bộ trích xuất không cần biết trần là bao nhiêu.
 *
 * NGUỒN: legacy `lib/intake-step/pipeline.ts` (`contextOf`) — tiêu đề và
 * triệu chứng của tờ khai (trần 1.500 ký tự), câu hỏi kỹ thuật vừa hỏi,
 * ticket vừa tạo (trần tin 4.000 ký tự).
 */
export interface ExtractContext {
  /** Tiêu đề tờ khai đang gom. */
  draftTitle?: string;
  /** Mô tả tờ khai đang gom (đã cắt trần). */
  draftDescription?: string;
  /** Câu hỏi dữ kiện kỹ thuật vừa hỏi — tin này là câu trả lời. */
  techQuestion?: string;
  /** Các trường vừa hỏi — tin này có thể là câu trả lời cho một trong chúng. */
  lastAskedFields?: string[];
  /** Ticket vừa tạo trong chat này (đã cắt trần). */
  createdTicket?: { identifier: string; title?: string; description?: string };
}

export interface FieldExtractorPort {
  extract(input: ExtractInput): Promise<ExtractedFields>;
}

/**
 * Optional one-round technical review before asking for confirmation. Returns
 * the missing facts (empty = enough) and a single question. Any failure/timeout
 * must resolve to `{ missing: [] }` so it never blocks ticket creation.
 *
 * NGUỒN: intake `lib/intake-step/tech-review.ts` (`TechReviewer`).
 */
export interface TechReviewInput {
  title?: string;
  description: string;
  attachments: number;
  known: Record<string, string>;
}
export interface TechReviewOutput {
  missing: string[];
  question?: string;
}
export interface TechReviewerPort {
  review(input: TechReviewInput): Promise<TechReviewOutput>;
}

/**
 * Ownership as an injected predicate, NOT Telegram ids (ADR-0008 §6). The engine
 * asks "may this chat edit this ticket?"; a bot answers from its binding store
 * and/or description convention. Others' tickets get status only.
 */
export interface OwnershipPort {
  isOwnTicket(input: { identifier: string; chatId: string; description?: string }): boolean;
}

/** Default ownership: a ticket is "own" iff this chat holds its binding. */
export function bindingOwnershipPort(bindings: ChannelBindingStore): OwnershipPort {
  return {
    isOwnTicket({ identifier, chatId }) {
      // A loose check: the latest binding for this chat matches the identifier.
      const latest = bindings.getLatestBinding(chatId);
      return latest?.identifier?.toUpperCase() === identifier.toUpperCase();
    },
  };
}

/**
 * Executes a confirmed write to an EXISTING ticket (append/edit/move). Only ever
 * called after the reporter pressed the matching confirm button (ADR-0008). The
 * engine owns the preview + button gating; this port owns the tracker mechanics.
 */
export type TicketActionKind = "append" | "edit" | "move";
export interface TicketAction {
  kind: TicketActionKind;
  identifier: string;
  /** For append: the verbatim content to add as a comment. */
  content?: string;
  /** For edit: the reporter's instruction (the port plans + applies the diff). */
  instruction?: string;
  /** For move: the just-created ticket being folded into `identifier`. */
  from?: string;
}
export interface TicketActionResult {
  ok: boolean;
  /** Human-readable summary of what changed (for the done-message copy). */
  summary?: string;
}
export interface TicketActionExecutorPort {
  execute(action: TicketAction): Promise<TicketActionResult>;
}

/**
 * Reads ONE reporter message against the tickets already live in this chat and
 * says what the reporter wants done (append/edit/lookup/move/new). It NEVER
 * writes — every write still goes through the engine's preview + button
 * (ADR-0008). Injected because the interpretation is an LLM call in a bot and a
 * scripted fake in tests. When absent, every message is treated as `new`.
 *
 * NGUỒN: intake `lib/intake-step/ticket-reply-router.ts`.
 */
export interface ReplyCandidate {
  identifier: string;
  issueId: number;
  title?: string;
  ownTicket: boolean;
  /** The reporter named this identifier in the message. */
  mentioned: boolean;
  /** The bot just created this ticket in this chat (a move_created candidate). */
  justCreated?: boolean;
}
export type TicketCommand =
  | { action: "append"; identifier: string; content: string }
  | { action: "edit"; identifier: string; instruction: string }
  | { action: "lookup"; identifier: string }
  | { action: "move_created"; from: string; identifier: string }
  | { action: "new" }
  | { action: "unclear" };
export interface TicketCommandInput {
  message: string;
  attachments: number;
  candidates: ReplyCandidate[];
  draftTitle?: string;
}
export interface TicketCommandInterpreterPort {
  interpret(input: TicketCommandInput): Promise<TicketCommand>;
}

/**
 * Optional post-create side effect: KG/Onyx/similar-ticket ingestion. NEVER
 * implemented in the library (ADR-0002/0003/0007 are Tiểu Linh-only). A bot
 * injects one; failures are swallowed and never block the reporter's reply.
 */
export interface PostCreateHookPort {
  afterCreate(input: { issue: TrackerIssue; description: string; chatId: string }): Promise<void>;
}

// ── ticket 14: notify (webhook → chat) ports ────────────────────────────────
//
// The notify layer never imports a channel (Telegram is ticket 12, injected as
// a `ChannelPort` implementation) and never speaks Vietnamese in logic — every
// user-facing string is produced by an injected `StateChangeCopyMap` keyed per
// project. NGUỒN: intake `worker/notifier.ts` (the `Notifier` interface the
// dispatcher/closure call), `lib/storage/binding-repository.ts` (message
// routes, binding read by issue id), `worker/ticket-closure.ts` (ADR-0006
// closure rule). See src/intake/notify/.

/** The three lifecycle states the notify layer reports to a reporter (ADR-0006). */
export type TicketLifecycleState = "resolved" | "done" | "canceled" | "open";

/**
 * A chat destination to send to, resolved from a binding/route. Channel-free:
 * `channelType` picks which `ChannelPort` to use; `chatId` is opaque.
 */
export interface NotifyBinding {
  issueId: number;
  identifier: string;
  chatId: string;
  channelType: string;
  title?: string;
  /** User id người báo (khóa định danh bền). Có khi binding được ghi kèm id. */
  reporterUserId?: string;
  reporterUsername?: string;
}

/**
 * The send surface the notify dispatcher needs — the ONE seam Telegram (ticket
 * 12) plugs into. The library never imports a channel; a bot supplies this.
 * `sendComment`/`sendStateChange` return the sent message id (so a reply route
 * can be recorded) or null/undefined when the channel cannot report one.
 *
 * NGUỒN: intake `worker/notifier.ts` `Notifier` (`notifyComment`,
 * `notifyStateChange`, `clearInteractiveButtons`), narrowed to notify's needs.
 */
export interface ChannelPort {
  readonly channelType: string;
  /** Forward a human comment to the reporter. */
  sendComment(input: {
    binding: NotifyBinding;
    authorName: string;
    text: string;
    images?: string[];
    videos?: string[];
  }): Promise<string | number | null | void>;
  /**
   * Report a ticket state change. `message` is the already-resolved copy string
   * (produced by the injected `StateChangeCopyMap` — no Vietnamese in logic).
   * `withReporterOkButton` is true only for the resolved→"press OK" prompt
   * (ADR-0006): the button records a comment, never a state change.
   */
  sendStateChange(input: {
    binding: NotifyBinding;
    message: string;
    state: TicketLifecycleState;
    withReporterOkButton: boolean;
  }): Promise<string | number | null | void>;
  /** Remove interactive buttons from a previously-sent message. Optional. */
  clearInteractiveButtons?(binding: NotifyBinding, messageId: string): Promise<void>;
  /**
   * Báo động tới kênh trực ca (không gắn với một người báo): vd ticket quá hạn SLA chưa ai nhận.
   * Tuỳ chọn: kênh không có chỗ trực ca thì bỏ trống, nơi gọi phải chịu được việc thiếu.
   * Trả `false` = KHÔNG gửi được mà không ném (vd chưa cấu hình chat trực ca): nơi gọi không được
   * coi là đã báo. Trả `void`/`true` hoặc không ném = đã giao cho kênh. NGUỒN: intake `Notifier.broadcastAlert`.
   */
  sendAlert?(text: string): Promise<void | boolean>;
}

/**
 * Resolves the per-project copy for a state change. Injected so no Vietnamese
 * literal lives in dispatcher/closure logic. `project` is the identifier prefix
 * ("TECH", "PO"); `columnName` is the resolved column name; `state` is the
 * classified lifecycle state. Returns the message to send, or null to send
 * nothing. NGUỒN: intake `lib/itsaplan/state-messages.ts` `describeState`
 * (kept OUT of core — Tiểu Linh-only), reframed as an injected map.
 */
export interface StateChangeCopyMap {
  describe(input: {
    project: string;
    columnName: string;
    state: TicketLifecycleState;
    identifier: string;
  }): string | null;
}

/**
 * Trạng thái vòng đời cuối cùng bot đã THẤY của một ticket, để không báo lại cùng một trạng thái
 * (một lần kéo cột bắn nhiều sự kiện, webhook có thể tới lại) và để biết tin nào đang mang nút
 * "Đã ổn". NGUỒN: intake bảng `ticket_states` của `worker/ticket-closure.ts`.
 */
export interface TicketStateRecord {
  issueId: number;
  identifier: string;
  state: TicketLifecycleState;
  columnId: number | null;
  /** Id tin đang mang nút "Đã ổn" (chỉ có khi `state` là `resolved` và tin đã gửi được). */
  promptMessageId: string | null;
  /** Lúc người báo bấm "Đã ổn" (epoch ms); `null` nếu chưa. */
  reporterOkAt: number | null;
  updatedAt: number;
}

/** Kho trạng thái đã thấy của ticket (xem {@link TicketStateRecord}). */
export interface TicketStateStore {
  get(issueId: number): TicketStateRecord | null;
  /** Ghi trạng thái mới (xoá tin-nút và dấu "Đã ổn" của trạng thái cũ). */
  enter(input: {
    issueId: number;
    identifier: string;
    state: TicketLifecycleState;
    columnId: number | null;
    now: number;
  }): void;
  /** Nhớ id tin vừa gửi mang nút "Đã ổn". */
  setPrompt(issueId: number, messageId: string): void;
  /** Ghi nhận người báo đã bấm "Đã ổn" (không đổi trạng thái). */
  markReporterOk(issueId: number, now: number): void;
}

/** How a notification message was sent, so a reply can be routed back. */
export type MessageRouteKind = "comment" | "state" | "";

export interface MessageRoute {
  messageId: string;
  channelType: string;
  chatId: string;
  issueId: number;
  identifier: string;
}

/**
 * Records and reads message routes keyed by (messageId, channel, chatId), so a
 * reporter's reply to a notification message is routed to the right ticket.
 * NGUỒN: intake `lib/storage/binding-repository.ts` `saveMessageRoute` /
 * `getMessageRoute` (fd48c6e: chat-scoped lookup — a route with no chat is only
 * a fallback when the ticket's binding is in the asking chat, else null).
 */
export interface MessageRouteStore {
  saveMessageRoute(route: {
    messageId: string;
    channelType: string;
    chatId: string;
    issueId: number;
    identifier: string;
    kind: MessageRouteKind;
  }): void;
  /**
   * Resolve (messageId, channel, chatId) to a route. A row stored with an empty
   * chatId is used ONLY as a fallback when the asking chat holds that issue's
   * binding (fd48c6e); otherwise return null rather than route into the wrong
   * chat's ticket.
   */
  getMessageRoute(messageId: string, channelType: string, chatId: string): MessageRoute | null;
}

/**
 * The binding read the notify dispatcher needs: full binding BY ISSUE ID (the
 * webhook only carries an issue id). The write-path `ChannelBindingStore` keys
 * by chat; notify keys by issue, so this is a separate read port. NGUỒN: intake
 * `lib/storage/binding-repository.ts` `getBindingByIssueId`.
 */
export interface NotifyBindingReader {
  getBindingByIssueId(issueId: number): NotifyBinding | null;
}

/**
 * Durable dedup of webhook deliveries behind an interface (CM hardening:
 * `worker/dedup-store.ts` + `lib/domain/dedup.ts`). The in-memory LRU in the
 * webhook server survives one process; this survives restarts and is shared by
 * sibling workers. `claim` returns true for the winner (new event), false when
 * another process already holds the key. NGUỒN: CM `WebhookDedupStore.claim`
 * (BEGIN IMMEDIATE + `ON CONFLICT ... WHERE expires_at <= ?` CAS).
 */
export interface WebhookDedupeStore {
  /** True = this is a new event to process; false = already seen (skip). */
  claim(key: string): boolean;
}
