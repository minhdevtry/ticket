/**
 * Lễ tân Replay & Chỉ số sẵn sàng (RFC 0002 §4.3 - §4.5, PR 6).
 *
 * Thực thi 3 tầng so sánh:
 * - Tầng 1 (cổng chính): đánh giá từng lượt, ép nhánh điều khiển theo TL1 ở lượt quá khứ (1..t-1),
 *   chạy step(t) thật trên kho cô lập, phân lớp lệch S0/S1/S2.
 * - Tầng 2 (thông tin): chạy tự do cả cuộc hội thoại từ đầu, đo điểm lệch đầu tiên và độ hội tụ.
 * - Tầng 3 (nới lỏng xác nhận): khi TL1 tạo ticket, kiểm gate của TL2. Nếu đủ thì lấy payload
 *   dự kiến so với tóm tắt TL1; nếu thiếu thì ghi `tl2_stricter` (không ép).
 *
 * Tính các chỉ số M0-M4 theo RFC 4.5.
 */
import { Database } from "bun:sqlite";
import {
  type Clock,
  type CopyCatalog,
  type CreateIssueInput,
  type FieldCatalog,
  type FieldExtractorPort,
  IntakeEngine,
  type IntakeEngineDeps,
  MIN_CONFIRM_DELAY_MS,
  type ReplayOraclePort,
  SqliteChannelBindingStore,
  SqliteDraftRepository,
  type StepOutcome,
  TEST_COPY,
  type TrackerIssue,
  type TrackerPort,
  type UrgencyRules,
  engineTestCatalog,
  evaluateGate,
  intakeApplySchema,
  legacyActionForOutcome,
  makeCopyCatalog,
  outcomesForLegacyAction,
} from "@vuihoc/bot-core/intake";
import type { IntakeDraft } from "@vuihoc/bot-core/intake";
import {
  classifyTl1Reply,
  extractAskedField,
  type LegacyIntakeAction,
  readTl1Summary,
  type Tl1Summary,
} from "./classify-tl1.ts";
import type { PairDiff, PairV2 } from "./queue.ts";

export interface ReplayTurnInput {
  user: string;
  tl1Reply?: string | null;
  mediaPaths?: string[];
  eid?: string;
  ts?: number;
}

export class IsolatedTracker implements TrackerPort {
  created: CreateIssueInput[] = [];
  comments: Array<{ issueId: number; body: string }> = [];

  private nextId = 1;

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    this.created.push(input);
    const id = this.nextId++;
    return {
      id,
      identifier: `TECH-${id}`,
      url: `https://itsaplan.local/TECH-${id}`,
      title: input.title,
    };
  }

  async getIssue(issueId: number): Promise<TrackerIssue | null> {
    const found = this.created[issueId - 1];
    if (!found) return null;
    return {
      id: issueId,
      identifier: `TECH-${issueId}`,
      url: `https://itsaplan.local/TECH-${issueId}`,
      title: found.title,
    };
  }

  async addComment(issueId: number, body: string): Promise<void> {
    this.comments.push({ issueId, body });
  }

  async attach(_issueId: number, _description: string, mediaPaths: string[]): Promise<number> {
    return mediaPaths.length;
  }

  async findByIdentifier(identifier: string): Promise<TrackerIssue | null> {
    const m = identifier.match(/TECH-(\d+)/i);
    if (!m) return null;
    return this.getIssue(Number.parseInt(m[1], 10));
  }
}

export class ReplayClock implements Clock {
  constructor(private currentTime = 1_767_225_600_000) {}
  now(): number {
    return this.currentTime;
  }
  advance(ms: number): void {
    this.currentTime += ms;
  }
}

export interface ReplayDeps {
  extractor: FieldExtractorPort;
  catalog?: FieldCatalog;
  variant?: string;
  urgencyRules?: UrgencyRules;
  clock?: Clock;
  copy?: CopyCatalog;
}

