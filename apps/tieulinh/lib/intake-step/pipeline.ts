import type { ItsaplanClient, ItsaplanIssue, ProjectColumn } from "../itsaplan/client";
import { classifyColumn, type TicketState } from "../itsaplan/ticket-state";
import {
  closedTicketRefusalMessage,
  resolveSupplementMentionTarget,
  formatSupplementComment,
  notifyOnCallSupplement,
} from "../itsaplan/supplement-notifier";
import {
  findIssueByIdentifier,
  issueWebUrl,
  parseIdentifier,
  resolveLabelsForIssue,
  resolveProjectTeamRef,
} from "../itsaplan/project";
import { formatAttachmentMarkdown, uploadAttachments } from "../itsaplan/attachments";
import {
  buildAdviceComment,
  formatTicketDescription,
} from "../../mcp/tieulinh/domain/ticket-formatter";
import { VALID_SYSTEMS } from "../../mcp/tieulinh/domain/taxonomy";
import { markBotComment } from "@vuihoc/bot-core/core";
import { escapeItsaplanMarkdown } from "../html-entities";
import { fieldButtons, layoutButtons } from "../gate/buttons";
import {
  clearPendingButtons,
  getConfirmationButtons,
  savePendingButtons,
  toTelegramButtons,
} from "../telegram/buttons";
import { composeQuestion, evaluateGate } from "../gate/gate";
import { catalogFromValidationRules } from "../gate/from-validation-rules";
import type { InlineButton, IntakeRecord } from "../gate/types";
import type {
  ValidationRules,
  FieldRequirementsTable,
  ProductMappingConfig,
  UrgencyRules,
} from "../../mcp/shared/index";
import { inferProductKey } from "../../mcp/shared/tools/validate-fields";
import { evaluatePriorityRules } from "../../mcp/shared/tools/assess-priority";
import {
  attachMediaToIssue,
  bindIssueToChat,
  clearConfirmationState,
  withChatLock,
} from "../../mcp/shared/tools/create-issue";
import { INTAKE_DRAFT_TTL_MS, type IntakeDocumentRepository } from "../intake-document/repository";
import {
  CLOSED_STATUSES,
  type IntakeDocument,
  type PriorityLevel,
  type SimilarTicketItem,
} from "../intake-document/types";
import type { IntakePacket, IntakeNextAction } from "../intake-document/packet";
import type { TicketBindingRepository } from "../storage/binding-repository";
import type { DraftSessionRepository } from "../storage/session-repository";
import { type FieldExtractor, isChitchat, isDeclineAnswer } from "./extractor";
import type { ExtractedFields } from "./extractor-schema";
import { mergeExtractedFields } from "./merger";
import type { OnyxRestSearchClient } from "../onyx/rest-search";
import type { LlmConfig } from "../../worker/llm";
import type { SimilarTicketSource } from "../kg/similar-ticket-source";
import { stripChannelEnvelope, isInternalCallbackToken } from "@vuihoc/bot-core/core";
import { getLogger } from "@vuihoc/bot-core/core";
import { IDENTIFIER_FIELD_KEYS, identifiersConflict } from "../identifier-grounding";
import {
  extractLabelledIdentifiers,
  identityConflict,
  splitMultiIncidentReport,
  isInvalidTitle,
  deriveFallbackTitle,
  type IncidentBlock,
} from "./multi-incident";
import type { TechReviewer, TechReviewInput } from "./tech-review";
import {
  applyEditOps,
  classifyCancelOrCloseIntent,
  countSpecialistTimelineComments,
  descriptionBody,
  isCancelOrCloseTicketRequest,
  mentionedIdentifiers,
  MIN_SPECIALIST_COMMENTS_FOR_DONE,
  planEdit,
  stripSupplementCommandWrapper,
  type EditOp,
  type ReplyCandidate,
  type TicketCommand,
  type TicketCommandInterpreter,
} from "./ticket-reply-router";
import { stripCommentHtml } from "@vuihoc/bot-core/core";
import { isSystemActor } from "../kg/human-signals";

/** Đang tạo ticket (status "confirmed") quá chừng này mà chưa xong thì coi như kẹt, cho xác nhận lại. */
export const CONFIRM_STALE_MS = 2 * 60_000;
/**
 * Xác nhận tới sớm hơn ngưỡng này sau khi hiện tóm tắt thì không tính: người
 * thật cần đọc tóm tắt rồi mới bấm, còn model thì có thể tự "bấm" callbackData
 * ngay trong cùng lượt (đã xảy ra: gemini-flash-lite tự gửi "đúng rồi" sau 1,1s).
 */
export const MIN_CONFIRM_DELAY_MS = 5000;

const PRIORITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
/** "Trường" giả cho câu hỏi lý do xin gấp trong lastAskedFields / askedCount. */
const PRIORITY_REASON_FIELD = "priority_reason";
const PRIORITY_LABEL: Record<string, string> = {
  low: "Thấp",
  medium: "Trung bình",
  high: "Cao",
  urgent: "Khẩn cấp",
};
/** Phần triệu chứng đưa vào mô tả ticket tối đa chừng này ký tự. */
export const MAX_DESCRIPTION_SYMPTOMS_CHARS = 6000;
/** Nội dung bổ sung (comment) sau khi tạo ticket tối đa chừng này ký tự. */
export const MAX_FOLLOW_UP_CHARS = 4000;

const CONFIRM_LABEL = "✅ Đúng rồi, tạo ticket";
const UNKNOWN_SYSTEM = "Chưa xác định (đội Kỹ thuật sẽ phân loại)";
const UNKNOWN_DEPT = "Chưa xác định phòng ban";

/**
 * Nhãn 2 nút hỏi "sự cố mới hay bổ sung" (TECH-928) — cố định, không phải
 * danh sách từ khoá đoán ý định: pipeline chỉ so message tiếp theo với ĐÚNG
 * hai chuỗi này (như đã làm với `CONFIRM_LABEL`/"đúng rồi" từ trước tới giờ),
 * không suy luận ý người dùng từ câu chữ tự do.
 */
const NEW_INCIDENT_LABEL = "Sự cố mới";
/** Nút huỷ bản xem trước ghi vào ticket đã có. */
const CANCEL_ACTION_LABEL = "Huỷ";
/** Nút giữ lại ticket khi người báo đang xem trước thao tác Hủy / Đóng ticket (ADR-0006 cập nhật 10/10/2026). */
const KEEP_TICKET_LABEL = "Giữ lại";
const FORCE_NEW_FLAG = "force_new";
const FORCE_NEW_WINDOW_MS = 2 * 60 * 1000;
/** Ticket bot vừa tạo trong khoảng này còn chuyển được sang ticket khác ("cái này bổ sung cho TECH-Y"). */
const JUST_CREATED_WINDOW_MS = 24 * 3600 * 1000;
/** Kỹ thuật hỏi người báo trong khoảng này thì tin kế tiếp có thể là câu trả lời. */
const TECH_QUESTION_WINDOW_MS = 72 * 3600 * 1000;
const CONTINUE_DRAFT_LABEL = "Bổ sung sự cố đang chờ";

/**
 * Nhãn nút nhắc về tờ khai bị GÁC LẠI (`IntakeDocument.parkedDocId`) khi sự cố
 * mới vừa tạo xong ticket hoặc bị huỷ — khác `CONTINUE_DRAFT_LABEL` (dùng để
 * gộp tin xung đột vào tờ khai đang mở NGAY lượt đó). Nút này đưa tờ khai bị
 * gác lại trở thành tài liệu đang mở của chat sau khi sự cố mới đã xong việc.
 */
const RESUME_PARKED_LABEL = "Tiếp tục sự cố đang chờ";

/** Trạng thái tờ khai còn "mở" — chưa tạo ticket, chưa huỷ, chưa hết hạn. */
/** Tên "trường" giả cho câu hỏi dữ kiện kỹ thuật trong lastAskedFields / explicitlyMissing. */
const TECH_INFO_FIELD = "tech_info";
const OPEN_DRAFT_STATUSES = new Set<IntakeDocument["status"]>([
  "collecting",
  "ready_for_confirmation",
]);

/** Nơi đẩy nút bấm ra kênh chat. Mặc định là file nút chờ plugin OpenClaw đọc để đính vào tin Telegram. */
export interface PendingButtonsSink {
  save(chatId: string, rows: InlineButton[][]): void;
  clear(chatId: string): void;
}

export const telegramButtonsSink: PendingButtonsSink = {
  save: (chatId, rows) => savePendingButtons(chatId, toTelegramButtons(rows)),
  clear: (chatId) => clearPendingButtons(chatId),
};

export interface IntakePipelineOptions {
  repo: IntakeDocumentRepository;
  extractor: FieldExtractor;
  searchClient?: OnyxRestSearchClient;
  /**
   * Ticket tương tự từ Knowledge Graph (cụm nguyên nhân người xác định —
   * ADR-0007). Chỉ truyền khi có MEMGRAPH_URI. Tra một lần mỗi tài liệu, lúc tóm tắt.
   */
  similarTickets?: SimilarTicketSource;
  itsaplan: ItsaplanClient;
  projectKey: string;
  columnId?: number;
  validationRules: ValidationRules;
  fieldRequirements: FieldRequirementsTable;
  productMapping: ProductMappingConfig;
  urgencyRules: UrgencyRules;
  llmConfig?: LlmConfig;
  /** Đọc lệnh nhắm vào ticket ĐÃ CÓ (bổ sung/sửa/tra cứu/chuyển) — ADR-0008. */
  ticketCommands?: TicketCommandInterpreter;
  /** Lập thao tác sửa ticket (mặc định: planEdit qua llmConfig) — cho test. */
  editPlanner?: (input: {
    title: string;
    description: string;
    instruction: string;
  }) => Promise<EditOp[]>;
  /** Soát dữ kiện kỹ thuật cần trước khi xin xác nhận (hỏi người báo một lượt). */
  techReviewer?: TechReviewer;
  /** Base URL API Itsaplan — dựng link ảnh đính kèm. */
  itsaplanBaseUrl?: string;
  /** URL giao diện web Itsaplan — dựng link ticket trả người dùng. */
  webUrl?: string;
  /** Binding ticket↔chat để worker báo ngược Telegram. */
  bindingRepo?: TicketBindingRepository;
  /** Bản nháp của create_issue — dọn khi intake_step tạo xong. */
  draftRepo?: DraftSessionRepository;
  buttons?: PendingButtonsSink;
  draftTtlMs?: number;
  /** Mặc định MIN_CONFIRM_DELAY_MS — xem chú thích ở đó. */
  minConfirmDelayMs?: number;
  /** Ngưỡng số bình luận chuyên viên để cho phép người báo đóng ticket sang Done (mặc định MIN_SPECIALIST_COMMENTS_FOR_DONE = 3). */
  minSpecialistCommentsForDone?: number;
  notifier?: { broadcastAlert?: (text: string) => Promise<void> };
  now?: () => number;
}

export interface RunStepInput {
  chatId: string;
  message?: string;
  /** Đường dẫn ảnh/video người dùng vừa gửi (có thể không kèm chữ). */
  mediaPaths?: string[];
  reporter?: {
    name?: string;
    username?: string;
    nameCode?: string;
    telegramId?: string;
  };
  excludeIdentifier?: string;
}

/** Bậc ưu tiên trong bảng luật ("Low"/"Medium"/…) khớp không phân biệt hoa thường. */
export function toRuleLevel(levels: string[], level?: string): string {
  const wanted = (level ?? "").toLowerCase();
  return (
    levels.find((l) => l.toLowerCase() === wanted) ??
    levels.find((l) => l.toLowerCase() === "medium") ??
    levels[0]
  );
}