function makeIsolatedEngine(
  db: Database,
  deps: ReplayDeps,
  tracker: TrackerPort,
  oracle?: ReplayOraclePort,
): { engine: IntakeEngine; drafts: SqliteDraftRepository } {
  intakeApplySchema(db);
  const drafts = new SqliteDraftRepository(db);
  const bindings = new SqliteChannelBindingStore(db);
  const clock = deps.clock ?? new ReplayClock();
  const copy = deps.copy ?? makeCopyCatalog(TEST_COPY);

  const engineDeps: IntakeEngineDeps = {
    tracker,
    drafts,
    bindings,
    copy,
    clock,
    extractor: deps.extractor,
    catalog: deps.catalog ?? engineTestCatalog,
    variant: deps.variant ?? "tech",
    urgencyRules: deps.urgencyRules ?? {
      levels: ["low", "medium", "high", "urgent"],
      floors: [],
      ceilings: [],
    },
    oracle,
  };
  return { engine: new IntakeEngine(engineDeps), drafts };
}

/**
 * Phân lớp lệch S0 / S1 / S2 theo RFC 4.4.
 */
function normalizePriority(p: string): string {
  const s = p.trim().toLowerCase();
  if (s === "khẩn cấp" || s === "rất khẩn cấp" || s === "urgent") return "urgent";
  if (s === "cao" || s === "gấp" || s === "high") return "high";
  if (s === "trung bình" || s === "bình thường" || s === "medium") return "medium";
  if (s === "thấp" || s === "không gấp" || s === "low") return "low";
  return s;
}

export function classifyDiff(
  tl1: { reply?: string | null; action: LegacyIntakeAction; summary?: Tl1Summary | null },
  tl2: {
    outcome: string;
    reply: string;
    buttons: string[];
    fields: Record<string, unknown>;
    createdTicket?: TrackerIssue;
  },
  _userText: string,
  context: {
    userIntent?: string;
    pastUserMessages: string[];
    draft?: IntakeDraft | null;
    trackedIdentifier?: string;
  },
): PairDiff {
  // ── S0 (Không an toàn) ──────────────────────────────────────────────────
  // 1. Tạo ticket khi người dùng chưa xác nhận hoặc khi TL1 chỉ hỏi
  if (
    tl2.outcome === "created" &&
    tl1.action !== "ticket_created" &&
    context.userIntent !== "confirm"
  ) {
    return {
      class: "S0",
      code: "unconfirmed_ticket_creation",
      detail: "TL2 tạo ticket khi người dùng chưa xác nhận và TL1 không tạo ticket",
    };
  }
  // 1b. Ghi vào ticket đã có khi TL1 chỉ hỏi (RFC 0002 §4.4)
  if (tl2.outcome === "action_done" && tl1.action === "ask_missing_field") {
    return {
      class: "S0",
      code: "existing_ticket_write",
      detail: "TL2 ghi vào ticket đã có khi TL1 chỉ hỏi",
    };
  }

  // 1c. Đè định danh: TL2 ghi đè định danh của ticket đã có (RFC 0002 §4.4)
  if (
    (tl2.outcome === "action_done" || tl2.outcome === "created") &&
    context.draft?.issueIdentifier
  ) {
    const targetIdentifier =
      (tl2.fields?.identifier as string) ??
      (tl2.fields?.issueIdentifier as string) ??
      tl2.createdTicket?.identifier;
    if (targetIdentifier && targetIdentifier !== context.draft.issueIdentifier) {
      return {
        class: "S0",
        code: "identifier_overwritten",
        detail: `TL2 ghi đè định danh ticket: cũ=${context.draft.issueIdentifier}, mới=${targetIdentifier}`,
      };
    }
  }

  // 1d. Huỷ/đóng ticket không phải của người báo (RFC 0002 §4.4)
  if (tl2.outcome === "action_canceled" || tl2.outcome === "closed_refusal") {
    const targetId =
      (tl2.fields?.identifier as string) ??
      (tl2.fields?.issueIdentifier as string) ??
      context.draft?.pendingTicketAction?.identifier;
    const trackedId = context.trackedIdentifier ?? context.draft?.issueIdentifier;
    if (targetId && trackedId && targetId !== trackedId) {
      return {
        class: "S0",
        code: "foreign_ticket_closed",
        detail: `TL2 huỷ/đóng ticket không phải của người báo: đang theo dõi=${trackedId}, thao tác=${targetId}`,
      };
    }
  }

  // 2. Lộ phong bì kênh hoặc token noop vào ticket
  const ticketDesc = context.draft?.ticket.rawText ?? "";
  const ticketTitle = context.draft?.ticket.title ?? "";
  if (
    /Conversation info|untrusted metadata/i.test(ticketDesc) ||
    /Conversation info|untrusted metadata/i.test(ticketTitle)
  ) {
    return {
      class: "S0",
      code: "envelope_leak",
      detail: "Phong bì kênh bị lộ vào mô tả hoặc tiêu đề ticket",
    };
  }
  if (/\bnoop\b/i.test(ticketTitle) || /\bcallback_data:\s*noop\b/i.test(ticketDesc)) {
    return {
      class: "S0",
      code: "noop_leak",
      detail: "Token nội bộ noop bị lộ vào ticket",
    };
  }

  // 3. Mất chữ người báo khỏi rawText (khi có ticket được tạo)
  if (tl2.outcome === "created" || tl1.action === "ticket_created") {
    for (const msg of context.pastUserMessages) {
      const trimmed = msg.trim();
      // Bỏ qua tin xác nhận ngắn hoặc tin huỷ
      if (
        trimmed &&
        !/^(đúng rồi|ok|yes|chuẩn|đồng ý|hủy|thôi)$/i.test(trimmed) &&
        !trimmed.startsWith("callback_data:")
      ) {
        // Kiểm tra chữ có trong rawText
        const firstWords = trimmed.slice(0, Math.min(trimmed.length, 30));
        if (!ticketDesc.includes(firstWords)) {
          return {
            class: "S0",
            code: "rawtext_missing_words",
            detail: `Mất chữ của người báo khỏi rawText: "${firstWords}..."`,
          };
        }
      }
    }
  }

  // ── S1 (Hành vi) ────────────────────────────────────────────────────────
  // 1. Cùng hỏi thông tin nhưng hỏi trường khác nhau -> S1
  if (tl1.action === "ask_missing_field" && tl2.outcome === "asked") {
    const tl1Field = extractAskedField(tl1.reply);
    const tl2Field = context.draft?.lastAskedFields?.[0] ?? extractAskedField(tl2.reply);
    if (tl1Field && tl2Field && tl1Field !== tl2Field) {
      return {
        class: "S1",
        code: "asked_other_field",
        tl1Field,
        tl2Field,
        detail: `TL1 hỏi ${tl1Field}, TL2 hỏi ${tl2Field}`,
      };
    }
  }

  // 2. Kiểm tra khớp action class
  const allowedOutcomes = outcomesForLegacyAction(tl1.action);
  const actionMatches =
    allowedOutcomes.includes(tl2.outcome as StepOutcome) ||
    legacyActionForOutcome(tl2.outcome as StepOutcome) === tl1.action;

  if (!actionMatches) {
    // Lệch rẽ nhánh (park / split)
    if (
      tl1.action === "ask_split_or_merge" ||
      tl1.action === "ask_new_or_continue" ||
      tl2.outcome === "split_question" ||
      tl2.outcome === "parked"
    ) {
      return {
        class: "S1",
        code: "branch_mismatch",
        detail: `Quyết định rẽ nhánh khác nhau: TL1=${tl1.action}, TL2=${tl2.outcome}`,
      };
    }

    return {
      class: "S1",
      code: "action_mismatch",
      detail: `Lệch hành động: TL1=${tl1.action}, TL2=${tl2.outcome}`,
    };
  }

  // Nếu cùng ở lúc tóm tắt / xác nhận: so nội dung 6 trường theo RFC 0002 §4.5 M2
  if ((tl1.action === "confirm_summary" || tl1.action === "ticket_created") && tl1.summary) {
    const s = tl1.summary;
    const values = context.draft?.record?.values ?? {};

    // 1. Hệ thống
    const effectiveSystem = (values.system as string) || (values.he_thong as string);
    if (
      s.system &&
      effectiveSystem &&
      s.system.trim().toLowerCase() !== effectiveSystem.trim().toLowerCase()
    ) {
      return {
        class: "S1",
        code: "ticket_field_mismatch",
        tl1Field: s.system,
        tl2Field: effectiveSystem,
        detail: `Lệch hệ thống: TL1=${s.system}, TL2=${effectiveSystem}`,
      };
    }

    // 2. Bộ phận
    const effectiveDept =
      (values.reporting_dept as string) ||
      (values.bo_phan as string) ||
      (values.phong_ban as string);
    if (
      s.reportingDept &&
      effectiveDept &&
      s.reportingDept.trim().toLowerCase() !== effectiveDept.trim().toLowerCase()
    ) {
      return {
        class: "S1",
        code: "ticket_field_mismatch",
        tl1Field: s.reportingDept,
        tl2Field: effectiveDept,
        detail: `Lệch bộ phận: TL1=${s.reportingDept}, TL2=${effectiveDept}`,
      };
    }

    // 3. Sản phẩm
    const effectiveProduct = (values.product as string) || (values.san_pham as string);
    if (
      s.product &&
      effectiveProduct &&
      s.product.trim().toLowerCase() !== effectiveProduct.trim().toLowerCase()
    ) {
      return {
        class: "S1",
        code: "ticket_field_mismatch",
        tl1Field: s.product,
        tl2Field: effectiveProduct,
        detail: `Lệch sản phẩm: TL1=${s.product}, TL2=${effectiveProduct}`,
      };
    }

    // 4. Mức ưu tiên
    const effectivePriority =
      (values.muc_uu_tien as string) ||
      (values.priority as string) ||
      context.draft?.ticket?.priority;
    if (s.priority && effectivePriority) {
      const p1 = normalizePriority(s.priority);
      const p2 = normalizePriority(String(effectivePriority));
      if (p1 !== p2) {
        return {
          class: "S1",
          code: "ticket_field_mismatch",
          tl1Field: s.priority,
          tl2Field: String(effectivePriority),
          detail: `Lệch mức ưu tiên: TL1=${s.priority}, TL2=${effectivePriority}`,
        };
      }
    }

    // 5. Định danh (mã khách hàng / tài khoản học sinh / SĐT)
    const sIdentifier = s.customerId || s.studentAccount;
    const effectiveIdentifier =
      (values.dinh_danh as string) ||
      (values.studentAccount as string) ||
      (values.student_account as string) ||
      (values.customerId as string) ||
      (values.customer_id as string) ||
      (values.ma_khach_hang as string) ||
      (values.tai_khoan_hs as string) ||
      (values.sdt as string);
    if (
      sIdentifier &&
      effectiveIdentifier &&
      sIdentifier.trim().toLowerCase() !== effectiveIdentifier.trim().toLowerCase()
    ) {
      return {
        class: "S1",
        code: "ticket_field_mismatch",
        tl1Field: sIdentifier,
        tl2Field: effectiveIdentifier,
        detail: `Lệch định danh: TL1=${sIdentifier}, TL2=${effectiveIdentifier}`,
      };
    }

    // 6. Số tệp đính kèm
    if (typeof s.attachmentCount === "number") {
      const effectiveAttachCount =
        typeof values.so_tep === "number"
          ? values.so_tep
          : typeof values.attachment_count === "number"
            ? values.attachment_count
            : context.draft?.ticket?.mediaPaths?.length;
      if (typeof effectiveAttachCount === "number" && s.attachmentCount !== effectiveAttachCount) {
        return {
          class: "S1",
          code: "attachment_count_mismatch",
          tl1Field: String(s.attachmentCount),
          tl2Field: String(effectiveAttachCount),
          detail: `Lệch số tệp đính kèm: TL1=${s.attachmentCount}, TL2=${effectiveAttachCount}`,
        };
      }
    }
  }

  // ── S2 (Bề mặt) ────────────────────────────────────────────────────────
  // Câu chữ hoặc nút khác nhau nhưng cùng chung hành động và quyết định
  if (tl1.reply && tl1.reply.trim() !== tl2.reply.trim()) {
    return {
      class: "S2",
      code: "wording_difference",
      detail: "Cùng hành động nhưng câu chữ khác nhau",
    };
  }

  return {
    class: null,
    code: "match",
  };
}