/** Bậc ưu tiên chữ thường như Itsaplan client và IntakeDocument dùng. */
export function toPriorityLevel(level?: string): PriorityLevel {
  const l = (level ?? "").toLowerCase();
  return (["urgent", "high", "medium", "low"] as const).find((x) => x === l) ?? "medium";
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function confirmationRows(): InlineButton[][] {
  return getConfirmationButtons(CONFIRM_LABEL).map((row) =>
    row.map((b) => ({ text: b.text, callbackData: b.callback_data })),
  );
}

type PendingTicketAction = NonNullable<IntakeDocument["pendingTicketAction"]>;

function confirmLabel(p: PendingTicketAction): string {
  if (p.kind === "edit") return `✅ Sửa ${p.identifier}`;
  if (p.kind === "move") return `✅ Chuyển sang ${p.identifier}`;
  if (p.kind === "cancel_ticket") return `✅ Hủy ${p.identifier}`;
  if (p.kind === "close_ticket") return `✅ Đóng ${p.identifier}`;
  return `✅ Bổ sung vào ${p.identifier}`;
}

/** Nút cho bản xem trước: xác nhận + ("Sự cố mới" nếu là gợi ý | "Giữ lại" nếu hủy/đóng ticket | "Huỷ"). */
function ticketActionRows(p: PendingTicketAction): InlineButton[][] {
  const second =
    p.kind === "suggest"
      ? NEW_INCIDENT_LABEL
      : p.kind === "cancel_ticket" || p.kind === "close_ticket"
        ? KEEP_TICKET_LABEL
        : CANCEL_ACTION_LABEL;
  const alternatives = (p.alternatives ?? []).map((a) => {
    const text = confirmLabel({ ...p, identifier: a.identifier });
    return { text, callbackData: text };
  });
  return layoutButtons([
    { text: confirmLabel(p), callbackData: confirmLabel(p) },
    ...alternatives,
    { text: second, callbackData: second },
  ]);
}

/** So nhãn nút không phụ thuộc emoji/khoảng trắng/hoa thường (model có thể bỏ emoji). */
function normalizeButtonText(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Bỏ markdown/mention thừa khi trích comment kỹ thuật cho người báo đọc. */
function stripMarkdownNoise(s: string): string {
  return stripCommentHtml(s)
    .replace(/@\w+/g, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "telegram:123" và "123" — message_routes/bindings ghi lẫn hai dạng. */
function chatIdVariants(chatId: string): string[] {
  const bare = String(chatId).replace(/^telegram:/i, "");
  return [bare, `telegram:${bare}`, String(chatId)];
}

function isCancelLike(lower: string): boolean {
  return /^(?:huỷ|hủy|thôi|bỏ qua|không cần|không gửi|không ghi)(?:\s|$|[.,!])/u.test(lower.trim());
}

/**
 * Người báo GÕ CHỮ thay vì bấm nút "Sự cố mới" (TECH-1013, 30/09: gõ "ticket mới ạ", tin bị
 * ghi tiếp vào ticket cũ). Chỉ dùng ở nơi lỡ hiểu sai còn an toàn: khi đang chờ người báo chọn,
 * hoặc ngay sau khi ticket vừa tạo — hiểu nhầm thành "sự cố mới" chỉ tốn thêm một ticket.
 */
const NEW_INCIDENT_SAID =
  /(?<![\p{L}\p{N}])(?:(?:ticket|sự cố|lỗi|yêu cầu|vấn đề|việc|báo)\s+(?:mới|khác)|tạo\s+(?:(?:ticket|sự cố)\s+)?mới|không phải\s+(?:là\s+)?(?:thông tin\s+)?bổ sung|(?:phụ huynh|học sinh|khách hàng|khách|hs|ph)\s+khác)(?![\p{L}\p{N}])/iu;

function saysNewIncident(text: string): boolean {
  return NEW_INCIDENT_SAID.test(text);
}

/** Bỏ cụm "ticket mới ạ" để biết người báo còn nói thêm nội dung sự cố hay không. */
function stripNewIncidentDeclaration(text: string): string {
  return text
    .replace(new RegExp(NEW_INCIDENT_SAID.source, "giu"), " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Tin gõ tay kèm chữ "sự cố mới": nếu còn nội dung thì nối vào tin đang chờ, còn không thì bỏ. */
function withTypedDetail(buffered: string, typed: string): string {
  return stripNewIncidentDeclaration(typed).length >= 12 ? `${buffered}\n${typed}` : buffered;
}

function newOrContinueRows(): InlineButton[][] {
  return layoutButtons([
    { text: NEW_INCIDENT_LABEL, callbackData: NEW_INCIDENT_LABEL },
    { text: CONTINUE_DRAFT_LABEL, callbackData: CONTINUE_DRAFT_LABEL },
  ]);
}

/** Một nút nhắc tiếp tục tờ khai bị gác lại — xem RESUME_PARKED_LABEL. */
function resumeParkedRows(): InlineButton[][] {
  return layoutButtons([{ text: RESUME_PARKED_LABEL, callbackData: RESUME_PARKED_LABEL }]);
}

/** Trích xuất RỖNG — không trường mới, không đổi ý định — dùng để tái dùng
 * `collect()` (gate/tóm tắt) mà không gọi LLM và không đụng tới dữ liệu đã có. */
function noopExtracted(): ExtractedFields {
  return { userIntent: "provide_info", symptoms: [] };
}

function hasDescription(doc: IntakeDocument): boolean {
  const title = doc.fields.title?.value;
  const rawText = doc.fields.rawText?.value;
  const symptoms = (doc.fields.symptoms?.value ?? []).filter((s) => !isInternalCallbackToken(s));
  const hasTitle = Boolean(title && !isInternalCallbackToken(title));
  const hasRaw = Boolean(rawText && !isInternalCallbackToken(rawText));
  return hasTitle || symptoms.length > 0 || hasRaw;
}

export class IntakeStepPipeline {
  private readonly catalog: ReturnType<typeof catalogFromValidationRules>;
  /** Promise của các việc nền (tra ticket tương tự) đang chạy — xem flushBackgroundForTests(). */
  private readonly pendingBackground: Promise<unknown>[] = [];

  constructor(private readonly options: IntakePipelineOptions) {
    this.catalog = catalogFromValidationRules(
      options.validationRules,
      options.fieldRequirements,
      options.productMapping,
    );
  }

  private get repo(): IntakeDocumentRepository {
    return this.options.repo;
  }

  private get buttons(): PendingButtonsSink {
    return this.options.buttons ?? telegramButtonsSink;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Một lượt hội thoại. Tuần tự theo chat (cùng khoá với create_issue) nên hai
   * cú bấm xác nhận đến cùng lúc không thể cùng tạo ticket.
   */
  async run(input: RunStepInput): Promise<IntakePacket> {
    // Phong bì kênh OpenClaw (chat_id, username, lịch sử hội thoại) không bao giờ vào tờ khai.
    if (typeof input.message === "string")
      input = { ...input, message: stripChannelEnvelope(input.message) };
    return withChatLock(input.chatId, async () => {
      const packet = await this.step(input);
      // Nút chỉ tới được Telegram qua file nút chờ — trả trong JSON thôi thì không ai vẽ.
      try {
        if (packet.buttons && packet.buttons.length > 0)
          this.buttons.save(input.chatId, packet.buttons);
        else this.buttons.clear(input.chatId);
      } catch {
        // Lỗi ghi nút không được làm hỏng câu trả lời
      }
      return packet;
    });
  }

  private async step(input: RunStepInput): Promise<IntakePacket> {
    const { chatId } = input;
    const now = this.now();
    const message = (input.message ?? "").trim();
    const media = Array.from(
      new Set((input.mediaPaths ?? []).map((p) => String(p).trim()).filter(Boolean)),
    );

    let doc = this.repo.getLatestByChatId(chatId);
    const hadAnyDoc = doc !== null;

    // Bấm nút "Tiếp tục sự cố đang chờ" — nhắc ở ticket_created/canceled của sự
    // cố vừa xong (xem appendParkedReminder). Đưa tờ khai bị gác lại (C) trở
    // thành tài liệu đang mở, KHÔNG đi qua trích xuất/gộp bình thường (tin này
    // là nhãn nút, không phải nội dung sự cố).
    if (
      doc &&
      doc.parkedDocId &&
      CLOSED_STATUSES.has(doc.status) &&
      message.toLowerCase().includes(RESUME_PARKED_LABEL.toLowerCase())
    ) {
      const resumed = await this.resumeParkedDraft(input, doc.parkedDocId);
      if (resumed) return resumed;
    }

    // Đang có một lượt khác tạo ticket (tiến trình khác, hoặc kẹt)
    if (doc && doc.status === "confirmed") {
      const since = Date.parse(doc.confirmingSince ?? doc.updatedAt);
      if (!Number.isNaN(since) && now - since < CONFIRM_STALE_MS) {
        return this.packet(
          doc,
          "in_progress",
          "Dạ em đang tạo ticket cho anh/chị, anh/chị chờ em một chút nhé ạ.",
        );
      }
      doc = { ...doc, status: "ready_for_confirmation", confirmingSince: undefined };
    }

    // Tài liệu im lặng quá lâu: đóng lại, tin này mở việc mới
    if (doc && this.isExpired(doc, now)) {
      if (!CLOSED_STATUSES.has(doc.status)) {
        this.repo.saveRevision({
          ...doc,
          revision: doc.revision + 1,
          status: "expired",
          updatedAt: new Date(now).toISOString(),
        });
      }
      doc = null;
    }

    // TECH-1148: Tin nhắn chỉ là token nội bộ (như "noop" của nút đã khoá) hoặc
    // rỗng và không kèm ảnh/video: bỏ qua hoàn toàn, không tạo tờ khai, không
    // tạo ticket, không làm hỏng trạng thái hiện tại.
    const isMeaninglessInput = (!message || isInternalCallbackToken(message)) && media.length === 0;
    if (isMeaninglessInput) {
      // P1 (Vòng 3): tin rỗng / token nội bộ ("noop") tới khi ĐANG Ở CÂU HỎI TÁCH không được
      // làm mất báo cáo đã park — hỏi lại đúng một lần, vẫn không rõ thì gộp 1 ticket giữ trọn
      // nội dung (trước đây rơi xuống nhánh hỏi mô tả, báo cáo vẫn còn nhưng người báo bị lạc).
      if (doc?.pendingSplit) {
        return this.handleUnclearSplitReply(doc, input, message, media, doc.pendingSplit);
      }
      if (doc && doc.status === "created" && doc.issueId) {
        const identifier = doc.issueIdentifier || `TECH-${doc.issueId}`;
        return this.packet(
          doc,
          "already_created",
          `Dạ ticket ${identifier} em đã tạo rồi ạ, anh/chị không cần xác nhận lại nhé.`,
          { issue: this.issueOf(doc) },
        );
      }
      if (doc && doc.status === "confirmed") {
        return this.packet(
          doc,
          "in_progress",
          "Dạ em đang tạo ticket cho anh/chị, anh/chị chờ em một chút nhé ạ.",
        );
      }
      if (doc && doc.status === "ready_for_confirmation") {
        return this.packet(
          doc,
          "awaiting_user_confirmation",
          "Dạ em đang chờ anh/chị bấm nút xác nhận ở tin tóm tắt phía trên ạ.",
          { buttons: confirmationRows() },
        );
      }
      if (doc && doc.status === "collecting") {
        if (hasDescription(doc)) {
          const missing = doc.lastAskedFields || [];
          const question = doc.lastAskedFields?.length
            ? `Anh/chị bổ sung giúp em thông tin còn thiếu nhé ạ.`
            : `Anh/chị mô tả thêm thông tin sự cố giúp em nhé ạ.`;
          return this.packet(doc, "ask_missing_field", question, { missingFields: missing });
        }
        return this.packet(
          doc,
          "clarify_intent",
          "Dạ em chào anh/chị! Anh/chị đang gặp sự cố gì, mô tả giúp em nhé ạ.",
        );
      }
      if (doc && doc.status === "canceled") {
        return this.packet(
          doc,
          "canceled",
          "Dạ vâng ạ. Khi nào cần báo sự cố anh/chị cứ nhắn em nhé!",
        );
      }
      const fresh = this.freshDoc(chatId, now);
      return this.packet(
        fresh,
        "clarify_intent",
        "Dạ em chào anh/chị! Anh/chị đang gặp sự cố gì, mô tả giúp em nhé ạ.",
      );
    }

    // "/new …" (plugin đặt cờ vì OpenClaw nuốt chữ "/new"): ép mở sự cố mới, tờ khai đang
    // dở được gác lại để nhắc sau — ADR-0008.
    const forceNew =
      this.options.bindingRepo?.consumeChatFlag(
        chatIdVariants(chatId),
        FORCE_NEW_FLAG,
        now - FORCE_NEW_WINDOW_MS,
      ) === true;
    if (forceNew) {
      const fresh = this.freshDoc(chatId, now);
      if (doc && !CLOSED_STATUSES.has(doc.status) && hasDescription(doc))
        fresh.parkedDocId = doc.docId;
      getLogger().info(
        `[pipeline] Chat ${chatId}: "/new" — mở sự cố mới${fresh.parkedDocId ? `, gác tờ khai ${fresh.parkedDocId}` : ""}.`,
      );
      if (!message && media.length === 0) {
        this.repo.saveRevision(fresh);
        return this.packet(fresh, "clarify_intent", "Dạ anh/chị mô tả sự cố mới giúp em nhé ạ.");
      }
      return this.collect(fresh, input, message, media);
    }

    // Lệnh nhắm vào ticket ĐÃ CÓ (bổ sung/sửa/tra cứu/chuyển, trả lời kỹ thuật) — ADR-0008.
    if (doc?.pendingTicketAction) {
      return this.resolvePendingTicketAction(doc, input, message, media);
    }
    const routed = await this.routeToExistingTicket(doc, input, message, media);
    if (routed) return routed;

    let preExtracted: ExtractedFields | undefined;

    // Tài liệu đã tạo ticket là tài liệu ĐÓNG. Tin sau chỉ được: bổ sung vào
    // ticket (comment, không ghi đè mô tả), hoặc mở sự cố mới, hoặc là lời
    // cảm ơn / bấm lại nút — không đụng gì tới ticket.
    if (doc && doc.status === "created" && doc.issueId) {
      const identifier = doc.issueIdentifier || `TECH-${doc.issueId}`;
      // Đang chờ người báo chọn "sự cố mới" hay "bổ sung vào ticket vừa tạo".
      if (doc.pendingNewIncident) {
        const buffered = doc.pendingNewIncident;
        const bufferedMedia = Array.from(new Set([...buffered.mediaPaths, ...media]));
        const reply = message.toLowerCase();
        const cleared: IntakeDocument = {
          ...doc,
          revision: doc.revision + 1,
          pendingNewIncident: undefined,
        };
        if (reply.includes(NEW_INCIDENT_LABEL.toLowerCase()) || saysNewIncident(reply)) {
          this.repo.saveRevision(cleared);
          const bufferedMessage = isInternalCallbackToken(buffered.message) ? "" : buffered.message;
          const fresh = this.freshDoc(doc.chatId, this.now());
          if (!bufferedMessage && bufferedMedia.length === 0) {
            return this.packet(
              fresh,
              "clarify_intent",
              "Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ.",
            );
          }
          return this.collect(
            fresh,
            input,
            withTypedDetail(bufferedMessage, message),
            bufferedMedia,
          );
        }
        if (reply.includes(CONTINUE_DRAFT_LABEL.toLowerCase())) {
          this.repo.saveRevision(cleared);
          const again = await this.options.extractor.extract(
            buffered.message,
            this.contextOf(doc),
            {
              createdTicket: { identifier, title: doc.fields.title?.value },
            },
          );
          return this.appendFollowUp(cleared, again, buffered.message, bufferedMedia);
        }
        return this.packet(
          doc,
          "ask_new_or_continue",
          `Dạ anh/chị bấm giúp em nút "${NEW_INCIDENT_LABEL}" hay "${CONTINUE_DRAFT_LABEL}" phía trên nhé ạ.`,
          {
            buttons: newOrContinueRows(),
          },
        );
      }
      // Người báo tuyên bố "ticket mới ạ" / "phụ huynh khác": mở sự cố mới, không đụng ticket cũ.
      if (message && saysNewIncident(message)) {
        const fresh = this.freshDoc(doc.chatId, this.now());
        if (stripNewIncidentDeclaration(message).length < 12 && media.length === 0) {
          this.repo.saveRevision(fresh);
          return this.packet(
            fresh,
            "clarify_intent",
            "Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ.",
          );
        }
        return this.collect(fresh, input, message, media);
      }
      const extracted = await this.options.extractor.extract(message, this.contextOf(doc), {
        createdTicket: { identifier, title: doc.fields.title?.value },
      });
      // W29-NOTIFY (06/10/2026): Ticket đã đóng thì không cho bổ sung vào nữa (team Kỹ thuật: "ticket đã đóng thì thôi k cho làm gì vào nữa, bên báo lỗi phải tự chủ động tạo ticket mới")
      const currentCreatedIssue = await this.options.itsaplan
        .getIssue(doc.issueId)
        .catch(() => null);
      if (currentCreatedIssue) {
        const columns = await this.options.itsaplan
          .listProjectColumns(this.options.projectKey)
          .catch(() => []);
        const currentState = this.resolveIssueState(currentCreatedIssue, columns);
        if (currentState === "done" || currentState === "canceled") {
          const statusLabel = currentState === "done" ? "Hoàn tất (Done)" : "Đã hủy (Canceled)";
          if (extracted.userIntent === "report_issue" && message) {
            return this.collect(
              this.freshDoc(doc.chatId, this.now()),
              input,
              message,
              media,
              extracted,
            );
          }
          return this.packet(
            doc,
            "post_create_update",
            closedTicketRefusalMessage(identifier, statusLabel),
            { issue: this.issueOf(doc) },
          );
        }
      }
      // Tin mang định danh KHÁC ticket vừa tạo (SĐT/mã HS/mã đơn…) thì rất có thể là
      // sự cố khác — không để LLM đoán "bổ sung" rồi ghi nhầm vào ticket cũ (test E2E
      // 28/09: sự cố 90000005 bị ghi thành bổ sung của TECH-956, mã 9100001, đã Done).
      const conflictField = IDENTIFIER_FIELD_KEYS.find((key) => {
        const existing = doc!.fields[key]?.value;
        const incoming = extracted[key];
        return (
          typeof existing === "string" &&
          typeof incoming === "string" &&
          identifiersConflict(existing, incoming)
        );
      });
      if (conflictField && message && extracted.userIntent !== "report_issue") {
        getLogger().info(
          `[pipeline] ${identifier}: tin mới có "${conflictField}" khác ticket đã tạo — xin bấm nút xác nhận, không tự ghi.`,
        );
        return this.askAboutCreatedTicket(
          doc,
          input,
          message,
          media,
          `Dạ tin này có thông tin (SĐT/mã) khác với ${identifier}`,
        );
      }
      if (extracted.userIntent === "report_issue" && message) {
        doc = null;
        preExtracted = extracted;
      } else if (extracted.userIntent === "provide_info" || media.length > 0) {
        // ADR-0008: mọi lần ghi vào Itsaplan đều qua bản xem trước + nút bấm, kể cả khi bot chắc là "bổ sung".
        // TECH-1013 (30/09): sự cố iPad của phụ huynh khác bị ghi thẳng vào ticket vừa tạo (tin có ảnh /
        // LLM đoán "bổ sung"), rồi "ticket mới ạ" ghi tiếp.
        getLogger().info(
          `[pipeline] ${identifier}: tin sau khi tạo (${extracted.userIntent}) — xin bấm nút xác nhận, không tự ghi.`,
        );
        return this.askAboutCreatedTicket(
          doc,
          input,
          message,
          media,
          `Dạ tin này là bổ sung cho ${identifier}`,
        );
      } else {
        const voice =
          extracted.userIntent === "chitchat"
            ? `Dạ không có gì ạ! Ticket ${identifier} đang được đội Kỹ thuật tiếp nhận, có cập nhật em sẽ báo anh/chị ngay nhé.`
            : extracted.userIntent === "cancel"
              ? `Dạ nếu anh/chị muốn hủy hoặc đóng ticket ${identifier}, anh/chị nhắn rõ giúp em "hủy ${identifier}" (kèm lý do nếu có) để em xác nhận chuyển trạng thái nhé ạ.`
              : `Dạ ticket ${identifier} em đã tạo rồi ạ, anh/chị không cần xác nhận lại nhé.`;
        return this.packet(doc, "already_created", voice, { issue: this.issueOf(doc) });
      }
    }

    if (!doc || CLOSED_STATUSES.has(doc.status)) {
      // Bản nháp create_issue kiểu cũ chỉ hồi sinh cho chat CHƯA từng có tờ khai —
      // không thì mỗi lần huỷ xong nó lại sống dậy.
      const migrated = hadAnyDoc
        ? null
        : this.repo.migrateFromLegacyDraft(chatId, { maxAgeMs: this.ttl() });
      doc = migrated ?? this.freshDoc(chatId, now);
    }

    return this.collect(doc, input, message, media, preExtracted);
  }

  /**
   * Lượt gom thông tin trên một tài liệu đang mở.
   *
   * @param skipConflictCheck Bỏ qua chốt "sự cố mới hay bổ sung" cho ĐÚNG lượt
   * này — dùng khi người dùng đã trả lời rõ "bổ sung" ở `resolvePendingNewIncident`,
   * nên tin nhắn park lại được phát lại qua đây để merge bình thường.
   */
  private async collect(
    doc: IntakeDocument,
    input: RunStepInput,
    message: string,
    media: string[],
    preExtracted?: ExtractedFields,
    skipConflictCheck = false,
  ): Promise<IntakePacket> {
    const prevStatus = doc.status;
    if (input.reporter) {
      const r = Object.fromEntries(
        Object.entries(input.reporter).filter(([, v]) => v !== undefined && v !== ""),
      );
      doc = { ...doc, reporter: { ...doc.reporter, ...r } };
    }

    // Tờ khai đang chờ người dùng chọn "Tách ticket" hay "Gộp 1 ticket" (W29-SPLIT)
    if (doc.pendingSplit) {
      return this.resolvePendingSplit(doc, input, message, media);
    }

    // Tờ khai đang chờ người dùng chọn "sự cố mới" hay "bổ sung" (TECH-928) —
    // tin nhắn NÀY là câu trả lời cho câu hỏi đó, không phải nội dung sự cố.
    if (doc.pendingNewIncident) {
      return this.resolvePendingNewIncident(doc, input, message, media);
    }

    const nextTurn = doc.currentTurn + 1;

    const extracted =
      preExtracted ?? (await this.options.extractor.extract(message, this.contextOf(doc)));
    const intent = extracted.userIntent;
    const declined = isDeclineAnswer(message);
    // Nhận diện báo cáo có nhiều học sinh/sự cố trong cùng một tin nhắn (W29-SPLIT, TECH-1146)
    if (!skipConflictCheck && (!doc.fields.rawText?.value || doc.currentTurn === 0)) {
      const splitBlocks = splitMultiIncidentReport(message);
      if (splitBlocks && splitBlocks.length >= 2) {
        getLogger().info(
          `[pipeline] Phát hiện báo cáo có ${splitBlocks.length} sự cố/học sinh trong cùng 1 tin nhắn — hỏi tách ticket.`,
        );
        return this.parkForSplitDecision(doc, splitBlocks, media);
      }
    }

    // Huỷ tường minh
    if (intent === "cancel" && media.length === 0) {
      if (doc.revision === 0) {
        return this.appendParkedReminder(
          this.packet(doc, "canceled", "Dạ vâng ạ. Khi nào cần báo sự cố anh/chị cứ nhắn em nhé!"),
          doc,
        );
      }
      const canceled: IntakeDocument = {
        ...doc,
        revision: doc.revision + 1,
        currentTurn: nextTurn,
        status: "canceled",
        // Bug 7: huỷ thì phải xoá luôn hàng đợi tách & câu hỏi tách đang treo,
        // không để khối còn lại mồ côi trong DB.
        pendingSplit: undefined,
        pendingSplitQueue: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(canceled);
      clearConfirmationState(doc.chatId, this.options.draftRepo, (id) =>
        this.buttons.clear(String(id)),
      );
      return this.appendParkedReminder(
        this.packet(
          canceled,
          "canceled",
          "Dạ vâng, em đã hủy yêu cầu ghi nhận sự cố này rồi ạ. Khi nào cần hỗ trợ anh/chị cứ nhắn em nhé!",
        ),
        canceled,
      );
    }

    // Vừa hỏi dữ kiện kỹ thuật hoặc mô tả sự cố thì tin này là câu trả lời, dù nó đọc như một lời báo đầy đủ.
    const answeringTechQuestion = doc.lastAskedFields?.includes(TECH_INFO_FIELD) === true;
    const answeringDescription = doc.lastAskedFields?.includes("short_description") === true;
    // Tin nhắn mới mang định danh (SĐT/mã học sinh/mã đơn...) XUNG ĐỘT với
    // định danh đã có trong tờ khai đang mở — rất có thể là MỘT SỰ CỐ KHÁC,
    // không phải bổ sung. mergeExtractedFields ghi đè trường không phân biệt
    // sự cố (setField không biết giá trị cũ), nên phải chặn TRƯỚC khi gọi nó,
    // dùng đúng `doc.fields` (trước gộp) so với `extracted` (tin mới) — xem
    // TECH-928 (đo lại 28/09/2026): sự cố B (SĐT 0900000004) gộp lặng lẽ vào
    // tờ khai sự cố A (SĐT 0900000003) đang chờ xác nhận, B mất trắng.
    if (!skipConflictCheck) {
      // Vòng 2: xung đột CHỈ tính từ định danh CÓ NHÃN (Code:, Mã KH:, Mã HS:,
      // UID/SID/CID:, hoặc mã CRM 7-10 số nằm trọn một dòng) — và chỉ khi tờ khai
      // đang mở ĐÃ CÓ giá trị CÙNG LỚP. Tên người không bao giờ tạo xung đột
      // (Bug 3), SĐT/TK/MK/URL/mã phiếu thu không bao giờ là định danh (Bug 4).
      const existingIds = extractLabelledIdentifiers(doc.fields.rawText?.value, {
        allowBarePhone: true,
      });
      const incomingIds = extractLabelledIdentifiers(message);
      const conflictClass = identityConflict(existingIds, incomingIds);
      if (conflictClass) {
        getLogger().info(
          `[pipeline] Tờ khai ${doc.docId}: tin nhắn mới có định danh "${conflictClass}" xung đột cùng lớp với tờ khai đang mở (giá trị không ghi vào log để tránh lộ SĐT) — hỏi sự cố mới hay bổ sung thay vì gộp lặng lẽ.`,
        );
        return this.parkForNewIncidentDecision(doc, message, media);
      }

      // Tờ khai dở dang (đã có tiêu đề, đang hỏi trường thiếu hoặc chờ xác nhận) mà tin mới
      // là MỘT LỜI BÁO SỰ CỐ trọn vẹn (LLM xếp report_issue) — cũng hỏi, kể cả khi tờ khai
      // cũ chưa có định danh để so (test E2E 28/09: sự cố 9100001 gộp vào tờ khai "bài tập"
      // đang hỏi bộ phận → tóm tắt mang tiêu đề của sự cố kia).
      const draftInProgress =
        Boolean(doc.fields.title?.value) &&
        (Boolean(doc.lastAskedFields?.length) || doc.status === "ready_for_confirmation");
      if (
        draftInProgress &&
        !answeringTechQuestion &&
        !answeringDescription &&
        extracted.userIntent === "report_issue" &&
        message
      ) {
        getLogger().info(
          `[pipeline] Tờ khai ${doc.docId}: tin mới là lời báo sự cố trọn vẹn khi tờ khai đang dở — hỏi sự cố mới hay bổ sung.`,
        );
        return this.parkForNewIncidentDecision(doc, message, media);
      }
    }

    const symptomsBefore = JSON.stringify(doc.fields.symptoms?.value ?? []);
    doc = mergeExtractedFields(doc, extracted, nextTurn, message, {
      structuredOnly: intent === "confirm" || intent === "chitchat" || declined,
      // Câu trả lời cho câu hỏi dữ kiện kỹ thuật luôn vào mô tả, kể cả khi chỉ là "DH900002".
      appendRawText: answeringTechQuestion && !declined,
    });
    // Ghi nhớ bộ phận ngoài danh mục để câu hỏi sau nói rõ, hết dùng thì xoá.
    if (extracted.reportingDeptUnrecognized)
      doc.unrecognizedDept = extracted.reportingDeptUnrecognized;
    else if (doc.fields.reportingDept?.value) doc.unrecognizedDept = undefined;
    doc.updatedAt = new Date(this.now()).toISOString();
    if (media.length > 0) {
      doc.fields.mediaPaths = {
        value: Array.from(new Set([...(doc.fields.mediaPaths?.value ?? []), ...media])),
        source: "user_message",
        turn: nextTurn,
        updatedAt: doc.updatedAt,
      };
    }
    if (declined && doc.lastAskedFields?.length) {
      doc.explicitlyMissing = Array.from(
        new Set([...(doc.explicitlyMissing ?? []), ...doc.lastAskedFields]),
      );
    }

    // Chưa có mô tả sự cố nào
    if (!hasDescription(doc)) {
      const hasAnything = media.length > 0 || Object.keys(doc.fields).length > 0;
      if (!hasAnything) {
        return this.packet(
          doc,
          "clarify_intent",
          "Dạ em chào anh/chị! Anh/chị đang gặp sự cố gì, mô tả giúp em nhé ạ.",
        );
      }
      doc.status = "collecting";
      doc.lastAskedFields = ["short_description"];
      this.repo.saveRevision(doc);
      const got = media.length > 0 ? "ảnh anh/chị gửi" : "thông tin";
      return this.packet(
        doc,
        "ask_missing_field",
        `Dạ em đã nhận ${got} rồi ạ. Anh/chị mô tả giúp em sự cố đang gặp (lỗi gì, ở màn hình/chức năng nào) nhé.`,
        { missingFields: ["short_description"] },
      );
    }

    // Đối soát cổng chất lượng (Deterministic Gate)
    const values = this.gateValues(doc);
    const variantKey = this.variantOf(values);
    const record: IntakeRecord = {
      variant: variantKey,
      values,
      questionCount: doc.askedCount,
      explicitlyMissing: doc.explicitlyMissing ?? [],
    };
    const gate = evaluateGate(this.catalog, record);

    // Mức ưu tiên — bảng luật dùng "Low"/"Medium"/…, tài liệu và Itsaplan dùng chữ thường
    const rules = this.options.urgencyRules;
    const prio = evaluatePriorityRules(rules, toRuleLevel(rules.levels, "medium"), {
      ...doc.evidence,
    });
    // Người báo xin gấp: có lý do thì cho đúng mức xin (không hạ mức bằng chứng đã cao hơn).
    if (extracted.requestedPriority) {
      doc.requestedPriority = {
        level: extracted.requestedPriority,
        reason: extracted.requestedPriorityReason || doc.requestedPriority?.reason,
      };
    } else if (doc.requestedPriority && extracted.requestedPriorityReason) {
      doc.requestedPriority = {
        ...doc.requestedPriority,
        reason: extracted.requestedPriorityReason,
      };
    } else if (
      doc.requestedPriority &&
      !doc.requestedPriority.reason &&
      doc.lastAskedFields?.includes(PRIORITY_REASON_FIELD) &&
      message &&
      !declined
    ) {
      // Vừa hỏi lý do gấp: cả câu trả lời là lý do.
      doc.requestedPriority = { ...doc.requestedPriority, reason: capText(message, 300) };
    }
    const evidenceLevel = toPriorityLevel(prio.allowedLevel);
    const granted = doc.requestedPriority?.reason ? doc.requestedPriority.level : undefined;
    doc.fields.priority = {
      value:
        granted && PRIORITY_ORDER[granted] > PRIORITY_ORDER[evidenceLevel]
          ? granted
          : evidenceLevel,
      source: granted ? "user_message" : "system_inferred",
      turn: nextTurn,
      updatedAt: doc.updatedAt,
    };

    // Tra ticket tương tự (Onyx) chỉ khi triệu chứng đổi
    const symptomsChanged = JSON.stringify(doc.fields.symptoms?.value ?? []) !== symptomsBefore;
    const symptomsText = this.symptomsText(doc);
    if (this.options.searchClient && symptomsChanged && symptomsText.length >= 10) {
      try {
        doc.similarTickets = await this.options.searchClient.searchSimilar(
          symptomsText,
          doc.fields.system?.value,
          input.excludeIdentifier || doc.issueIdentifier,
        );
      } catch {
        // Tra cứu Onyx lỗi không chặn luồng chính
      }
    }

    // Kịch bản A: xác nhận — CHỈ khi người dùng đã thấy bản tóm tắt
    if (intent === "confirm" && prevStatus === "ready_for_confirmation" && gate.isComplete) {
      const shownAt = doc.summaryShownAt ? Date.parse(doc.summaryShownAt) : NaN;
      const minDelay = this.options.minConfirmDelayMs ?? MIN_CONFIRM_DELAY_MS;
      if (!Number.isNaN(shownAt) && this.now() - shownAt < minDelay) {
        // Không lưu revision: tài liệu giữ nguyên trạng thái chờ người dùng bấm.
        return this.packet(
          doc,
          "awaiting_user_confirmation",
          "Anh/chị xem lại bản tóm tắt phía trên, đúng thì bấm nút xác nhận giúp em nhé ạ.",
          { buttons: confirmationRows() },
        );
      }
      return this.createTicket(doc, input);
    }

    // Người dùng bấm lại nút cũ khi tờ khai đã sẵn sàng chờ xác nhận (vd bấm lại nút bộ phận)
    if (
      prevStatus === "ready_for_confirmation" &&
      gate.isComplete &&
      message.toLowerCase().startsWith("callback_data:")
    ) {
      return this.packet(
        doc,
        "awaiting_user_confirmation",
        "Anh/chị xem lại bản tóm tắt phía trên, đúng thì bấm nút xác nhận giúp em nhé ạ.",
        { buttons: confirmationRows() },
      );
    }

    // Kịch bản B: thiếu trường bắt buộc
    if (!gate.isComplete) {
      const fieldsToAsk =
        gate.fieldsToAsk.length > 0 ? gate.fieldsToAsk : gate.missingRequired.slice(0, 1);
      const spec = this.catalog.variants[variantKey]?.fields?.[fieldsToAsk[0]];
      const rows = spec ? fieldButtons(this.catalog, spec) : null;
      // Người dùng vừa nêu một bộ phận ngoài danh mục: nói rõ thay vì hỏi lại
      // y nguyên câu cũ như thể chưa đọc tin nhắn (đã xảy ra: "bộ phận Kế toán"
      // → bị hỏi lại "bổ sung giúp em: bộ phận của anh/chị" hai lần liên tiếp).
      const deptUnrecognized =
        fieldsToAsk.includes("reporting_dept") && doc.unrecognizedDept
          ? `Bộ phận "${doc.unrecognizedDept}" của anh/chị không có trong danh mục của em. Anh/chị chọn giúp em một trong các bộ phận sau nhé ạ.`
          : undefined;
      // Có nút thì không liệt kê lựa chọn bằng chữ nữa
      const question =
        (deptUnrecognized && fieldsToAsk.length === 1 ? deptUnrecognized : undefined) ||
        composeQuestion(this.catalog, record, fieldsToAsk, { withOptions: !rows }) ||
        "Anh/chị bổ sung giúp em thêm thông tin về sự cố nhé ạ.";
      for (const f of fieldsToAsk) doc.askedCount[f] = (doc.askedCount[f] ?? 0) + 1;
      doc.lastAskedFields = fieldsToAsk;
      doc.status = "collecting";
      this.repo.saveRevision(doc);
      return this.packet(doc, "ask_missing_field", question, {
        missingFields: gate.missingRequired,
        buttons: rows ?? undefined,
      });
    }

    // Kịch bản B': gate không tự hỏi hệ thống (trường hệ thống điền) — hỏi MỘT lần
    // kèm nút; vẫn không rõ thì tóm tắt ghi rõ "Chưa xác định".
    const systemKnown = Boolean(doc.fields.system?.value);
    const systemSettled =
      (doc.explicitlyMissing ?? []).includes("system") || (doc.askedCount.system ?? 0) >= 1;
    if (!systemKnown && !systemSettled) {
      doc.askedCount.system = (doc.askedCount.system ?? 0) + 1;
      doc.lastAskedFields = ["system"];
      doc.status = "collecting";
      this.repo.saveRevision(doc);
      return this.packet(
        doc,
        "ask_missing_field",
        'Dạ lỗi này xảy ra trên hệ thống nào ạ? Anh/chị chọn giúp em nhé (không rõ thì nhắn "không biết").',
        {
          missingFields: ["system"],
          buttons: layoutButtons(VALID_SYSTEMS.map((v) => ({ text: v, callbackData: v }))),
        },
      );
    }

    // Xin gấp mà chưa nói lý do: hỏi MỘT lần (không có lý do thì giữ mức theo bằng chứng).
    if (
      doc.requestedPriority &&
      !doc.requestedPriority.reason &&
      !(doc.askedCount[PRIORITY_REASON_FIELD] ?? 0)
    ) {
      doc.askedCount[PRIORITY_REASON_FIELD] = 1;
      doc.lastAskedFields = [PRIORITY_REASON_FIELD];
      doc.status = "collecting";
      this.repo.saveRevision(doc);
      const want = PRIORITY_LABEL[doc.requestedPriority.level];
      return this.packet(
        doc,
        "ask_missing_field",
        `Dạ anh/chị cho em biết lý do cần xử lý gấp (vd phụ huynh đang khiếu nại, học sinh sắp vào học…) để em đặt mức ${want} nhé ạ. Không có lý do cụ thể thì nhắn "không có".`,
        { missingFields: [] },
      );
    }

    // Kịch bản B'': soát bằng con mắt kỹ thuật viên — thiếu dữ kiện để bắt tay kiểm tra
    // (mã đơn, hạn đang hiện so với hạn đúng, link CARE, ảnh báo lỗi…) thì hỏi MỘT lượt.
    // Trả lời gì (kể cả "không có") cũng đi tiếp tới tóm tắt.
    if (this.options.techReviewer && !doc.techReviewDone) {
      doc.techReviewDone = true;
      const review = await this.options.techReviewer
        .review(this.techReviewInput(doc))
        .catch((err) => {
          getLogger().warn(
            `[pipeline] Tờ khai ${doc.docId}: soát dữ kiện kỹ thuật lỗi, bỏ qua — ${err instanceof Error ? err.message : String(err)}`,
          );
          return { missing: [] as string[], question: undefined };
        });
      if (review.missing.length > 0 && review.question) {
        getLogger().info(
          `[pipeline] Tờ khai ${doc.docId}: thiếu dữ kiện kỹ thuật (${review.missing.join("; ")}) — hỏi người báo một lượt.`,
        );
        doc.techQuestion = review.question;
        doc.lastAskedFields = [TECH_INFO_FIELD];
        doc.status = "collecting";
        this.repo.saveRevision(doc);
        return this.packet(doc, "ask_missing_field", review.question, {
          missingFields: [],
          buttons: [[{ text: "Không có", callbackData: "Không có" }]],
        });
      }
    }

    // Kịch bản C: đủ thông tin — tóm tắt xin xác nhận
    // Tra ticket tương tự (KG + Onyx + BM25 + LLM xác minh từng cặp) KHÔNG còn
    // chạy ở đây: kiến trúc mới có thể mất tới hàng chục giây (nhiều lời gọi
    // LLM), chặn bản tóm tắt xin xác nhận là trải nghiệm tệ. Chạy nền SAU khi
    // tạo ticket (this.runSimilarTicketsInBackground trong createTicket).
    doc.lastAskedFields = undefined;
    doc.status = "ready_for_confirmation";
    doc.summaryShownAt = new Date(this.now()).toISOString();
    this.repo.saveRevision(doc);

    const dept =
      doc.fields.reportingDept?.value ?? gate.effectiveValues.reporting_dept ?? UNKNOWN_DEPT;
    const system = doc.fields.system?.value ?? UNKNOWN_SYSTEM;
    const rawPriority = doc.fields.priority?.value?.toLowerCase() ?? "medium";
    const priority = PRIORITY_LABEL[rawPriority] ?? rawPriority;
    let title = doc.fields.title?.value || "Sự cố kỹ thuật";
    // Chốt chặn: KHÔNG BAO GIỜ để tiêu đề là tên người hoặc mã trần (TECH-1146)
    if (isInvalidTitle(title, doc.fields.rawText?.value)) {
      title = deriveFallbackTitle(doc.fields.rawText?.value || "", doc.fields.symptoms?.value);
      if (isInvalidTitle(title)) title = "Sự cố kỹ thuật";
    }
    const voiceText = `Em tóm tắt lại sự cố nhé: ${title}, thuộc hệ thống ${system}, mức ưu tiên ${priority}. Anh/chị kiểm tra chuẩn rồi thì xác nhận giúp em nhé!`;
    const displayMarkdown =
      `**Em tóm tắt lại sự cố của anh/chị nhé ạ:**\n\n` +
      `- Tiêu đề: ${title}\n` +
      (doc.fields.product?.value ? `- Sản phẩm: ${doc.fields.product.value}\n` : "") +
      `- Hệ thống: ${system}\n` +
      (doc.fields.customerId?.value &&
      doc.fields.customerId.value !== doc.fields.studentAccount?.value
        ? `- Mã khách hàng: ${doc.fields.customerId.value}\n`
        : "") +
      (doc.fields.studentAccount?.value
        ? `- Tài khoản HS / SĐT: ${doc.fields.studentAccount.value}\n`
        : "") +
      `- Bộ phận: ${dept}\n` +
      (doc.fields.errorCategory?.value
        ? `- Phân loại lỗi: ${doc.fields.errorCategory.value}\n`
        : "") +
      (doc.fields.mediaPaths?.value?.length
        ? `- Đính kèm: ${doc.fields.mediaPaths.value.length} tệp\n`
        : "") +
      `- Mức ưu tiên: ${priority}\n\n` +
      `Anh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận nhé ạ!`;

    return this.packet(doc, "confirm_summary", voiceText, {
      displayMarkdown,
      missingFields: [],
      buttons: confirmationRows(),
    });
  }

  /**
   * Hỏi người báo xác nhận tách ticket khi tin nhắn chứa nhiều học sinh/sự cố (W29-SPLIT, TECH-1146).
   */
  private parkForSplitDecision(
    doc: IntakeDocument,
    blocks: IncidentBlock[],
    media: string[],
  ): IntakePacket {
    const parked: IntakeDocument = {
      ...doc,
      revision: doc.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      pendingSplit: {
        blocks,
        mediaPaths: media,
        askedAt: new Date(this.now()).toISOString(),
      },
    };
    this.repo.saveRevision(parked);
    return this.splitQuestionPacket(parked, blocks);
  }

  /**
   * Nội dung câu hỏi "tách hay gộp" kèm nút — dùng cho cả lần hỏi đầu và lần hỏi lại
   * DUY NHẤT khi câu trả lời chưa rõ ý (P1 Vòng 3), nên hai lần hỏi không bao giờ lệch nhau.
   */
  private splitQuestionPacket(
    doc: IntakeDocument,
    blocks: IncidentBlock[],
    prefix = "",
  ): IntakePacket {
    const names = blocks.map((b) => b.studentName || b.customerId || "sự cố").filter(Boolean);
    const namesSummary = names.length > 0 ? names.join(", ") : `${blocks.length} sự cố`;
    const count = blocks.length;
    return this.packet(
      doc,
      "ask_split_or_merge",
      `${prefix}Dạ em thấy tin nhắn có ${count} học sinh/sự cố khác nhau (${namesSummary}) — em tách ${count} ticket nhé?`,
      {
        buttons: [
          [
            { text: `Tách ${count} ticket`, callbackData: `Tách ${count} ticket` },
            { text: "Gộp 1 ticket", callbackData: "Gộp 1 ticket" },
          ],
        ],
      },
    );
  }

  /**
   * Xử lý câu trả lời cho câu hỏi "tách ticket hay gộp" (W29-SPLIT).
   *
   * Vòng 2: phủ định ("không tách", "ko tách") được kiểm TRƯỚC — Bug 5; và mọi
   * câu trả lời KHÁC (huỷ, hỏi việc khác, báo sự cố mới bằng văn xuôi) đều thoát
   * được khỏi câu hỏi và đi tiếp luồng bình thường — Bug 6, không còn dead-end.
   *
   * Vòng 3 (REVIEW2 §5, P1/P2):
   *  - `thôi` / `khỏi` TRẦN = KHÔNG tách → MỘT ticket giữ trọn mọi text + mọi ảnh (P2);
   *  - câu trả lời KHÔNG rõ ý (kể cả tin chỉ có ảnh) KHÔNG bao giờ làm mất báo cáo đã
   *    park: hỏi lại câu tách ĐÚNG MỘT lần, vẫn không rõ thì mặc định gộp 1 ticket (P1);
   *  - huỷ tường minh vẫn đi thẳng luồng huỷ như trước.
   */
  private async resolvePendingSplit(
    doc: IntakeDocument,
    input: RunStepInput,
    message: string,
    media: string[],
  ): Promise<IntakePacket> {
    const buffered = doc.pendingSplit!;
    const reply = message.trim().toLowerCase();

    const negated = /(?:^|[^\p{L}])(?:không|ko|k|chẳng|chưa|đừng|khỏi|thôi)(?:$|[^\p{L}])/u.test(
      reply,
    );
    /**
     * P2 (Vòng 3): "thôi"/"khỏi" đứng TRẦN (chỉ kèm tiểu từ lịch sự) ở câu hỏi tách =
     * KHÔNG tách. Người báo gõ "thôi" là muốn thôi, KHÔNG phải "gộp giúp tôi" — nhưng cả
     * hai đều dẫn tới CÙNG một kết quả an toàn: MỘT ticket giữ trọn mọi text + mọi ảnh.
     */
    const saysStopSplit = /^(?:thôi|khỏi)(?:\s+(?:ạ|a|nha|nhé|vậy|đi|thôi|khỏi|luôn))*$/u.test(
      reply,
    );
    const saysSplit = !negated && /(?:^|[^\p{L}])tách(?:$|[^\p{L}])/u.test(reply);
    const agreesToSplit =
      saysSplit ||
      (!negated &&
        /^(?:đúng rồi|ok|oke|okay|ừ|vâng|dạ|chuẩn|tạo đi|yes|đồng ý|đúng)$/u.test(reply));
    const agreesToMerge =
      !saysSplit &&
      (saysStopSplit ||
        /(?:^|[^\p{L}])gộp(?:$|[^\p{L}])/u.test(reply) ||
        /để chung|chung 1 ticket|một ticket|1 ticket/u.test(reply) ||
        (negated && /(?:^|[^\p{L}])tách(?:$|[^\p{L}])/u.test(reply)) ||
        /^(?:không|ko|k|no)$/u.test(reply));

    if (agreesToSplit) {
      const [firstBlock, ...restBlocks] = buffered.blocks;
      // Bug 10: KHÔNG chia ảnh mù theo số khối (album Telegram không bảo đảm thứ
      // tự và 2 ảnh có thể cùng thuộc khối 1). Có ảnh mà tách nhiều khối → gắn
      // TẤT CẢ ảnh cho mọi ticket + bật cờ mediaAmbiguous để mô tả nói rõ.
      const sharedMedia = Array.from(new Set([...buffered.mediaPaths, ...media]));
      const ambiguous = sharedMedia.length > 0 && buffered.blocks.length > 1;
      for (const b of restBlocks) b.mediaPaths = sharedMedia;

      const activeDoc: IntakeDocument = {
        ...doc,
        revision: doc.revision + 1,
        pendingSplit: undefined,
        pendingSplitQueue: restBlocks.length > 0 ? restBlocks : undefined,
        mediaAmbiguous: ambiguous,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(activeDoc);

      // Chữ của những tin CHƯA RÕ Ý đã hỏi lại (P1) đi kèm ticket ĐẦU TIÊN — không bỏ chữ nào.
      const firstText = [firstBlock.text, ...(buffered.extraText ?? [])]
        .filter(Boolean)
        .join("\n\n");
      return this.collect(activeDoc, input, firstText, sharedMedia, undefined, true);
    }

    if (agreesToMerge) {
      return this.mergeParkedSplit(
        doc,
        input,
        buffered,
        buffered.extraText ?? [],
        Array.from(new Set([...buffered.mediaPaths, ...media])),
      );
    }

    // Huỷ TƯỜNG MINH ở câu hỏi tách: bỏ câu hỏi tách rồi để `collect` xử lý `intent = cancel`
    // (xoá luôn hàng đợi — Bug 7). Mọi câu KHÔNG rõ ý khác đi nhánh P1 bên dưới.
    const intent = (
      await this.options.extractor.extract(message, this.contextOf(doc)).catch(() => null)
    )?.userIntent;
    if (intent === "cancel") {
      getLogger().info(
        `[pipeline] Tờ khai ${doc.docId}: người báo huỷ ở câu hỏi tách — bỏ câu hỏi và đi tiếp.`,
      );
      const movedOn: IntakeDocument = {
        ...doc,
        revision: doc.revision + 1,
        pendingSplit: undefined,
        pendingSplitQueue: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(movedOn);
      return this.collect(movedOn, input, message, media, undefined, true);
    }

    return this.handleUnclearSplitReply(doc, input, message, media, buffered);
  }

  /**
   * Câu trả lời CHƯA RÕ Ý ở câu hỏi tách (P1 — Vòng 3, REVIEW2 §5).
   *
   * Vòng 2 đánh rơi báo cáo đã park ở đúng nhánh này: `rawText` mất báo cáo gốc, ảnh
   * thành 0, tiêu đề lấy chính câu trả lời — cùng nhóm lỗi mất nội dung đã khiến Vòng 1
   * bị DO-NOT-SHIP. Luật Vòng 3:
   *  1. KHÔNG bao giờ xoá `pendingSplit`: chữ chưa rõ vào `extraText`, ảnh vào `mediaPaths`.
   *  2. Hỏi lại câu tách ĐÚNG MỘT lần (kèm nút, `clarifyCount = 1`).
   *  3. Vẫn không rõ → mặc định GỘP một ticket, giữ TRỌN mọi text + mọi ảnh.
   * Tin CHỈ CÓ ẢNH cũng đi đúng đường này: ảnh được thêm vào báo cáo đã park rồi hỏi lại.
   */
  private async handleUnclearSplitReply(
    doc: IntakeDocument,
    input: RunStepInput,
    message: string,
    media: string[],
    buffered: NonNullable<IntakeDocument["pendingSplit"]>,
  ): Promise<IntakePacket> {
    const carriedText = message.trim() && !isInternalCallbackToken(message) ? message.trim() : "";
    // Tin dán LẠI y nguyên báo cáo đã park thì không nhân bản chữ (chữ đã nằm trong khối).
    const duplicated =
      carriedText !== "" && buffered.blocks.some((b) => b.text.includes(carriedText));
    const extraText =
      carriedText && !duplicated
        ? [...(buffered.extraText ?? []), carriedText]
        : (buffered.extraText ?? []);
    const mergedMedia = Array.from(new Set([...buffered.mediaPaths, ...media]));
    const reasked = (buffered.clarifyCount ?? 0) >= 1;

    if (!reasked) {
      const retry: IntakeDocument = {
        ...doc,
        revision: doc.revision + 1,
        pendingSplit: { ...buffered, mediaPaths: mergedMedia, extraText, clarifyCount: 1 },
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(retry);
      getLogger().info(
        `[pipeline] Tờ khai ${doc.docId}: "${message.slice(0, 40)}" chưa rõ tách/gộp — giữ nguyên báo cáo đã park (${mergedMedia.length} ảnh) và hỏi lại một lần.`,
      );
      return this.splitQuestionPacket(
        retry,
        buffered.blocks,
        "Dạ em chưa rõ ý anh/chị ạ — nội dung báo cáo em vẫn giữ nguyên. ",
      );
    }

    getLogger().info(
      `[pipeline] Tờ khai ${doc.docId}: vẫn chưa rõ tách/gộp sau khi hỏi lại — gộp 1 ticket để KHÔNG mất nội dung.`,
    );
    return this.mergeParkedSplit(doc, input, buffered, extraText, mergedMedia);
  }

  /** Gộp báo cáo đã park thành MỘT ticket, giữ trọn mọi khối chữ + mọi ảnh (P1/P2 Vòng 3). */
  private async mergeParkedSplit(
    doc: IntakeDocument,
    input: RunStepInput,
    buffered: NonNullable<IntakeDocument["pendingSplit"]>,
    extraText: string[],
    media: string[],
  ): Promise<IntakePacket> {
    const combinedText = [...buffered.blocks.map((b) => b.text), ...extraText]
      .filter(Boolean)
      .join("\n\n");
    const studentNames = buffered.blocks.map((b) => b.studentName).filter(Boolean) as string[];
    const mergedDoc: IntakeDocument = {
      ...doc,
      revision: doc.revision + 1,
      pendingSplit: undefined,
      pendingSplitQueue: undefined,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.repo.saveRevision(mergedDoc);

    const packet = await this.collect(mergedDoc, input, combinedText, media, undefined, true);
    const currentTitle = packet.document.fields.title?.value;
    if (!currentTitle || isInvalidTitle(currentTitle, packet.document.fields.rawText?.value)) {
      const derived = deriveFallbackTitle(
        combinedText,
        packet.document.fields.symptoms?.value,
        studentNames,
      );
      packet.document.fields.title = {
        value: derived,
        source: "system_inferred",
        turn: packet.document.currentTurn,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(packet.document);
    }
    return packet;
  }

  /**
   * tài liệu đang mở (`pendingNewIncident`) và hỏi người báo chọn "sự cố mới"
   * hay "bổ sung". Tài liệu A không đổi gì khác — status, các trường đã gom
   * được đều giữ nguyên y hệt trước khi tin xung đột này tới.
   */
  private parkForNewIncidentDecision(
    doc: IntakeDocument,
    message: string,
    media: string[],
  ): IntakePacket {
    const parked: IntakeDocument = {
      ...doc,
      revision: doc.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      pendingNewIncident: {
        message,
        mediaPaths: media,
        askedAt: new Date(this.now()).toISOString(),
      },
    };
    this.repo.saveRevision(parked);
    return this.packet(
      parked,
      "ask_new_or_continue",
      `Dạ tin này có vẻ là sự cố khác với sự cố «${doc.fields.title?.value || "đang chờ"}» ạ. Đây là SỰ CỐ MỚI hay bổ sung cho sự cố đang chờ vậy anh/chị?`,
      { buttons: newOrContinueRows() },
    );
  }

  /**
   * Xử lý câu trả lời cho câu hỏi "sự cố mới hay bổ sung" ở
   * `parkForNewIncidentDecision`. So message với ĐÚNG hai nhãn nút cố định —
   * không đoán ý người dùng từ câu chữ tự do.
   *
   * - "Sự cố mới": tờ khai cũ (A) được giữ NGUYÊN (chỉ bỏ cờ chờ), tin bị park
   *   phát lại vào một tài liệu MỚI hoàn toàn — thành sự cố B độc lập.
   * - "Bổ sung": tin bị park phát lại vào CHÍNH tài liệu A, bỏ qua chốt xung
   *   đột cho đúng một lượt này (người dùng đã xác nhận đây là cùng sự cố).
   * - Không rõ: hỏi lại y nguyên, không đoán, không làm mất dữ liệu bên nào.
   */
  private async resolvePendingNewIncident(
    doc: IntakeDocument,
    input: RunStepInput,
    message: string,
    media: string[],
  ): Promise<IntakePacket> {
    const buffered = doc.pendingNewIncident!;
    const bufferedMedia = Array.from(new Set([...buffered.mediaPaths, ...media]));
    const reply = message.trim().toLowerCase();

    if (reply.includes(NEW_INCIDENT_LABEL.toLowerCase()) || saysNewIncident(reply)) {
      const parkedButUntouched: IntakeDocument = { ...doc, pendingNewIncident: undefined };
      this.repo.saveRevision(parkedButUntouched);
      const fresh = this.freshDoc(doc.chatId, this.now());
      // Nhớ tờ khai vừa bị gác lại (doc) để nhắc lại khi sự cố mới này xong
      // việc (tạo ticket hoặc huỷ) — xem appendParkedReminder/resumeParkedDraft.
      fresh.parkedDocId = doc.docId;
      return this.collect(fresh, input, withTypedDetail(buffered.message, message), bufferedMedia);
    }

    if (reply.includes(CONTINUE_DRAFT_LABEL.toLowerCase())) {
      const resumed: IntakeDocument = { ...doc, pendingNewIncident: undefined };
      return this.collect(resumed, input, buffered.message, bufferedMedia, undefined, true);
    }

    // "thôi huỷ" khi đang hỏi: bỏ tin vừa park (sự cố mới), tờ khai đang chờ giữ nguyên.
    const intent = (
      await this.options.extractor.extract(message, this.contextOf(doc)).catch(() => null)
    )?.userIntent;
    if (intent === "cancel") {
      this.repo.saveRevision({ ...doc, revision: doc.revision + 1, pendingNewIncident: undefined });
      const title = doc.fields.title?.value;
      return this.packet(
        { ...doc, pendingNewIncident: undefined },
        "canceled",
        `Dạ em bỏ tin vừa rồi ạ.${title ? ` Sự cố «${title}» vẫn đang chờ, anh/chị nhắn tiếp khi cần nhé.` : ""}`,
      );
    }

    return this.packet(
      doc,
      "ask_new_or_continue",
      'Dạ anh/chị bấm giúp em nút "Sự cố mới" hay "Bổ sung sự cố đang chờ" phía trên nhé ạ, em chưa rõ ý ạ.',
      { buttons: newOrContinueRows() },
    );
  }

  /**
   * Sự cố mới (B) vừa xong việc (tạo ticket hoặc huỷ) — nếu tờ khai bị gác lại
   * lúc bấm "Sự cố mới" (`doc.parkedDocId`) vẫn còn MỞ (collecting/ready_for_confirmation)
   * và chưa hết hạn, thêm một câu nhắc + MỘT nút vào packet để người báo không
   * quên nó (nó không tự trôi vào đâu cả — không thì mồ côi, xem TECH-928).
   * Không đụng gì tới tờ khai bị gác — chỉ đọc để lấy tiêu đề.
   */
  private appendParkedReminder(packet: IntakePacket, doc: IntakeDocument): IntakePacket {
    if (!doc.parkedDocId) return packet;
    const parked = this.repo.getByDocId(doc.parkedDocId);
    if (!parked || !OPEN_DRAFT_STATUSES.has(parked.status) || this.isExpired(parked, this.now()))
      return packet;
    const title = parked.fields.title?.value || "sự cố trước đó";
    const reminder = ` Còn sự cố «${title}» anh/chị báo trước đó đang chờ xác nhận ạ.`;
    return {
      ...packet,
      voiceText: packet.voiceText + reminder,
      buttons: [...(packet.buttons ?? []), ...resumeParkedRows()],
    };
  }

  /**
   * Bấm nút RESUME_PARKED_LABEL (thêm bởi appendParkedReminder). Đưa tờ khai bị
   * gác lại trở thành tài liệu đang mở của chat — CHẠY QUA `collect()` với một
   * trích xuất RỖNG (không gọi LLM, không có trường mới) để tái dùng nguyên vẹn
   * Kịch bản B (thiếu trường) / C (tóm tắt) hiện có, KHÔNG BAO GIỜ tự tạo ticket
   * (userIntent "provide_info" nên Kịch bản A — cần intent "confirm" — không chạy).
   */
  private async resumeParkedDraft(
    input: RunStepInput,
    parkedDocId: string,
  ): Promise<IntakePacket | null> {
    const parked = this.repo.getByDocId(parkedDocId);
    if (!parked || !OPEN_DRAFT_STATUSES.has(parked.status) || this.isExpired(parked, this.now()))
      return null;
    return this.collect(parked, input, "", [], noopExtracted(), true);
  }

  /** Tạo ticket thật. Giành quyền tạo bằng revision nguyên tử trước khi gọi API. */
  private async createTicket(doc: IntakeDocument, input: RunStepInput): Promise<IntakePacket> {
    const { chatId } = doc;
    const nowIso = new Date(this.now()).toISOString();
    const claim: IntakeDocument = {
      ...doc,
      status: "confirmed",
      confirmingSince: nowIso,
      updatedAt: nowIso,
    };
    if (!this.repo.tryInsertRevision(claim)) {
      const latest = this.repo.getLatestByChatId(chatId);
      if (latest?.status === "created" && latest.issueId) {
        return this.packet(
          latest,
          "already_created",
          `Dạ ticket ${latest.issueIdentifier} em đã tạo rồi ạ, anh/chị không cần xác nhận lại nhé.`,
          {
            issue: this.issueOf(latest),
          },
        );
      }
      return this.packet(
        claim,
        "in_progress",
        "Dạ em đang tạo ticket cho anh/chị, anh/chị chờ em một chút nhé ạ.",
      );
    }

    const projectKey = this.options.projectKey;
    const rawTitle = (doc.fields.title?.value || "").trim();
    const rawContent = (
      doc.fields.rawText?.value ||
      doc.fields.symptoms?.value?.join("\n") ||
      ""
    ).trim();

    // TECH-1148: Chặn tạo ticket có tiêu đề hoặc mô tả rỗng hoặc chỉ là token nội bộ (noop)
    const titleIsInternal = !rawTitle || isInternalCallbackToken(rawTitle);
    const contentIsInternal = !rawContent || isInternalCallbackToken(rawContent);
    if (titleIsInternal || contentIsInternal) {
      getLogger().error(
        `[intake_step] Từ chối tạo ticket cho chat ${chatId}: tiêu đề hoặc mô tả không hợp lệ (rỗng hoặc chỉ là token nội bộ). title="${rawTitle}", content="${rawContent}"`,
      );
      const back: IntakeDocument = {
        ...claim,
        revision: claim.revision + 1,
        status: "ready_for_confirmation",
        confirmingSince: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(back);
      return {
        ...this.packet(
          back,
          "create_failed",
          "Dạ em chưa nhận được nội dung mô tả sự cố cụ thể nên chưa tạo ticket được ạ. Anh/chị mô tả giúp em sự cố đang gặp nhé.",
        ),
        success: false,
      };
    }

    // TECH-1146: Chốt chặn — KHÔNG BAO GIỜ để tiêu đề là tên người hoặc mã trần.
    let title = rawTitle || "Sự cố kỹ thuật";
    if (isInvalidTitle(title, doc.fields.rawText?.value)) {
      title = deriveFallbackTitle(doc.fields.rawText?.value || "", doc.fields.symptoms?.value);
      if (isInvalidTitle(title)) title = "Sự cố kỹ thuật";
    }
    const description = this.describe(doc);
    let createdIssue: Awaited<ReturnType<ItsaplanClient["createIssue"]>>;
    try {
      let columnId = this.options.columnId;
      if (!columnId) {
        const cols = await this.options.itsaplan.listProjectColumns(projectKey).catch(() => []);
        const unstartedCol = cols.find(
          (c) => c.stateType === "unstarted" || c.stateType === "backlog",
        );
        columnId = unstartedCol ? unstartedCol.id : (cols[0]?.id ?? 1);
      }
      const category = doc.fields.errorCategory?.value || "Chưa phân loại";
      const labelIds = await resolveLabelsForIssue(
        this.options.itsaplan,
        projectKey,
        category,
      ).catch(() => [] as number[]);

      createdIssue = await this.options.itsaplan.createIssue(projectKey, {
        title,
        description,
        columnId,
        priority: toPriorityLevel(doc.fields.priority?.value),
        labelIds: labelIds.length > 0 ? labelIds : undefined,
      });
    } catch (err: any) {
      // Lỗi nội bộ chỉ vào log — người dùng nhận câu dễ hiểu, tóm tắt giữ nguyên để thử lại
      getLogger().error(`[intake_step] Tạo ticket lỗi cho chat ${chatId}: ${err?.message ?? err}`);
      const back: IntakeDocument = {
        ...claim,
        revision: claim.revision + 1,
        status: "ready_for_confirmation",
        confirmingSince: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.repo.saveRevision(back);
      return {
        ...this.packet(
          back,
          "create_failed",
          "Dạ hệ thống ghi ticket đang trục trặc nên em chưa tạo được ạ. Thông tin anh/chị đã được giữ nguyên — anh/chị bấm xác nhận lại sau ít phút giúp em nhé.",
          { buttons: confirmationRows() },
        ),
        success: false,
      };
    }

    const teamRef = await resolveProjectTeamRef(this.options.itsaplan, projectKey);
    const url = issueWebUrl(
      this.options.webUrl,
      projectKey,
      createdIssue.identifier,
      createdIssue.sequenceNumber,
      teamRef,
    );
    const createdDoc: IntakeDocument = {
      ...claim,
      revision: claim.revision + 1,
      status: "created",
      issueId: createdIssue.id,
      issueIdentifier: createdIssue.identifier,
      issueUrl: url,
      issueCreatedAt: new Date(this.now()).toISOString(),
      confirmingSince: undefined,
      lastAskedFields: undefined,
      updatedAt: new Date(this.now()).toISOString(),
    };
    // Ghi "created" NGAY — các việc phụ dưới đây hỏng cũng không được dẫn tới tạo lại
    this.repo.saveRevision(createdDoc);

    // Những việc create_issue vẫn làm: binding, ảnh, dọn bản nháp + nút chờ
    if (this.options.bindingRepo) {
      try {
        bindIssueToChat(
          this.options.bindingRepo,
          createdIssue,
          chatId,
          doc.reporter?.username ?? doc.reporter?.nameCode,
        );
      } catch (err: any) {
        getLogger().warn(
          `[intake_step] Không lưu được binding ${createdIssue.identifier}: ${err?.message}`,
        );
      }
    }
    const media = doc.fields.mediaPaths?.value ?? [];
    if (media.length > 0) {
      try {
        await attachMediaToIssue(
          this.options.itsaplan,
          this.options.itsaplanBaseUrl ?? "",
          createdIssue.id,
          description,
          media,
        );
      } catch (err: any) {
        getLogger().warn(
          `[intake_step] Không tải được ảnh lên ${createdIssue.identifier}: ${err?.message}`,
        );
      }
    }
    clearConfirmationState(chatId, this.options.draftRepo, (id) => this.buttons.clear(String(id)));
    // KHÔNG await: tra ticket tương tự (Onyx + BM25 + LLM xác minh) có thể mất
    // tới SIMILAR_TIMEOUT_MS (mặc định 60s) — không được chặn câu trả lời
    // "đã tạo ticket" cho người dùng. Chạy nền, tự ghi log, lỗi không ảnh hưởng ticket.
    const bg = this.runSimilarTicketsInBackground(createdDoc, createdIssue, input).catch(
      (err: any) =>
        getLogger().warn(
          `[pipeline] Tra ticket tương tự nền cho ${createdIssue.identifier} lỗi: ${err?.message ?? err}`,
        ),
    );
    this.pendingBackground.push(bg);

    // Nếu còn sự cố trong hàng đợi tách (W29-SPLIT): tự động chuyển sang sự cố tiếp theo
    if (doc.pendingSplitQueue && doc.pendingSplitQueue.length > 0) {
      const [nextBlock, ...remainingQueue] = doc.pendingSplitQueue;
      const nextDoc = this.freshDoc(doc.chatId, this.now());
      nextDoc.pendingSplitQueue = remainingQueue.length > 0 ? remainingQueue : undefined;
      nextDoc.mediaAmbiguous = doc.mediaAmbiguous;
      nextDoc.parkedDocId = createdDoc.docId;
      // Kế thừa bộ phận người báo từ tờ khai trước (cùng một người báo trong đợt tách)
      if (doc.fields.reportingDept) {
        nextDoc.fields.reportingDept = {
          ...doc.fields.reportingDept,
          updatedAt: new Date(this.now()).toISOString(),
        };
      }

      const nextResult = await this.collect(
        nextDoc,
        input,
        nextBlock.text,
        nextBlock.mediaPaths ?? [],
        undefined,
        true,
      );
      const studentLabel = nextBlock.studentName ? ` (học sinh ${nextBlock.studentName})` : "";
      const voicePrefix = `Em đã tạo thành công ticket ${createdIssue.identifier} cho anh/chị rồi ạ. Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo${studentLabel} nhé ạ!`;

      // Bug 8: gói tin trả về VẪN phải là `ticket_created` KÈM `issue` của ticket
      // vừa tạo (agent ngoài dựa vào đó để ghi nhận hoàn thành); phần tóm tắt của
      // sự cố kế tiếp chỉ được nối thêm vào nội dung hiển thị.
      // P3 (Vòng 3): hợp đồng của gói tin pha trộn này được nói RÕ bằng hai trường riêng —
      // `createdIssue` (ticket VỪA TẠO) và `nextDraft` (tờ khai sự cố KẾ TIẾP đang mở, cùng
      // `document`/`docId`/`status`/`buttons` của gói tin). Không đổi hình dạng cũ để agent
      // ngoài không gãy, chỉ hết mơ hồ.
      return {
        ...nextResult,
        action: "ticket_created",
        issue: this.issueOf(createdDoc),
        createdIssue: {
          id: createdIssue.id,
          identifier: createdIssue.identifier,
          title: createdIssue.title,
        },
        nextDraft: {
          docId: nextResult.docId,
          action: nextResult.action,
          status: nextResult.status,
        },
        voiceText: `${voicePrefix} ${nextResult.voiceText}`,
        displayMarkdown: `Đã tạo ticket **${createdIssue.identifier}**\n\n---\n\n${nextResult.displayMarkdown ?? ""}`,
      };
    }
    return this.appendParkedReminder(
      this.packet(
        createdDoc,
        "ticket_created",
        `Em đã tạo thành công ticket ${createdIssue.identifier} cho anh/chị rồi ạ. Đội Kỹ thuật sẽ tiếp nhận và xử lý ngay nhé!`,
        {
          displayMarkdown: `Đã tạo ticket **${createdIssue.identifier}**\n\n- Tiêu đề: ${createdIssue.title}\n- Mức ưu tiên: ${createdDoc.fields.priority?.value?.toUpperCase()}`,
          issue: this.issueOf(createdDoc),
        },
      ),
      createdDoc,
    );
  }

  /** Bổ sung sau khi tạo: comment vào ticket (kèm ảnh), KHÔNG dựng lại mô tả. */
  private async appendFollowUp(
    doc: IntakeDocument,
    extracted: ExtractedFields,
    message: string,
    media: string[],
  ): Promise<IntakePacket> {
    const issueId = doc.issueId!;
    const identifier = doc.issueIdentifier || `TECH-${issueId}`;

    // W29-NOTIFY (06/10/2026): Kiểm tra ticket đã đóng chưa — từ chối lịch sự và hướng dẫn tạo ticket mới
    const issue = await this.options.itsaplan.getIssue(issueId).catch(() => null);
    if (issue) {
      const columns = await this.options.itsaplan
        .listProjectColumns(this.options.projectKey)
        .catch(() => []);
      const currentState = this.resolveIssueState(issue, columns);
      if (currentState === "done" || currentState === "canceled") {
        const statusLabel = currentState === "done" ? "Hoàn tất (Done)" : "Đã hủy (Canceled)";
        return this.packet(
          doc,
          "post_create_update",
          closedTicketRefusalMessage(identifier, statusLabel),
          { issue: this.issueOf(doc) },
        );
      }
    }

    const nextTurn = doc.currentTurn + 1;
    let next = mergeExtractedFields(doc, extracted, nextTurn, message);
    // Bổ sung không được đè định danh của ticket đã tạo (test E2E 28/09: bổ sung nhầm
    // đè mã KH 9100001 của TECH-956 thành 90000005) — định danh mới chỉ nằm trong comment.
    for (const key of IDENTIFIER_FIELD_KEYS) {
      if (doc.fields[key]?.value) next.fields[key] = doc.fields[key];
    }
    next = { ...next, status: "created", updatedAt: new Date(this.now()).toISOString() };
    if (media.length > 0) {
      next.fields.mediaPaths = {
        value: Array.from(new Set([...(next.fields.mediaPaths?.value ?? []), ...media])),
        source: "user_message",
        turn: nextTurn,
        updatedAt: next.updatedAt,
      };
    }

    try {
      const parts: string[] = [];
      if (message) parts.push(capText(message, MAX_FOLLOW_UP_CHARS));
      if (media.length > 0) {
        const uploaded = await uploadAttachments(
          this.options.itsaplan,
          issueId,
          this.options.itsaplanBaseUrl ?? "",
          media,
        );
        for (const att of uploaded) parts.push(formatAttachmentMarkdown(att));
      }
      // Xin gấp sau khi đã tạo ticket: có lý do thì nâng mức ngay trên ticket (user chốt 29/09).
      const reason = extracted.requestedPriorityReason;
      const current = toPriorityLevel(doc.fields.priority?.value);
      if (
        extracted.requestedPriority &&
        reason &&
        PRIORITY_ORDER[extracted.requestedPriority] > PRIORITY_ORDER[current]
      ) {
        await this.options.itsaplan.updateIssue(issueId, { priority: extracted.requestedPriority });
        next.fields.priority = {
          value: extracted.requestedPriority,
          source: "user_message",
          turn: nextTurn,
          updatedAt: next.updatedAt,
        };
        next.requestedPriority = { level: extracted.requestedPriority, reason };
        parts.push(
          `⏫ Nâng mức ưu tiên ${PRIORITY_LABEL[current]} → ${PRIORITY_LABEL[extracted.requestedPriority]} theo đề nghị của người báo. Lý do: ${reason}`,
        );
      }
      if (parts.length > 0) {
        let mentionUsername: string | null = null;
        if (issue) {
          const mention = await resolveSupplementMentionTarget({
            client: this.options.itsaplan,
            projectKey: this.options.projectKey,
            issue,
            reporterNames: [doc.reporter?.name],
          }).catch(() => null);
          mentionUsername = mention?.username ?? null;
        }
        const commentBody = formatSupplementComment({
          parts,
          mention: mentionUsername,
          style: "user_update",
        });
        await this.options.itsaplan.addComment(issueId, commentBody);
        if (this.options.notifier) {
          await notifyOnCallSupplement({
            notifier: this.options.notifier,
            identifier,
            summary: parts.join(" "),
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      getLogger().error(`[intake_step] Ghi bổ sung vào ${identifier} lỗi: ${err?.message ?? err}`);
      return {
        ...this.packet(
          doc,
          "post_create_update",
          `Dạ em chưa ghi được phần bổ sung vào ticket ${identifier} do hệ thống đang trục trặc, anh/chị gửi lại giúp em sau ít phút nhé.`,
          { issue: this.issueOf(doc) },
        ),
        success: false,
      };
    }

    this.repo.saveRevision(next);
    const shown = message ? `\n\n> ${capText(message, 500)}` : "";
    return this.packet(
      next,
      "post_create_update",
      `Em đã cập nhật bổ sung thông tin này vào ticket ${identifier} cho anh/chị rồi nhé ạ!`,
      {
        displayMarkdown: `Đã cập nhật bổ sung vào **${identifier}**${shown}`,
        issue: this.issueOf(next),
      },
    );
  }

  /**
   * Lệnh nhắm vào ticket ĐÃ CÓ (ADR-0008): "bổ sung/sửa TECH-X …", tra cứu "TECH-X",
   * "cái này bổ sung cho TECH-Y" ngay sau khi bot tạo nhầm, hoặc trả lời câu kỹ thuật
   * vừa hỏi. Không bao giờ tự ghi: mọi lần bổ sung / sửa / chuyển đều qua bản xem trước
   * + nút xác nhận. Trả null = luồng tiếp nhận bình thường.
   */
  private async routeToExistingTicket(
    doc: IntakeDocument | null,
    input: RunStepInput,
    message: string,
    media: string[],
  ): Promise<IntakePacket | null> {
    if (!message || doc?.pendingNewIncident) return null;
    const lower = message.toLowerCase();
    const mentionsTicket = mentionedIdentifiers(message, this.options.projectKey).length > 0;
    // "huỷ", "cảm ơn", "ok"… không bao giờ là nội dung ghi vào ticket (test E2E 28/09: "huỷ"
    // bị gợi ý ghi vào TECH-991 vừa huỷ).
    if (!mentionsTicket && (isCancelLike(lower) || isChitchat(message) || isDeclineAnswer(message)))
      return null;
    if (
      [NEW_INCIDENT_LABEL, CONTINUE_DRAFT_LABEL, RESUME_PARKED_LABEL].some((l) =>
        lower.includes(l.toLowerCase()),
      )
    )
      return null;
    const projectKey = this.options.projectKey;
    const chatIds = chatIdVariants(input.chatId);
    const draftOpen = Boolean(doc && !CLOSED_STATUSES.has(doc.status) && hasDescription(doc));

    const found = new Map<string, ReplyCandidate>();
    const mentions = mentionedIdentifiers(message, projectKey);
    // Số trần ("đấy là 989 không phải 1001") chỉ tính khi đúng số một ticket CỦA CHÍNH người báo.
    const ownBindings =
      this.options.bindingRepo?.listBindingsForChat(chatIds, projectKey, 12) ?? [];
    for (const m of message.matchAll(/(?<!\d)(\d{3,5})(?!\d)/g)) {
      const id = `${projectKey.toUpperCase()}-${Number(m[1])}`;
      if (!mentions.includes(id) && ownBindings.some((b) => b.identifier.toUpperCase() === id))
        mentions.push(id);
    }
    for (const identifier of mentions) {
      const issue = await findIssueByIdentifier(this.options.itsaplan, identifier, projectKey);
      if (!issue) continue;
      found.set(identifier, {
        identifier,
        issueId: issue.id,
        title: issue.title,
        ownTicket: this.isOwnTicket(identifier, issue.description, chatIds),
        mentioned: true,
      });
    }
    // Ticket vừa tạo ở chat này — để "cái này bổ sung cho TECH-Y" chuyển được nó sang Y.
    if (
      found.size > 0 &&
      doc?.status === "created" &&
      doc.issueIdentifier &&
      doc.issueId &&
      !found.has(doc.issueIdentifier)
    ) {
      const createdAt = Date.parse(doc.issueCreatedAt ?? "");
      if (!Number.isNaN(createdAt) && this.now() - createdAt < JUST_CREATED_WINDOW_MS) {
        found.set(doc.issueIdentifier, {
          identifier: doc.issueIdentifier,
          issueId: doc.issueId,
          title: doc.fields.title?.value,
          ownTicket: true,
          mentioned: false,
          justCreated: true,
        });
      }
    }
    const route = this.options.bindingRepo?.getLatestMessageRouteForChat(
      "telegram",
      chatIds,
      this.now() - TECH_QUESTION_WINDOW_MS,
    );
    const routeAt = route?.createdAt ? Date.parse(`${route.createdAt.replace(" ", "T")}Z`) : NaN;
    const lastActivity = doc ? Date.parse(doc.updatedAt) : NaN;
    const routeIsFresh =
      route && !Number.isNaN(routeAt) && (Number.isNaN(lastActivity) || routeAt > lastActivity);
    // Kể cả ticket vừa tạo ở chính chat này: nhánh "bổ sung ticket vừa tạo" cũng có thể
    // hiểu câu trả lời cho kỹ thuật thành sự cố mới (test E2E 28/09).
    const routeOpen =
      route && routeIsFresh && !draftOpen ? await this.ticketIsOpen(route.issueId) : false;
    if (route && routeOpen) {
      const existing = found.get(route.identifier);
      found.set(route.identifier, {
        identifier: route.identifier,
        issueId: route.issueId,
        title: existing?.title,
        techQuestion: await this.lastTechComment(route.issueId),
        recentlyRelayed: true,
        ownTicket: true,
        mentioned: existing?.mentioned ?? false,
        justCreated: existing?.justCreated,
      });
    }
    const candidates = [...found.values()].slice(0, 4);
    if (candidates.length === 0) return null;

    let command: TicketCommand = { action: "unclear" };
    if (this.options.ticketCommands) {
      command = await this.options.ticketCommands
        .interpret({
          message,
          attachments: media.length,
          candidates,
          draftTitle: draftOpen ? doc?.fields.title?.value : undefined,
        })
        .catch((err) => {
          getLogger().warn(
            `[pipeline] Đọc lệnh ticket lỗi — ${err instanceof Error ? err.message : String(err)}`,
          );
          return { action: "unclear" } as TicketCommand;
        });
    } else if (candidates.some((c) => c.mentioned)) {
      // Không có LLM: nhắc mã = gợi ý bổ sung hoặc báo đóng/huỷ (vẫn phải xác nhận).
      const c =
        candidates.find((x) => x.mentioned && x.ownTicket) ?? candidates.find((x) => x.mentioned)!;
      const cancelIntent = classifyCancelOrCloseIntent(message);
      const supp = stripSupplementCommandWrapper(message);
      command = cancelIntent
        ? {
            action: "cancel_or_close",
            identifier: c.identifier,
            content: message,
            intent: cancelIntent,
          }
        : {
            action: "append",
            identifier: c.identifier,
            content: supp.isSupplementCommand ? supp.content : message,
          };
    }
    getLogger().info(
      `[pipeline] Chat ${input.chatId}: ứng viên ${candidates.map((c) => c.identifier).join(", ")} → ${command.action}${"identifier" in command ? ` ${command.identifier}` : ""}.`,
    );

    const holder = doc ?? this.freshDoc(input.chatId, this.now());
    const byId = (id: string) => candidates.find((c) => c.identifier === id)!;
    if (command.action === "new") return null;
    if (command.action === "lookup") return this.lookupTicket(holder, byId(command.identifier));
    if (command.action === "unclear") {
      // Chỉ gợi ý khi có tín hiệu thật: nhắc mã ticket của chính mình ưu tiên hơn ticket khác vừa chuyển tiếp (TECH-509).
      const strong =
        candidates.find((c) => c.mentioned && c.ownTicket) ??
        candidates.find((c) => c.recentlyRelayed);
      if (!strong) return null;
      if (strong.mentioned && isCancelOrCloseTicketRequest(message)) {
        return this.proposeCancelOrClose(holder, input, strong, message, media);
      }
      const supp = stripSupplementCommandWrapper(message);
      if (strong.mentioned && supp.isSupplementCommand) {
        command = { action: "append", identifier: strong.identifier, content: supp.content };
      } else {
        return this.proposeTicketAction(holder, input, {
          kind: "suggest",
          target: strong,
          content: message,
          message,
          media,
        });
      }
    }
    const target = byId(command.identifier);
    if (!target) return null;
    if (!target.ownTicket) {
      return this.packet(
        holder,
        "post_create_update",
        `Dạ ${target.identifier} không phải ticket anh/chị báo nên em không ghi vào được ạ. Anh/chị cần xem tình trạng thì nhắn "${target.identifier} tới đâu rồi" nhé.`,
      );
    }
    if (command.action === "cancel_or_close") {
      return this.proposeCancelOrClose(
        holder,
        input,
        target,
        command.content || message,
        media,
        command.intent,
      );
    }
    if (command.action === "append") {
      // W29-NOTIFY (06/10/2026): Kiểm tra ticket đã đóng hay chưa trước khi hỏi xác nhận bổ sung
      const targetIssue = await this.options.itsaplan.getIssue(target.issueId).catch(() => null);
      if (targetIssue) {
        const columns = await this.options.itsaplan
          .listProjectColumns(this.options.projectKey)
          .catch(() => []);
        const targetState = this.resolveIssueState(targetIssue, columns);
        if (targetState === "done" || targetState === "canceled") {
          const statusLabel = targetState === "done" ? "Hoàn tất (Done)" : "Đã hủy (Canceled)";
          return this.packet(
            holder,
            "post_create_update",
            closedTicketRefusalMessage(target.identifier, statusLabel),
          );
        }
      }
      const supp = stripSupplementCommandWrapper(message);
      const cleanContent =
        supp.isSupplementCommand &&
        (!supp.content || command.content.trim().toLowerCase() === message.trim().toLowerCase())
          ? supp.content
          : command.content;
      if (!cleanContent.trim() && media.length === 0) {
        const pending: NonNullable<IntakeDocument["pendingTicketAction"]> = {
          kind: "append",
          identifier: target.identifier,
          issueId: target.issueId,
          content: "",
          message: "",
          mediaPaths: [],
          askedAt: new Date(this.now()).toISOString(),
        };
        const saved: IntakeDocument = {
          ...holder,
          revision: holder.revision + 1,
          updatedAt: pending.askedAt,
          pendingTicketAction: pending,
        };
        this.repo.saveRevision(saved);
        const title = target.title ? ` «${target.title}»` : "";
        return this.packet(
          saved,
          "clarify_intent",
          `Dạ anh/chị gửi ảnh chụp màn hình hoặc nội dung cần bổ sung vào ${target.identifier}${title} giúp em nhé ạ.`,
          {
            buttons: [[{ text: CANCEL_ACTION_LABEL, callbackData: CANCEL_ACTION_LABEL }]],
          },
        );
      }
      const kind = target.mentioned ? "append" : "suggest";
      return this.proposeTicketAction(holder, input, {
        kind,
        target,
        content: cleanContent,
        message: cleanContent || message,
        media,
      });
    }
    if (command.action === "edit")
      return this.proposeEdit(holder, input, target, command.instruction);
    const from = byId(command.from);
    return this.proposeTicketAction(holder, input, {
      kind: "move",
      target,
      from,
      content: "",
      message,
      media: [],
    });
  }

  /** Ticket chưa đóng (Done/Canceled) (W29-NOTIFY, 06/10/2026: team Kỹ thuật chốt ticket đóng thì không nhận bổ sung). */
  private async ticketIsOpen(issueId: number): Promise<boolean> {
    try {
      const issue = await this.options.itsaplan.getIssue(issueId);
      if (issue.stateType === "canceled" || issue.stateType === "completed") return false;
      const columns = await this.options.itsaplan.listProjectColumns(this.options.projectKey);
      const col = columns.find((c) => c.id === issue.columnId);
      if (!col) return true;
      const state = classifyColumn(col);
      return state !== "canceled" && state !== "done";
    } catch {
      return true;
    }
  }

  /** Ticket thuộc người báo: binding cùng chat (gồm ticket bot cũ) hoặc mô tả có Telegram ID. */
  private isOwnTicket(
    identifier: string,
    description: string | undefined,
    chatIds: string[],
  ): boolean {
    const b = this.options.bindingRepo?.getBindingByIdentifier(identifier);
    if (b && chatIds.includes(String(b.chatId))) return true;
    const bare = chatIds[0];
    return Boolean(
      bare &&
        /^\d{5,}$/.test(bare) &&
        description &&
        new RegExp(`(?<!\\d)${bare}(?!\\d)`).test(description),
    );
  }

  /** Bản xem trước + nút xác nhận cho bổ sung / gợi ý bổ sung / chuyển ticket vừa tạo. */
  private proposeTicketAction(
    holder: IntakeDocument,
    input: RunStepInput,
    p: {
      kind: "append" | "suggest" | "move" | "cancel_ticket" | "close_ticket";
      target: ReplyCandidate;
      from?: ReplyCandidate;
      content: string;
      message: string;
      media: string[];
      lead?: string;
      alternatives?: { identifier: string; issueId: number; title?: string }[];
    },
  ): IntakePacket {
    const pending: NonNullable<IntakeDocument["pendingTicketAction"]> = {
      kind: p.kind,
      identifier: p.target.identifier,
      issueId: p.target.issueId,
      content: p.content,
      message: p.message,
      mediaPaths: p.media,
      from: p.from ? { identifier: p.from.identifier, issueId: p.from.issueId } : undefined,
      alternatives: p.alternatives && p.alternatives.length ? p.alternatives : undefined,
      askedAt: new Date(this.now()).toISOString(),
    };
    const saved: IntakeDocument = {
      ...holder,
      revision: holder.revision + 1,
      updatedAt: pending.askedAt,
      pendingTicketAction: pending,
    };
    this.repo.saveRevision(saved);
    const title = p.target.title ? ` «${p.target.title}»` : "";
    const quoted = p.content ? `\n\n> ${capText(p.content, 500).replace(/\n/g, "\n> ")}` : "";
    const files = p.media.length ? `\n(kèm ${p.media.length} ảnh/tệp)` : "";
    let text: string;
    if (p.kind === "move") {
      text = `Dạ anh/chị xác nhận giúp em: chuyển toàn bộ nội dung ${p.from!.identifier} sang ${p.target.identifier}${title} và huỷ ${p.from!.identifier} (ticket trùng) nhé?`;
    } else if (p.kind === "cancel_ticket") {
      text = `Dạ anh/chị xác nhận giúp em hủy ticket ${p.target.identifier}${title} (chuyển sang Đã hủy) với nội dung dưới đây nhé? Nếu muốn giữ ticket thì bấm "${KEEP_TICKET_LABEL}" ạ.${quoted}${files}`;
    } else if (p.kind === "close_ticket") {
      text = `Dạ anh/chị xác nhận giúp em đóng ticket ${p.target.identifier}${title} (chuyển sang Hoàn tất) với nội dung dưới đây nhé? Nếu muốn giữ ticket thì bấm "${KEEP_TICKET_LABEL}" ạ.${quoted}${files}`;
    } else if (p.kind === "suggest" && p.lead) {
      const alts = p.alternatives?.length
        ? `\n\nAnh/chị còn ticket đang mở khác, nếu tin này thuộc ticket đó thì bấm đúng mã:\n${p.alternatives.map((a) => `- ${a.identifier}${a.title ? ` «${a.title}»` : ""}`).join("\n")}`
        : "";
      text = `${p.lead}${title} phải không ạ? Em sẽ ghi vào ${p.target.identifier}:${quoted}${files}${alts}\n\nAnh/chị bấm nút xác nhận để em ghi, hoặc "${NEW_INCIDENT_LABEL}" nếu là việc khác nhé.`;
    } else if (p.kind === "suggest") {
      text = `Dạ đây là thông tin trả lời cho ${p.target.identifier}${title} phải không ạ? Em sẽ ghi vào ${p.target.identifier}:${quoted}${files}\n\nNếu là sự cố khác thì anh/chị bấm "${NEW_INCIDENT_LABEL}" nhé.`;
    } else {
      text = `Dạ anh/chị xác nhận giúp em: bổ sung vào ${p.target.identifier}${title} nội dung sau nhé?${quoted}${files}`;
    }
    return this.packet(saved, "confirm_ticket_action", text, {
      buttons: ticketActionRows(pending),
    });
  }

  /**
   * Tin tới sau khi bot vừa tạo ticket cho chat này và không nói rõ thuộc đâu: hỏi bằng hai nút
   * "➕ Bổ sung vào TECH-X" / "Sự cố mới" (chỉ ghi khi bấm — ADR-0008).
   */
  private async askAboutCreatedTicket(
    doc: IntakeDocument,
    input: RunStepInput,
    message: string,
    media: string[],
    lead: string,
  ): Promise<IntakePacket> {
    const createdId = doc.issueIdentifier || `TECH-${doc.issueId}`;
    const created: ReplyCandidate = {
      identifier: createdId,
      issueId: doc.issueId!,
      title: doc.fields.title?.value,
      ownTicket: true,
      mentioned: false,
      justCreated: true,
    };
    // Người báo còn ticket đang mở khác (TECH-1001, 30/09: chị có 8 ticket, tin của TECH-989 bị ghi
    // vào ticket mới nhất): hiểu ý trước, rồi mỗi ticket đang mở có một nút riêng.
    const others = await this.otherOpenTickets(input.chatId, createdId);
    let primary = created;
    if (others.length > 0 && message && this.options.ticketCommands) {
      const command = await this.options.ticketCommands
        .interpret({ message, attachments: media.length, candidates: [created, ...others] })
        .catch(() => ({ action: "unclear" }) as TicketCommand);
      if (command.action === "append" || command.action === "cancel_or_close") {
        primary = [created, ...others].find((c) => c.identifier === command.identifier) ?? created;
      }
    }
    const alternatives = [created, ...others]
      .filter((c) => c.identifier !== primary.identifier)
      .slice(0, 3);
    return this.proposeTicketAction(doc, input, {
      kind: "suggest",
      target: primary,
      content: message,
      message,
      media,
      lead: primary.identifier === createdId ? lead : lead.replace(createdId, primary.identifier),
      alternatives: alternatives.map((c) => ({
        identifier: c.identifier,
        issueId: c.issueId,
        title: c.title,
      })),
    });
  }

  /** Ticket đang mở (chưa Done/Canceled) khác của chính chat này, mới nhất trước, tối đa 3. */
  private async otherOpenTickets(
    chatId: string,
    exceptIdentifier: string,
  ): Promise<ReplyCandidate[]> {
    const repo = this.options.bindingRepo;
    if (!repo) return [];
    const out: ReplyCandidate[] = [];
    for (const b of repo.listBindingsForChat(chatIdVariants(chatId), this.options.projectKey, 8)) {
      if (b.identifier === exceptIdentifier || out.length >= 3) continue;
      try {
        const issue = await this.options.itsaplan.getIssue(b.issueId);
        const stateType =
          issue.stateType ??
          (await this.options.itsaplan.listProjectColumns(this.options.projectKey)).find(
            (c) => c.id === issue.columnId,
          )?.stateType;
        if (stateType === "completed" || stateType === "canceled") continue;
        out.push({
          identifier: b.identifier,
          issueId: b.issueId,
          title: issue.title ?? b.title,
          ownTicket: true,
          mentioned: false,
        });
      } catch {
        // đọc lỗi → bỏ qua ticket này
      }
    }
    return out;
  }

  /** "sửa TECH-X …": LLM lập thao tác sửa, áp thử để xem trước, chờ người báo xác nhận. */
  private async proposeEdit(
    holder: IntakeDocument,
    input: RunStepInput,
    target: ReplyCandidate,
    instruction: string,
  ): Promise<IntakePacket> {
    try {
      const issue = await this.options.itsaplan.getIssue(target.issueId);
      const ops = this.options.editPlanner
        ? await this.options.editPlanner({
            title: issue.title,
            description: issue.description,
            instruction,
          })
        : this.options.llmConfig
          ? await planEdit(this.options.llmConfig, {
              title: issue.title,
              description: issue.description,
              instruction,
            })
          : [];
      const applied = applyEditOps(issue.title, issue.description, ops);
      if (applied.changes.length === 0) {
        if (isCancelOrCloseTicketRequest(instruction)) {
          return this.proposeCancelOrClose(holder, input, target, instruction, []);
        }
        return this.packet(
          holder,
          "post_create_update",
          `Dạ em chưa hiểu cần sửa gì trong ${target.identifier} ạ. Anh/chị ghi rõ giúp em, vd "sửa ${target.identifier} SĐT thành 09xxxxxxxx" hoặc "sửa ${target.identifier} mã đơn thành DHxxxxxx" nhé.`,
        );
      }
      const pending: NonNullable<IntakeDocument["pendingTicketAction"]> = {
        kind: "edit",
        identifier: target.identifier,
        issueId: target.issueId,
        content: instruction,
        message: instruction,
        mediaPaths: [],
        edit: {
          baseDescription: issue.description,
          baseTitle: issue.title,
          title: applied.title,
          description: applied.description,
          changes: applied.changes,
        },
        askedAt: new Date(this.now()).toISOString(),
      };
      const saved: IntakeDocument = {
        ...holder,
        revision: holder.revision + 1,
        updatedAt: pending.askedAt,
        pendingTicketAction: pending,
      };
      this.repo.saveRevision(saved);
      const lines = applied.changes
        .map((c) => `- ${c.what}: ${capText(c.before, 150)} → ${capText(c.after, 150)}`)
        .join("\n");
      return this.packet(
        saved,
        "confirm_ticket_action",
        `Dạ anh/chị xác nhận giúp em sửa ${target.identifier} như sau nhé?\n${lines}`,
        {
          buttons: ticketActionRows(pending),
        },
      );
    } catch (err: any) {
      getLogger().error(
        `[intake_step] Lập bản sửa ${target.identifier} lỗi: ${err?.message ?? err}`,
      );
      return {
        ...this.packet(
          holder,
          "post_create_update",
          `Dạ em chưa đọc được ${target.identifier} để sửa, anh/chị thử lại sau ít phút nhé.`,
        ),
        success: false,
      };
    }
  }

  /**
   * Phân loại trạng thái hiện tại của một issue trên Itsaplan ("open" | "resolved" | "done" | "canceled").
   */
  private resolveIssueState(issue: ItsaplanIssue, columns: ProjectColumn[]): TicketState {
    const col = columns.find((c) => c.id === issue.columnId);
    if (col) return classifyColumn(col);
    if (issue.stateType === "canceled") return "canceled";
    if (issue.stateType === "completed") return "done";
    return "open";
  }

  /**
   * Đếm số bình luận của chuyên viên (thành viên dự án, không phải bot/người báo) trên ticket.
   */
  private async countSpecialistComments(
    issueId: number,
    input: RunStepInput,
    doc?: IntakeDocument | null,
  ): Promise<number> {
    try {
      const timeline = await this.options.itsaplan.getIssueTimeline(issueId);
      const project =
        typeof this.options.itsaplan.getProject === "function"
          ? await this.options.itsaplan.getProject(this.options.projectKey).catch(() => null)
          : null;
      return countSpecialistTimelineComments(timeline, {
        reporterNames: [
          input.reporter?.name,
          input.reporter?.username,
          input.reporter?.nameCode,
          doc?.reporter?.name,
          doc?.reporter?.username,
          doc?.reporter?.nameCode,
        ],
        projectAssignees: project?.assignees,
      });
    } catch {
      return 0;
    }
  }

  /**
   * Đề xuất hủy hoặc đóng ticket của chính người báo (ADR-0006 cập nhật 10/10/2026):
   * - Đã Done/Canceled → không chuyển lại, báo lịch sự ticket đã đóng.
   * - Nói rõ "hủy/huỷ/bỏ/không cần nữa" → chuyển Cancelled (kind: "cancel_ticket").
   * - Nói "đóng" (không nói rõ hủy):
   *   + Đã ở cột Resolved hoặc có ≥ minSpecialistCommentsForDone (3) bình luận chuyên viên → chuyển Done (kind: "close_ticket").
   *   + Ngược lại (0, 1 hoặc 2 bình luận chuyên viên và chưa Resolved) → chuyển Cancelled (kind: "cancel_ticket").
   */
  private async proposeCancelOrClose(
    holder: IntakeDocument,
    input: RunStepInput,
    target: ReplyCandidate,
    content: string,
    media: string[],
    explicitIntent?: "cancel" | "close",
  ): Promise<IntakePacket> {
    try {
      const issue = await this.options.itsaplan.getIssue(target.issueId);
      if (
        !target.ownTicket &&
        !this.isOwnTicket(target.identifier, issue.description, chatIdVariants(input.chatId))
      ) {
        return this.packet(
          holder,
          "post_create_update",
          `Dạ ${target.identifier} không phải ticket anh/chị báo nên em không ghi vào được ạ. Anh/chị cần xem tình trạng thì nhắn "${target.identifier} tới đâu rồi" nhé.`,
        );
      }
      const columns = await this.options.itsaplan.listProjectColumns(this.options.projectKey);
      const currentState = this.resolveIssueState(issue, columns);
      if (currentState === "done" || currentState === "canceled") {
        const statusLabel = currentState === "done" ? "Hoàn tất (Done)" : "Đã hủy (Canceled)";
        return this.packet(
          holder,
          "post_create_update",
          `Dạ ticket ${target.identifier} hiện đã đóng ở trạng thái ${statusLabel} trên hệ thống rồi nên em không chuyển lại nữa ạ.`,
        );
      }
      const intent = explicitIntent ?? classifyCancelOrCloseIntent(content) ?? "cancel";
      const minComments =
        this.options.minSpecialistCommentsForDone ?? MIN_SPECIALIST_COMMENTS_FOR_DONE;
      let kind: "cancel_ticket" | "close_ticket" = "cancel_ticket";
      if (intent === "close") {
        const specialistComments = await this.countSpecialistComments(
          target.issueId,
          input,
          holder,
        );
        const hasSpecialistHandled =
          currentState === "resolved" || specialistComments >= minComments;
        if (hasSpecialistHandled) {
          kind = "close_ticket";
        }
      }
      return this.proposeTicketAction(holder, input, {
        kind,
        target: { ...target, title: target.title ?? issue.title },
        content,
        message: content,
        media,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      getLogger().error(
        `[intake_step] Lập bản xác nhận hủy/đóng ${target.identifier} lỗi: ${errMsg}`,
      );
      return {
        ...this.packet(
          holder,
          "post_create_update",
          `Dạ em chưa đọc được ${target.identifier} để kiểm tra trạng thái, anh/chị thử lại sau ít phút nhé.`,
        ),
        success: false,
      };
    }
  }

  /** Người báo trả lời bản xem trước: bấm xác nhận → ghi; bấm huỷ / giữ lại / nhắn việc khác → không ghi. */
  private async resolvePendingTicketAction(
    doc: IntakeDocument,
    input: RunStepInput,
    message: string,
    media: string[],
  ): Promise<IntakePacket> {
    const pending = doc.pendingTicketAction!;
    const said = normalizeButtonText(message);
    const cleared: IntakeDocument = {
      ...doc,
      revision: doc.revision + 1,
      pendingTicketAction: undefined,
    };
    if (said === normalizeButtonText(confirmLabel(pending))) {
      this.repo.saveRevision(cleared);
      return this.executeTicketAction(cleared, input, pending, media);
    }
    const alt = (pending.alternatives ?? []).find(
      (a) => said === normalizeButtonText(confirmLabel({ ...pending, identifier: a.identifier })),
    );
    if (alt) {
      this.repo.saveRevision(cleared);
      return this.executeTicketAction(
        cleared,
        input,
        { ...pending, identifier: alt.identifier, issueId: alt.issueId, alternatives: undefined },
        media,
      );
    }
    if (
      pending.kind === "suggest" &&
      (said === normalizeButtonText(NEW_INCIDENT_LABEL) || saysNewIncident(message))
    ) {
      this.repo.saveRevision(cleared);
      const base = CLOSED_STATUSES.has(cleared.status)
        ? this.freshDoc(doc.chatId, this.now())
        : cleared;
      return this.collect(
        base,
        input,
        withTypedDetail(pending.message, message),
        Array.from(new Set([...pending.mediaPaths, ...media])),
      );
    }
    const isCancelOrClosePending =
      pending.kind === "cancel_ticket" || pending.kind === "close_ticket";
    const isAbort = isCancelOrClosePending
      ? said === normalizeButtonText(KEEP_TICKET_LABEL) ||
        (!mentionedIdentifiers(message, this.options.projectKey).length &&
          /^(?:giữ\s+lại|thôi|bỏ\s+qua|không\s+(?:hủy|huỷ|đóng|cần|gửi|ghi)|đừng\s+(?:hủy|huỷ|đóng))(?:\s|$|[.,!])/iu.test(
            message.trim(),
          ))
      : said === normalizeButtonText(CANCEL_ACTION_LABEL) ||
        (!mentionedIdentifiers(message, this.options.projectKey).length &&
          isCancelLike(message.toLowerCase()));
    if (isAbort) {
      this.repo.saveRevision(cleared);
      const abortVoice = isCancelOrClosePending
        ? `Dạ vâng, em giữ nguyên ${pending.identifier}, không đổi trạng thái ticket ạ.`
        : `Dạ vâng, em không ghi gì vào ${pending.identifier} ạ.`;
      return this.packet(cleared, "canceled", abortVoice);
    }
    // Đang chờ bổ sung ("append") mà lượt trước mới chỉ là câu lệnh trần ("update vào tick TECH-1218")
    // chưa có nội dung/ảnh, hoặc người báo gửi tiếp ảnh đính kèm trước khi bấm nút xác nhận:
    // gộp ảnh/nội dung vào bản xem trước thay vì xoá mất.
    const hasMentions = mentionedIdentifiers(message, this.options.projectKey).length > 0;
    if (pending.kind === "append" && !hasMentions) {
      const waitingForPayload = !pending.content.trim() && pending.mediaPaths.length === 0;
      if ((waitingForPayload && (message || media.length > 0)) || (!message && media.length > 0)) {
        const nextContent = withTypedDetail(pending.content, message);
        const nextMedia = Array.from(new Set([...pending.mediaPaths, ...media]));
        return this.proposeTicketAction(cleared, input, {
          kind: "append",
          target: {
            identifier: pending.identifier,
            issueId: pending.issueId,
            ownTicket: true,
            mentioned: true,
          },
          content: nextContent,
          message: nextContent,
          media: nextMedia,
        });
      }
    }
    // Nhắn việc khác thay vì bấm nút: bỏ bản xem trước (không ghi), xử lý tin mới như thường.
    // Riêng gợi ý bổ sung (tin đang chờ có thể chính là sự cố mới) thì hỏi lại cho rõ; nếu lượt này
    // có gửi kèm ảnh thì lưu ảnh vào pending để khi bấm "Bổ sung" hay "Sự cố mới" đều không bị rớt ảnh.
    if (pending.kind === "suggest" && !hasMentions) {
      if (media.length > 0) {
        const nextMedia = Array.from(new Set([...pending.mediaPaths, ...media]));
        const updatedPending: NonNullable<IntakeDocument["pendingTicketAction"]> = {
          ...pending,
          mediaPaths: nextMedia,
        };
        const updatedDoc: IntakeDocument = {
          ...doc,
          revision: doc.revision + 1,
          updatedAt: new Date(this.now()).toISOString(),
          pendingTicketAction: updatedPending,
        };
        this.repo.saveRevision(updatedDoc);
        return this.packet(
          updatedDoc,
          "confirm_ticket_action",
          `Dạ anh/chị bấm giúp em một nút phía trên để em ghi đúng chỗ (đã nhận kèm ${nextMedia.length} ảnh/tệp) nhé ạ.`,
          { buttons: ticketActionRows(updatedPending) },
        );
      }
      return this.packet(
        doc,
        "confirm_ticket_action",
        `Dạ anh/chị bấm giúp em một nút phía trên để em ghi đúng chỗ nhé ạ.`,
        {
          buttons: ticketActionRows(pending),
        },
      );
    }
    this.repo.saveRevision(cleared);
    getLogger().info(
      `[pipeline] Chat ${input.chatId}: bỏ bản xem trước cho ${pending.identifier} (người báo nhắn việc khác).`,
    );
    // Nếu bản xem trước vừa bỏ đang giữ ảnh của người báo (vd người báo gửi ảnh trước rồi mới gõ
    // "update vào tick TECH-1218"), bảo toàn danh sách ảnh này sang lượt định tuyến kế tiếp.
    const supp = stripSupplementCommandWrapper(message);
    const preservePendingPayload =
      (pending.kind === "suggest" || pending.kind === "append") &&
      !isCancelOrCloseTicketRequest(message) &&
      (supp.isSupplementCommand ||
        mentionedIdentifiers(message, this.options.projectKey).includes(pending.identifier));
    const nextMedia = preservePendingPayload
      ? Array.from(new Set([...pending.mediaPaths, ...media]))
      : media;
    const nextMessage =
      preservePendingPayload && supp.isSupplementCommand && !supp.content && pending.content.trim()
        ? `${message}: ${pending.content.trim()}`
        : message;
    return this.step({ ...input, message: nextMessage, mediaPaths: nextMedia });
  }

  private async executeTicketAction(
    doc: IntakeDocument,
    input: RunStepInput,
    pending: NonNullable<IntakeDocument["pendingTicketAction"]>,
    extraMedia: string[],
  ): Promise<IntakePacket> {
    const who = input.reporter?.name?.trim() || doc.reporter?.name || "Người báo";
    const id = pending.identifier;
    try {
      if (pending.kind === "edit" && pending.edit) {
        const current = await this.options.itsaplan.getIssue(pending.issueId);
        if (
          current.description !== pending.edit.baseDescription ||
          current.title !== pending.edit.baseTitle
        ) {
          return this.packet(
            doc,
            "post_create_update",
            `Dạ ${id} vừa được cập nhật sau khi em lập bản sửa, anh/chị gửi lại đề nghị sửa giúp em nhé.`,
          );
        }
        await this.options.itsaplan.updateIssue(pending.issueId, {
          title: pending.edit.title !== current.title ? pending.edit.title : undefined,
          description:
            pending.edit.description !== current.description ? pending.edit.description : undefined,
        });
        const lines = pending.edit.changes
          .map((c) => `- ${c.what}: ${c.before} → ${c.after}`)
          .join("\n");
        await this.options.itsaplan.addComment(
          pending.issueId,
          markBotComment(`✏️ Đã sửa theo đề nghị của **${who}**:\n${lines}`),
        );
        return this.packet(doc, "post_create_update", `Dạ em đã sửa ${id} rồi ạ.`);
      }
      if (pending.kind === "move" && pending.from) {
        const src = await this.options.itsaplan.getIssue(pending.from.issueId);
        const { body, images } = descriptionBody(src.description);
        await this.options.itsaplan.addComment(
          pending.issueId,
          markBotComment(
            `🔀 **${who}** xác nhận ${pending.from.identifier} là bổ sung cho ticket này — nội dung chuyển sang:\n${body}${images.length ? `\n\n${images.join("\n\n")}` : ""}`,
          ),
        );
        await this.options.itsaplan
          .linkIssues(pending.from.issueId, pending.issueId, "duplicates")
          .catch(() => undefined);
        await this.options.itsaplan.addComment(
          pending.from.issueId,
          markBotComment(
            `ℹ️ Ticket này trùng ${id}: **${who}** xác nhận đây là bổ sung cho ${id}, nội dung đã chuyển sang ${id}. Tiểu Linh huỷ bản trùng (ADR-0008).`,
          ),
        );
        const cancel = (
          await this.options.itsaplan.listProjectColumns(this.options.projectKey)
        ).find((c) => c.stateType === "canceled");
        if (cancel)
          await this.options.itsaplan.updateIssue(pending.from.issueId, { columnId: cancel.id });
        // Tờ khai của ticket vừa tạo coi như đã huỷ: bổ sung sau không trôi vào bản trùng nữa.
        if (doc.issueIdentifier === pending.from.identifier) {
          this.repo.saveRevision({
            ...doc,
            revision: doc.revision + 1,
            status: "canceled",
            updatedAt: new Date(this.now()).toISOString(),
          });
        }
        return this.packet(
          doc,
          "post_create_update",
          `Dạ em đã chuyển nội dung ${pending.from.identifier} sang ${id} và huỷ ${pending.from.identifier} rồi ạ.`,
        );
      }
      if (pending.kind === "cancel_ticket" || pending.kind === "close_ticket") {
        const issue = await this.options.itsaplan.getIssue(pending.issueId);
        if (!this.isOwnTicket(id, issue.description, chatIdVariants(input.chatId))) {
          return this.packet(
            doc,
            "post_create_update",
            `Dạ ${id} không phải ticket anh/chị báo nên em không ghi vào được ạ. Anh/chị cần xem tình trạng thì nhắn "${id} tới đâu rồi" nhé.`,
          );
        }
        const columns = await this.options.itsaplan.listProjectColumns(this.options.projectKey);
        const currentState = this.resolveIssueState(issue, columns);
        if (currentState === "done" || currentState === "canceled") {
          const statusLabel = currentState === "done" ? "Hoàn tất (Done)" : "Đã hủy (Canceled)";
          return this.packet(
            doc,
            "post_create_update",
            `Dạ ticket ${id} hiện đã đóng ở trạng thái ${statusLabel} trên hệ thống rồi nên em không chuyển lại nữa ạ.`,
          );
        }
        const minComments =
          this.options.minSpecialistCommentsForDone ?? MIN_SPECIALIST_COMMENTS_FOR_DONE;
        // Chốt chặn an toàn tuyệt đối: chỉ chuyển Done khi pending.kind === "close_ticket" VÀ thỏa điều kiện chuyên viên xử lý.
        let moveToDone = false;
        if (pending.kind === "close_ticket") {
          const specialistComments = await this.countSpecialistComments(
            pending.issueId,
            input,
            doc,
          );
          moveToDone = currentState === "resolved" || specialistComments >= minComments;
        }
        const targetCol = moveToDone
          ? columns.find((c) => classifyColumn(c) === "done")
          : (columns.find((c) => classifyColumn(c) === "canceled") ??
            columns.find((c) => c.stateType === "canceled"));
        if (!targetCol) {
          throw new Error(
            `Không tìm thấy cột ${moveToDone ? "Done" : "Canceled"} trong dự án ${this.options.projectKey}`,
          );
        }
        await this.options.itsaplan.updateIssue(pending.issueId, { columnId: targetCol.id });

        const media = Array.from(new Set([...pending.mediaPaths, ...extraMedia]));
        const parts: string[] = [];
        const reason = pending.content || pending.message;
        if (reason) parts.push(escapeItsaplanMarkdown(capText(reason, MAX_FOLLOW_UP_CHARS)));
        if (media.length > 0) {
          const uploaded = await uploadAttachments(
            this.options.itsaplan,
            pending.issueId,
            this.options.itsaplanBaseUrl ?? "",
            media,
          );
          for (const att of uploaded)
            parts.push(escapeItsaplanMarkdown(formatAttachmentMarkdown(att)));
        }
        const requestedActionLabel =
          (classifyCancelOrCloseIntent(reason) ??
            (pending.kind === "close_ticket" ? "close" : "cancel")) === "close"
            ? "đóng"
            : "hủy";
        const targetStateLabel = moveToDone ? "Done" : "Canceled";
        const icon = moveToDone ? "✅" : "🛑";
        await this.options.itsaplan.addComment(
          pending.issueId,
          markBotComment(
            `${icon} **${escapeItsaplanMarkdown(who)}** yêu cầu ${requestedActionLabel} ticket → chuyển **${targetStateLabel}**.\nLý do: ${parts.join("\n\n")}`,
          ),
        );
        if (doc.issueIdentifier === id && doc.status === "created") {
          this.repo.saveRevision({
            ...doc,
            revision: doc.revision + 1,
            status: "canceled",
            updatedAt: new Date(this.now()).toISOString(),
          });
        }
        getLogger().info(
          `[pipeline] Chat ${input.chatId}: đã chuyển ${id} sang ${targetStateLabel} (đã xác nhận).`,
        );
        const draftNote =
          !CLOSED_STATUSES.has(doc.status) && hasDescription(doc) && doc.fields.title?.value
            ? ` Sự cố «${doc.fields.title.value}» anh/chị đang báo dở em vẫn giữ nguyên nhé.`
            : "";
        const replyStateVi = moveToDone ? "đóng (Hoàn tất)" : "hủy (Đã hủy)";
        return this.packet(
          doc,
          "post_create_update",
          `Dạ em đã ${replyStateVi} ticket ${id} và ghi chú lý do trên hệ thống rồi ạ.${draftNote}`,
        );
      }
      // append / suggest
      const media = Array.from(new Set([...pending.mediaPaths, ...extraMedia]));

      // W29-NOTIFY (06/10/2026): Kiểm tra ticket đã đóng hay chưa trước khi ghi bổ sung
      const targetIssue = await this.options.itsaplan.getIssue(pending.issueId);
      const columns = await this.options.itsaplan.listProjectColumns(this.options.projectKey);
      const targetState = this.resolveIssueState(targetIssue, columns);
      if (targetState === "done" || targetState === "canceled") {
        const statusLabel = targetState === "done" ? "Hoàn tất (Done)" : "Đã hủy (Canceled)";
        return this.packet(doc, "post_create_update", closedTicketRefusalMessage(id, statusLabel));
      }

      const textContent = pending.content.trim();
      if (!textContent && media.length === 0) {
        return this.packet(
          doc,
          "clarify_intent",
          `Dạ anh/chị gửi ảnh chụp màn hình hoặc nội dung cần bổ sung vào ${id} giúp em nhé ạ.`,
        );
      }
      if (doc.status === "created" && doc.issueId === pending.issueId) {
        const extractSource = pending.message || textContent;
        const extracted = await this.options.extractor.extract(extractSource, this.contextOf(doc), {
          createdTicket: { identifier: id, title: doc.fields.title?.value },
        });
        return this.appendFollowUp(doc, extracted, textContent, media);
      }
      const parts: string[] = [];
      if (textContent) parts.push(capText(textContent, MAX_FOLLOW_UP_CHARS));
      if (media.length > 0) {
        const uploaded = await uploadAttachments(
          this.options.itsaplan,
          pending.issueId,
          this.options.itsaplanBaseUrl ?? "",
          media,
        );
        for (const att of uploaded) parts.push(formatAttachmentMarkdown(att));
      }
      // Người báo xin gấp kèm lý do trong tin bổ sung (thay cho tool escalate_issue cũ tự nâng mức
      // không hỏi): đã xác nhận ghi thì nâng mức ngay, lý do vào comment (user chốt 29/09).
      if (pending.message) {
        const asked = await this.options.extractor
          .extract(pending.message, this.contextOf(doc), { createdTicket: { identifier: id } })
          .catch(() => null);
        if (asked?.requestedPriority && asked.requestedPriorityReason) {
          const target = await this.options.itsaplan.getIssue(pending.issueId);
          const current = toPriorityLevel(target.priority ?? undefined);
          if (PRIORITY_ORDER[asked.requestedPriority] > PRIORITY_ORDER[current]) {
            await this.options.itsaplan.updateIssue(pending.issueId, {
              priority: asked.requestedPriority,
            });
            parts.push(
              `⏫ Nâng mức ưu tiên ${PRIORITY_LABEL[current]} → ${PRIORITY_LABEL[asked.requestedPriority]} theo đề nghị của người báo. Lý do: ${asked.requestedPriorityReason}`,
            );
          }
        }
      }
      let mentionUsername: string | null = null;
      const mention = await resolveSupplementMentionTarget({
        client: this.options.itsaplan,
        projectKey: this.options.projectKey,
        issue: targetIssue,
        reporterNames: [who, input.reporter?.name, doc.reporter?.name],
      }).catch(() => null);
      mentionUsername = mention?.username ?? null;

      const commentBody = formatSupplementComment({
        who,
        parts,
        mention: mentionUsername,
        style: "who_supplement",
      });
      await this.options.itsaplan.addComment(pending.issueId, commentBody);
      if (this.options.notifier) {
        await notifyOnCallSupplement({
          notifier: this.options.notifier,
          identifier: id,
          summary: parts.join(" "),
        }).catch(() => {});
      }
      getLogger().info(`[pipeline] Chat ${input.chatId}: đã ghi bổ sung (đã xác nhận) vào ${id}.`);
      const draftNote =
        !CLOSED_STATUSES.has(doc.status) && hasDescription(doc) && doc.fields.title?.value
          ? ` Sự cố «${doc.fields.title.value}» anh/chị đang báo dở em vẫn giữ nguyên nhé.`
          : "";
      return this.packet(
        doc,
        "post_create_update",
        `Dạ em đã ghi vào ${id} cho đội Kỹ thuật rồi ạ.${draftNote}`,
      );
    } catch (err: any) {
      getLogger().error(`[intake_step] Ghi ${pending.kind} vào ${id} lỗi: ${err?.message ?? err}`);
      return {
        ...this.packet(
          doc,
          "post_create_update",
          `Dạ em chưa ghi được vào ${id} do hệ thống đang trục trặc, anh/chị gửi lại giúp em sau ít phút nhé.`,
        ),
        success: false,
      };
    }
  }

  /** Tra cứu: ticket của mình thấy đủ; ticket người khác chỉ thấy trạng thái (ADR-0008 quyết định 6). */
  private async lookupTicket(
    holder: IntakeDocument,
    target: ReplyCandidate,
  ): Promise<IntakePacket> {
    try {
      const issue = await this.options.itsaplan.getIssue(target.issueId);
      const column = (await this.options.itsaplan.listProjectColumns(this.options.projectKey)).find(
        (c) => c.id === issue.columnId,
      );
      const status = column?.name ?? "chưa rõ";
      if (!target.ownTicket) {
        return this.packet(
          holder,
          "lookup_result",
          `Dạ ${target.identifier} đang ở trạng thái: ${status} ạ.`,
        );
      }
      const last = await this.lastTechComment(target.issueId);
      const lastLine = last
        ? `\nTrao đổi gần nhất của kỹ thuật: "${capText(stripMarkdownNoise(last), 300)}"`
        : "";
      return this.packet(
        holder,
        "lookup_result",
        `Dạ ${target.identifier} «${issue.title}» đang ở trạng thái: ${status} ạ.${lastLine}`,
      );
    } catch {
      return this.packet(
        holder,
        "lookup_result",
        `Dạ em chưa tra được ${target.identifier}, anh/chị thử lại sau ít phút nhé.`,
      );
    }
  }

  /** Comment gần nhất của người thật (kỹ thuật) trên ticket — câu hỏi vừa chuyển cho người báo. */
  private async lastTechComment(issueId: number): Promise<string | undefined> {
    try {
      const timeline = await this.options.itsaplan.getIssueTimeline(issueId);
      const human = timeline.filter(
        (e: any) => e.kind === "comment" && e.body && !isSystemActor(e.actorName),
      );
      return human.length ? String(human[human.length - 1].body) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Tra ticket tương tự (KG + Onyx + BM25 + LLM xác minh từng cặp) — một lần
   * mỗi tài liệu, chạy NỀN sau khi ticket đã tạo (xem createTicket) để không
   * chặn câu trả lời cho người dùng. Best-effort:
   * - Điền Related Tickets + link native (linkSimilarTickets, chỉ cụm KG).
   * - Ghi COMMENT riêng của bot nếu có nguyên nhân/cách khắc phục người viết,
   *   hoặc câu hỏi phân biệt khi mơ hồ (≥ 2 cụm). KHÔNG ghi vào mô tả — mô tả
   *   là lời nguyên văn của người báo (xem TECH-1084).
   * - Ghi lại vào tài liệu (kgAdvice/similarTickets) NẾU chưa có hoạt động nào
   *   khác trên chat từ lúc tạo ticket tới lúc việc nền này xong (tránh ghi đè
   *   dữ liệu mới hơn — ví dụ người dùng đã bổ sung comment).
   */
  private async runSimilarTicketsInBackground(
    createdDoc: IntakeDocument,
    createdIssue: { id: number; identifier: string },
    input: RunStepInput,
  ): Promise<void> {
    // Kích hoạt cổng ticket-similar thời gian thực 127.0.0.1:8140 (non-blocking, nuốt lỗi để không ảnh hưởng Telegram bot)
    fetch("http://127.0.0.1:8140/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket_id: createdIssue.identifier,
        issue_id: createdIssue.id,
      }),
    }).catch(() => null);
    const source = this.options.similarTickets;
    if (!source) return;
    const text = [createdDoc.fields.title?.value, ...(createdDoc.fields.symptoms?.value ?? [])]
      .filter(Boolean)
      .join("\n");
    if (text.trim().length < 5) return;

    const excludeIds = [input.excludeIdentifier, createdDoc.issueIdentifier].filter(
      (x): x is string => Boolean(x),
    );
    getLogger().info(`[pipeline] Tra ticket tương tự nền cho ${createdIssue.identifier}…`);
    const match = await source.find(text, { excludeIds });
    if (!match) {
      getLogger().info(
        `[pipeline] ${createdIssue.identifier}: không có ticket tương tự đủ tự tin.`,
      );
      return;
    }

    const kgItems: SimilarTicketItem[] = match.members.map((m) => ({
      identifier: m.identifier,
      title: m.title,
      rootCause: m.humanCause,
      resolution: m.humanFix,
      score: m.score,
      verifiedOnTracker: true,
      source: "kg",
    }));
    const kgIds = new Set(kgItems.map((t) => t.identifier.toUpperCase()));
    // Onyx vẫn giữ để xem trong phiên, nhưng xếp sau và không bao giờ được ghi vào ticket.
    const mergedTickets = [
      ...kgItems,
      ...createdDoc.similarTickets.filter((t) => !kgIds.has(t.identifier.toUpperCase())),
    ];

    let kgAdvice: string | undefined;
    if (match.advice) {
      const others = match.members.length - 1;
      const cause = cleanAdvice(match.advice.cause, 140);
      const fix = cleanAdvice(match.advice.fix, 160);
      kgAdvice =
        `- Nguyên nhân thường gặp: ${cause}. Cách khắc phục: ${fix} ` +
        `(theo ${match.advice.from}${others > 0 ? ` và ${others} ticket cùng nguyên nhân` : ""}).`;
    }
    // Cụm "có thể liên quan nhưng chưa chắc" (TECH-956) — KHÔNG bao giờ ghi Related
    // Tickets/link (đã chốt ở kgItems/linkSimilarTickets phía trên, match.members luôn
    // rỗng ở đây), chỉ hiển thị rõ nhãn "chưa chắc" trong Chẩn đoán & Gợi ý.
    if (match.possible && match.possible.length > 0) {
      const possibleLines = match.possible.map((p) => {
        const cause = p.cause ? cleanAdvice(p.cause, 140) : undefined;
        const examples = p.sampleIds.slice(0, 3).join(", ");
        return (
          `- Có thể liên quan (chưa chắc): ${cause ?? "chưa xác định nguyên nhân"}` +
          `${examples ? ` (vd: ${examples})` : ""}.`
        );
      });
      kgAdvice = kgAdvice ? `${kgAdvice}\n${possibleLines.join("\n")}` : possibleLines.join("\n");
    }
    if (match.question) {
      const questionLine = `- Chưa chắc chắn nguyên nhân (nhiều khả năng giống triệu chứng): ${match.question}`;
      kgAdvice = kgAdvice ? `${kgAdvice}\n${questionLine}` : questionLine;
    }

    if (kgItems.length > 0) {
      await this.linkSimilarTickets({ ...createdDoc, similarTickets: mergedTickets }, createdIssue);
    }

    if (kgAdvice) {
      try {
        // Gợi ý KG nằm ở COMMENT riêng, không viết vào mô tả (TECH-1084): mô tả
        // là lời nguyên văn của người báo, gộp suy luận của bot vào đó thì đội
        // kỹ thuật không phân biệt được đâu là lời người, đâu là AI đoán.
        const advice = buildAdviceComment(undefined, kgAdvice);
        if (advice) {
          await this.options.itsaplan.addComment(createdIssue.id, markBotComment(advice));
        }
      } catch (err: any) {
        getLogger().warn(
          `[pipeline] Không ghi được gợi ý KG cho ${createdIssue.identifier}: ${err?.message ?? err}`,
        );
      }
    }

    // Ghi lại vào tài liệu CHỈ KHI chưa có hoạt động nào khác từ lúc tạo ticket —
    // tránh việc nền chậm ghi đè lên revision mới hơn (vd người dùng đã bổ sung).
    const latest = this.repo.getLatestByChatId(createdDoc.chatId);
    if (latest && latest.docId === createdDoc.docId && latest.revision === createdDoc.revision) {
      this.repo.saveRevision({
        ...latest,
        similarTickets: mergedTickets,
        kgAdvice,
        kgChecked: true,
      });
    }
    getLogger().info(
      `[pipeline] ${createdIssue.identifier}: đã tra ticket tương tự nền (${kgItems.length} ticket, gợi ý=${kgAdvice ? "có" : "không"}).`,
    );
  }

  /** Test hook: chờ mọi việc nền (tra ticket tương tự sau khi tạo) chạy xong. Không dùng ở production. */
  async flushBackgroundForTests(): Promise<void> {
    const pending = this.pendingBackground.splice(0, this.pendingBackground.length);
    await Promise.allSettled(pending);
  }

  /**
   * Điền Related Tickets + link native tới ticket tương tự. Best-effort.
   * CHỈ ghi cụm nguyên nhân từ Knowledge Graph (ADR-0007). Kết quả Onyx "đã xác
   * thực" chỉ nghĩa là ticket tồn tại, không phải cùng nguyên nhân — ghi nó vào
   * là đẩy việc gỡ tay sang tech lead (TECH-920, 26/09).
   */
  private async linkSimilarTickets(
    doc: IntakeDocument,
    createdIssue: { id: number; identifier: string },
  ): Promise<void> {
    const client = this.options.itsaplan;
    try {
      const trusted = doc.similarTickets.filter((t) => t.source === "kg" && t.verifiedOnTracker);
      const relatedKeys = trusted.map((t) => t.identifier);
      if (relatedKeys.length === 0) return;
      const customFields = await client.listCustomFields(this.options.projectKey).catch(() => []);
      const relatedField = customFields.find((f) => /related.*ticket/i.test(f.name ?? ""));
      if (relatedField) {
        await client.setCustomFieldValue(createdIssue.id, relatedField.id, relatedKeys.join(", "));
      }
      for (const cand of trusted) {
        const targetIssue = await findIssueByIdentifier(client, cand.identifier);
        if (targetIssue && targetIssue.id !== createdIssue.id) {
          try {
            await client.addLink(createdIssue.id, targetIssue.id, "relates");
            getLogger().info(
              `[pipeline] Đã tạo native link: ${createdIssue.identifier} -[relates]-> ${targetIssue.identifier}`,
            );
          } catch (linkErr: any) {
            getLogger().warn(
              `[pipeline] Không thể tạo native link giữa ${createdIssue.identifier} và ${targetIssue.identifier}: ${linkErr.message}`,
            );
          }
        }
      }
    } catch {
      // Bỏ qua lỗi custom fields / links nếu không ảnh hưởng tạo vé
    }
  }

  private describe(doc: IntakeDocument): string {
    let title = doc.fields.title?.value || "Sự cố kỹ thuật";
    // Chốt chặn: KHÔNG BAO GIỜ để tiêu đề là tên người hoặc mã trần (TECH-1146)
    if (isInvalidTitle(title, doc.fields.rawText?.value)) {
      title = deriveFallbackTitle(doc.fields.rawText?.value || "", doc.fields.symptoms?.value);
      if (isInvalidTitle(title)) title = "Sự cố kỹ thuật";
    }

    return formatTicketDescription({
      incident: {
        title,
        product: doc.fields.product?.value ?? "Khác",
        system: doc.fields.system?.value ?? UNKNOWN_SYSTEM,
        errorCategory: doc.fields.errorCategory?.value,
        reportingDept: doc.fields.reportingDept?.value ?? UNKNOWN_DEPT,
        priority: toPriorityLevel(doc.fields.priority?.value),
        priorityReason:
          doc.requestedPriority?.reason && doc.fields.priority?.source === "user_message"
            ? `${doc.requestedPriority.reason} (xin mức ${PRIORITY_LABEL[doc.requestedPriority.level]})`
            : undefined,
        customerId: doc.fields.customerId?.value,
        studentAccount: doc.fields.studentAccount?.value,
        roomCode: doc.fields.roomCode?.value,
        deviceType: doc.fields.deviceType?.value,
        deviceOs: doc.fields.deviceOs?.value,
        appVersion: doc.fields.appVersion?.value,
        browser: doc.fields.browser?.value,
        transactionId: doc.fields.transactionId?.value,
        assignmentId: doc.fields.assignmentId?.value,
        symptoms: capText(this.symptomsText(doc), MAX_DESCRIPTION_SYMPTOMS_CHARS),
        // Lời kể GỐC của người báo (không phải bản LLM paraphrase) — bắt buộc
        // để groundIdentifierFields đối chiếu đúng nguồn, xem TECH-956.
        rawText: doc.fields.rawText?.value,
        // merger.ts đã gộp MỌI lượt vào rawText, nên ở đường này hai trường
        // trùng nhau — đặt để `groundIdentifierFields` và văn bản tra cứu có
        // nguồn rõ ràng (xem TECH-1084).
        reporterText: doc.fields.rawText?.value,
        mediaAmbiguous: doc.mediaAmbiguous,
      },
      reporter: doc.reporter
        ? {
            name: doc.reporter.name || "Người dùng",
            username: doc.reporter.username,
            telegramId: doc.reporter.telegramId,
          }
        : undefined,
      sourceName: "Tiểu Linh (Voice Intake)",
    });
  }

  private gateValues(doc: IntakeDocument): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc.fields)) {
      if (v?.value === undefined || v?.value === null) continue;
      if (k === "symptoms" && Array.isArray(v.value)) {
        values.symptoms = v.value.join("\n");
        values.description = v.value.join("\n");
        values.short_description = doc.fields.title?.value || v.value[0] || "";
      } else if (k === "mediaPaths" && Array.isArray(v.value)) {
        if (v.value.length > 0) values.screenshot_url = v.value.join(", ");
      } else {
        values[camelToSnake(k)] = String(v.value);
      }
    }
    return values;
  }

  private variantOf(values: Record<string, string>): string {
    const { key: productKey } = inferProductKey(values, this.options.productMapping);
    const combinedDesc =
      `${values.raw_text || ""} ${values.description || ""} ${values.short_description || ""}`.toLowerCase();
    const isAccountOrClassIssue = [
      "phụ huynh",
      "học sinh",
      "báo vắng",
      "điểm danh",
      "mất khóa",
      "tài khoản",
      "buổi học",
      "crm",
    ].some((kw) => combinedDesc.includes(kw));
    const hasPhoneOrAccount =
      Boolean(values.student_account?.trim()) ||
      Boolean(values.customer_id?.trim()) ||
      /(0\d{9,10}|\b\d{9,11}\b)/.test(combinedDesc);
    return isAccountOrClassIssue && !hasPhoneOrAccount ? `${productKey}+account` : productKey;
  }

  private symptomsText(doc: IntakeDocument): string {
    return doc.fields.symptoms?.value?.join("\n") || doc.fields.title?.value || "";
  }

  private contextOf(doc: IntakeDocument): string | undefined {
    const asked =
      doc.lastAskedFields?.includes(TECH_INFO_FIELD) && doc.techQuestion
        ? `(Tiểu Linh vừa hỏi người báo: "${doc.techQuestion}" — tin mới là câu trả lời, tức "provide_info".)`
        : undefined;
    const parts = [doc.fields.title?.value, doc.fields.symptoms?.value?.join("\n"), asked].filter(
      Boolean,
    );
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private techReviewInput(doc: IntakeDocument): TechReviewInput {
    const f = doc.fields;
    // Nguyên văn lời kể (rawText), không phải triệu chứng LLM đã viết lại — bản viết lại
    // có thể rơi mất mã đơn (test E2E 29/09: DH900007 có trong tin mà vẫn bị hỏi lại).
    const said = [f.rawText?.value, this.symptomsText(doc)].filter(Boolean).join("\n");
    return {
      title: f.title?.value,
      description: f.rawText?.value || this.symptomsText(doc),
      system: f.system?.value,
      product: f.product?.value,
      attachments: f.mediaPaths?.value?.length ?? 0,
      known: {
        "Tài khoản HS / SĐT": f.studentAccount?.value ?? "",
        "Mã khách hàng": f.customerId?.value ?? "",
        "Mã giao dịch": f.transactionId?.value ?? "",
        "Mã bài tập": f.assignmentId?.value ?? "",
        "Mã phòng": f.roomCode?.value ?? "",
        "Thiết bị": [f.deviceType?.value, f.deviceOs?.value, f.appVersion?.value, f.browser?.value]
          .filter(Boolean)
          .join(", "),
        // Mã đơn / link đã nằm trong lời báo — nêu rõ để LLM khỏi hỏi lại (test E2E 29/09:
        // lời báo có DH900006 mà vẫn bị hỏi "cho em xin mã đơn hàng").
        "Mã đơn hàng": [...new Set(said.match(/\bDH\d{4,}\b/gi) ?? [])].join(", "),
        Link: [...new Set(said.match(/https?:\/\/\S+/g) ?? [])].join(" "),
      },
    };
  }

  private ttl(): number {
    return this.options.draftTtlMs ?? INTAKE_DRAFT_TTL_MS;
  }

  private isExpired(doc: IntakeDocument, now: number): boolean {
    const t = Date.parse(doc.updatedAt);
    return !Number.isNaN(t) && now - t > this.ttl();
  }

  private freshDoc(chatId: string, now: number): IntakeDocument {
    const iso = new Date(now).toISOString();
    return {
      docId: `doc_tl_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      chatId,
      revision: 0,
      status: "collecting",
      currentTurn: 0,
      fields: {},
      evidence: {},
      askedCount: {},
      similarTickets: [],
      createdAt: iso,
      updatedAt: iso,
    };
  }

  private issueOf(doc: IntakeDocument): IntakePacket["issue"] {
    if (!doc.issueId) return undefined;
    return {
      id: doc.issueId,
      identifier: doc.issueIdentifier || `TECH-${doc.issueId}`,
      title: doc.fields.title?.value || "",
      url: doc.issueUrl,
    };
  }

  private packet(
    doc: IntakeDocument,
    action: IntakeNextAction,
    voiceText: string,
    extra: Partial<
      Pick<IntakePacket, "displayMarkdown" | "missingFields" | "buttons" | "issue">
    > = {},
  ): IntakePacket {
    return {
      success: true,
      docId: doc.docId,
      chatId: doc.chatId,
      revision: doc.revision,
      status: doc.status,
      action,
      voiceText,
      displayMarkdown: extra.displayMarkdown ?? voiceText,
      missingFields: extra.missingFields ?? [],
      buttons: extra.buttons,
      issue: extra.issue,
      similarTickets: doc.similarTickets,
      document: doc,
    };
  }
}

/** Làm gọn gợi ý kinh nghiệm: bỏ nhãn, link, markdown; cắt ở ranh giới từ. */
function cleanAdvice(text: string, maxLen = 140): string {
  let s = text
    .replace(/(?:nguyên\s*nhân|giải\s*pháp|cách\s*(?:khắc\s*phục|xử\s*lý))\s*[:\-–]\s*/gi, "")
    .replace(/https?:\/\/[^\s]+/g, "") // Bỏ link docs/sheets rác
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > 50 ? cut.slice(0, lastSpace) : cut) + "...";
  }
  return s;
}