/**
 * Tầng 1: Đánh giá một lượt `t` độc lập.
 * Ép quyết định quá khứ (0..t-1), chạy thật lượt `t` trên kho cô lập.
 */
export async function replayTurn(
  chatId: string,
  turns: ReplayTurnInput[],
  targetTurnIndex: number,
  deps: ReplayDeps,
): Promise<PairV2> {
  const t0 = performance.now();
  const db = new Database(":memory:");
  const tracker = new IsolatedTracker();

  // Dựng oracle cho các lượt quá khứ (0..targetTurnIndex - 1)
  let currentPastIndex = 0;
  const oracle: ReplayOraclePort = {
    getControlAction: () => {
      if (currentPastIndex >= targetTurnIndex) return null;
      const pastTurn = turns[currentPastIndex];
      const action = classifyTl1Reply(pastTurn.tl1Reply);

      switch (action) {
        case "ask_missing_field": {
          const field = extractAskedField(pastTurn.tl1Reply);
          return { action: "ask_missing_field", field };
        }
        case "confirm_summary": {
          return { action: "confirm_summary" };
        }
        case "awaiting_user_confirmation": {
          return { action: "awaiting_user_confirmation" };
        }
        case "ticket_created": {
          return { action: "ticket_created", issueIdentifier: "TECH-REPLAY" };
        }
        case "canceled": {
          return { action: "canceled" };
        }
        case "ask_split_or_merge": {
          return { action: "ask_split_or_merge" };
        }
        case "ask_new_or_continue": {
          return { action: "ask_new_or_continue" };
        }
        default:
          return null;
      }
    },
  };

  const { engine, drafts } = makeIsolatedEngine(db, deps, tracker, oracle);

  // 1. Chạy lại các lượt quá khứ với oracle ép điều khiển
  for (let i = 0; i < targetTurnIndex; i++) {
    currentPastIndex = i;
    await engine.step({
      chatId,
      message: turns[i].user,
      mediaPaths: turns[i].mediaPaths ?? [],
    });
  }

  // 2. Chạy thật lượt t: oracle trả về null
  currentPastIndex = targetTurnIndex;
  const targetTurn = turns[targetTurnIndex];
  const output = await engine.step({
    chatId,
    message: targetTurn.user,
    mediaPaths: targetTurn.mediaPaths ?? [],
  });
  const latencyMs = Math.round(performance.now() - t0);

  const finalDraft = drafts.getLatestByChatId(chatId);
  const tl1Action = classifyTl1Reply(targetTurn.tl1Reply);
  const tl1Summary = readTl1Summary(targetTurn.tl1Reply);

  const tl2Reply = output.messages.map((m) => m.text).join("\n\n");
  const tl2Buttons = output.messages.flatMap((m) =>
    m.buttons ? m.buttons.flat().map((b) => b.text) : [],
  );
  const tl2Fields = (finalDraft?.record?.values as Record<string, unknown>) ?? {};

  const userIntent = output.outcome === "created" ? "confirm" : undefined;

  const diff = classifyDiff(
    { reply: targetTurn.tl1Reply, action: tl1Action, summary: tl1Summary },
    {
      outcome: output.outcome,
      reply: tl2Reply,
      buttons: tl2Buttons,
      fields: tl2Fields,
      createdTicket: tracker.created[0]
        ? {
            id: 1,
            identifier: "TECH-1",
            url: "https://itsaplan.local/TECH-1",
            title: tracker.created[0].title,
          }
        : undefined,
    },
    targetTurn.user,
    {
      userIntent,
      pastUserMessages: turns.slice(0, targetTurnIndex + 1).map((t) => t.user),
      draft: finalDraft,
    },
  );

  return {
    v: 2,
    eid: targetTurn.eid ?? `eid-${targetTurnIndex}`,
    ts: targetTurn.ts ?? Date.now(),
    chatId,
    text: targetTurn.user,
    tl1: {
      reply: targetTurn.tl1Reply ?? null,
      action: tl1Action,
      summary: tl1Summary ? (tl1Summary as Record<string, unknown>) : null,
    },
    tl2: {
      target: "receptionist",
      outcome: output.outcome,
      reply: tl2Reply,
      buttons: tl2Buttons,
      fields: tl2Fields,
      latencyMs,
      error: null,
    },
    diff,
  };
}

/**
 * Tầng 2: Chạy tự do cả cuộc trò chuyện từ đầu (thông tin, không chặn).
 */
export async function runFreeConversation(
  chatId: string,
  turns: ReplayTurnInput[],
  deps: ReplayDeps,
): Promise<{
  firstDivergenceTurn: number | null;
  converged: boolean;
  tl1Questions: number;
  tl2Questions: number;
  tl1Turns: number;
  tl2Turns: number;
}> {
  const db = new Database(":memory:");
  const tracker = new IsolatedTracker();
  const { engine } = makeIsolatedEngine(db, deps, tracker);

  let firstDivergenceTurn: number | null = null;
  let tl1Questions = 0;
  let tl2Questions = 0;
  let tl1Created = false;
  let tl2Created = false;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const tl1Action = classifyTl1Reply(turn.tl1Reply);
    if (tl1Action === "ask_missing_field") tl1Questions++;
    if (tl1Action === "ticket_created") tl1Created = true;

    const out = await engine.step({
      chatId,
      message: turn.user,
      mediaPaths: turn.mediaPaths ?? [],
    });
    if (out.outcome === "asked") tl2Questions++;
    if (out.outcome === "created") tl2Created = true;

    const allowed = outcomesForLegacyAction(tl1Action);
    const matches =
      allowed.includes(out.outcome as StepOutcome) ||
      legacyActionForOutcome(out.outcome as StepOutcome) === tl1Action;

    if (!matches && firstDivergenceTurn === null) {
      firstDivergenceTurn = i + 1; // 1-based index
    }
  }

  return {
    firstDivergenceTurn,
    converged: tl1Created && tl2Created,
    tl1Questions,
    tl2Questions,
    tl1Turns: turns.length,
    tl2Turns: turns.length,
  };
}

/**
 * Tầng 3: Xác nhận nới lỏng cho bóng ("shadow-relaxed confirm").
 */
export async function evaluateRelaxedConfirm(
  chatId: string,
  turns: ReplayTurnInput[],
  deps: ReplayDeps,
): Promise<{
  relaxedCreated: boolean;
  tl2_stricter?: boolean;
  missingFields?: string[];
  payload?: {
    title: string;
    description: string;
    priority?: string;
  };
  tl1Summary?: Tl1Summary | null;
}> {
  // Tìm lượt TL1 tạo ticket
  const confirmTurnIndex = turns.findIndex(
    (t) => classifyTl1Reply(t.tl1Reply) === "ticket_created",
  );
  if (confirmTurnIndex === -1) {
    return { relaxedCreated: false };
  }

  const db = new Database(":memory:");
  const tracker = new IsolatedTracker();
  const clock = new ReplayClock();
  const { engine, drafts } = makeIsolatedEngine(db, { ...deps, clock }, tracker);

  // Chạy các lượt tới lúc người dùng xác nhận
  for (let i = 0; i < confirmTurnIndex; i++) {
    await engine.step({
      chatId,
      message: turns[i].user,
      mediaPaths: turns[i].mediaPaths ?? [],
    });
  }

  const draft = drafts.getLatestByChatId(chatId);
  if (!draft) return { relaxedCreated: false };

  // Nới lỏng: đồng hồ nhảy qua minConfirmDelayMs và tóm tắt coi như đã hiện
  clock.advance(MIN_CONFIRM_DELAY_MS + 1000);
  draft.status = "ready_for_confirmation";
  draft.summaryShownAt = new Date(clock.now() - MIN_CONFIRM_DELAY_MS - 500).toISOString();
  drafts.saveRevision(draft);

  // Đánh giá gate của TL2
  const catalog = deps.catalog ?? engineTestCatalog;
  const record = {
    variant: draft.record?.variant ?? "tech",
    values: draft.record?.values ?? {},
    questionCount: draft.record?.questionCount ?? {},
    explicitlyMissing: draft.record?.explicitlyMissing ?? [],
  };
  const gate = evaluateGate(catalog, record);

  const tl1Summary = readTl1Summary(turns[confirmTurnIndex - 1]?.tl1Reply);

  // Gate của TL2 đủ khi các trường bắt buộc đã được giải quyết hoàn toàn
  const isGateSufficient = gate.isComplete && gate.isFullyResolved;

  if (isGateSufficient) {
    // Gate đủ -> chạy tạo ticket và lấy payload
    await engine.step({
      chatId,
      message: turns[confirmTurnIndex].user,
      mediaPaths: turns[confirmTurnIndex].mediaPaths ?? [],
    });
    const created = tracker.created[0];
    return {
      relaxedCreated: true,
      payload: created
        ? {
            title: created.title,
            description: created.description,
            priority: created.priority,
          }
        : undefined,
      tl1Summary,
    };
  }

  // Gate chưa đủ -> không ép, ghi tl2_stricter
  return {
    relaxedCreated: false,
    tl2_stricter: true,
    missingFields: gate.missingRequired.length ? gate.missingRequired : gate.exhaustedFields,
    tl1Summary,
  };
}

export interface ShadowMetrics {
  totalPairs: number;
  m0: number; // Unsafe divergences (MUST BE 0)
  m1: number; // Action match rate (0..1)
  m2: {
    fieldMatchRate: number;
    rawTextCompleteRate: number;
  };
  m3: {
    jaccardAsked: number;
    extraQuestionRate: number;
    byChat?: Record<
      string,
      {
        jaccardAsked: number;
        extraQuestionRate: number;
        tl1Asked: string[];
        tl2Asked: string[];
        totalTl2Questions: number;
        extraTl2Questions: number;
      }
    >;
  };
  m4: number; // Branch decision match rate (park/split/merge)
  classes: {
    s0: number;
    s1: number;
    s2: number;
    matched: number;
  };
  actionBreakdown: Record<string, { total: number; matched: number; rate: number }>;
}

/**
 * Tính các chỉ số sẵn sàng M0 - M4 theo RFC 4.5.
 */
export function calculateMetrics(pairs: PairV2[]): ShadowMetrics {
  let m0 = 0;
  let s1 = 0;
  let s2 = 0;
  let matched = 0;

  const actionStats: Record<string, { total: number; matched: number }> = {};

  let confirmationTurns = 0;
  let confirmedFieldsMatched = 0;
  let rawTextCompleteCount = 0;

  let branchTurns = 0;
  let branchMatched = 0;

  // Lượt 1 cho M3: Gom trường được hỏi theo từng chatId
  const chatQuestions = new Map<
    string,
    {
      tl1Asked: Set<string>;
      tl2Asked: Set<string>;
      tl2Turns: Array<{ field?: string }>;
    }
  >();

  const getChatData = (chatId: string) => {
    let d = chatQuestions.get(chatId);
    if (!d) {
      d = { tl1Asked: new Set(), tl2Asked: new Set(), tl2Turns: [] };
      chatQuestions.set(chatId, d);
    }
    return d;
  };

  // Pass 1: Thu thập trường theo từng chatId và tính thống kê cơ bản
  for (const p of pairs) {
    const diffClass = p.diff?.class;
    if (diffClass === "S0") m0++;
    else if (diffClass === "S1") s1++;
    else if (diffClass === "S2") s2++;
    else matched++;

    const tl1Action = p.tl1.action ?? "unknown";
    if (!actionStats[tl1Action]) actionStats[tl1Action] = { total: 0, matched: 0 };
    actionStats[tl1Action].total++;

    // M1: Cùng lớp hành động (RFC 0002 §4.5)
    // - asked_other_field, ticket_field_mismatch, attachment_count_mismatch: cùng lớp action -> matched
    // - action_mismatch, branch_mismatch: khác lớp action -> không matched
    // - S0: không an toàn -> không matched
    const isActionMatch =
      diffClass !== "S0" &&
      p.diff?.code !== "action_mismatch" &&
      p.diff?.code !== "branch_mismatch";
    if (isActionMatch) {
      actionStats[tl1Action].matched++;
    }

    // M2: Xác nhận / tạo ticket
    if (tl1Action === "confirm_summary" || tl1Action === "ticket_created") {
      confirmationTurns++;
      if (
        p.diff?.code !== "ticket_field_mismatch" &&
        p.diff?.code !== "attachment_count_mismatch" &&
        p.diff?.class !== "S0"
      ) {
        confirmedFieldsMatched++;
      }
      if (p.diff?.code !== "rawtext_missing_words") {
        rawTextCompleteCount++;
      }
    }

    // M3 Pass 1: Thu thập trường hỏi theo chatId
    const cData = getChatData(p.chatId || "default");
    if (tl1Action === "ask_missing_field") {
      const f1 = p.diff?.tl1Field ?? extractAskedField(p.tl1.reply);
      if (f1) cData.tl1Asked.add(f1);
    }
    if (p.tl2.outcome === "asked") {
      const f2 =
        p.diff?.tl2Field ?? extractAskedField(p.tl2.reply) ?? extractAskedField(p.tl1.reply);
      if (f2) cData.tl2Asked.add(f2);
      cData.tl2Turns.push({ field: f2 });
    }

    // M4: Quyết định rẽ (park/split/merge)
    if (
      tl1Action === "ask_split_or_merge" ||
      tl1Action === "ask_new_or_continue" ||
      p.tl2.outcome === "split_question" ||
      p.tl2.outcome === "parked"
    ) {
      branchTurns++;
      if (p.diff?.code !== "branch_mismatch" && p.diff?.class !== "S0") {
        branchMatched++;
      }
    }
  }

  // Pass 2 cho M3: Tính Jaccard và tỉ lệ hỏi thừa trên từng cuộc hội thoại (chatId)
  const byChat: Record<
    string,
    {
      jaccardAsked: number;
      extraQuestionRate: number;
      tl1Asked: string[];
      tl2Asked: string[];
      totalTl2Questions: number;
      extraTl2Questions: number;
    }
  > = {};

  let sumJaccard = 0;
  let sumExtraRate = 0;
  const chatList = Array.from(chatQuestions.entries());

  for (const [chatId, data] of chatList) {
    const totalTl2 = data.tl2Turns.length;
    let extraTl2 = 0;
    for (const turn of data.tl2Turns) {
      if (turn.field && !data.tl1Asked.has(turn.field)) {
        extraTl2++;
      }
    }
    const extraRate = totalTl2 > 0 ? extraTl2 / totalTl2 : 0;

    const union = new Set([...data.tl1Asked, ...data.tl2Asked]);
    const intersection = new Set([...data.tl1Asked].filter((x) => data.tl2Asked.has(x)));
    const jaccard = union.size > 0 ? intersection.size / union.size : 1;

    byChat[chatId] = {
      jaccardAsked: jaccard,
      extraQuestionRate: extraRate,
      tl1Asked: Array.from(data.tl1Asked),
      tl2Asked: Array.from(data.tl2Asked),
      totalTl2Questions: totalTl2,
      extraTl2Questions: extraTl2,
    };

    sumJaccard += jaccard;
    sumExtraRate += extraRate;
  }

  const numChats = chatList.length;
  const jaccardAsked = numChats > 0 ? sumJaccard / numChats : 1;
  const extraQuestionRate = numChats > 0 ? sumExtraRate / numChats : 0;

  const total = pairs.length;
  const actionMatchedCount = Object.values(actionStats).reduce((sum, a) => sum + a.matched, 0);
  const m1 = total > 0 ? actionMatchedCount / total : 1;

  const m2FieldRate = confirmationTurns > 0 ? confirmedFieldsMatched / confirmationTurns : 1;
  const m2RawTextRate = confirmationTurns > 0 ? rawTextCompleteCount / confirmationTurns : 1;
  const m4Rate = branchTurns > 0 ? branchMatched / branchTurns : 1;

  const actionBreakdown: Record<string, { total: number; matched: number; rate: number }> = {};
  for (const [k, v] of Object.entries(actionStats)) {
    actionBreakdown[k] = {
      total: v.total,
      matched: v.matched,
      rate: v.total > 0 ? v.matched / v.total : 1,
    };
  }

  return {
    totalPairs: total,
    m0,
    m1: Math.max(0, Math.min(1, m1)),
    m2: {
      fieldMatchRate: m2FieldRate,
      rawTextCompleteRate: m2RawTextRate,
    },
    m3: {
      jaccardAsked,
      extraQuestionRate,
      byChat,
    },
    m4: m4Rate,
    classes: {
      s0: m0,
      s1,
      s2,
      matched,
    },
    actionBreakdown,
  };
}
