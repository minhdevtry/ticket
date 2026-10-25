/**
 * Lệnh nhắm vào ticket ĐÃ CÓ trong luồng chat một-người (ADR-0008).
 *
 * Người báo chỉ có một luồng chat mà thường có nhiều việc (27% từng có ≥ 2 ticket mở,
 * TECH-795 → TECH-975: câu trả lời cho kỹ thuật bị tách thành ticket mới). Cú pháp rõ
 * ràng, không bắt buộc: "bổ sung/sửa TECH-X …", "TECH-X" (tra cứu), "/new". LLM đọc
 * tin để hiểu người báo muốn gì với ticket nào — nhưng KHÔNG BAO GIỜ tự ghi: mọi lần
 * bổ sung / sửa / gộp đều qua bản xem trước + nút xác nhận ở pipeline.
 *
 * Ứng viên: ticket được nhắc mã trong tin, ticket kỹ thuật vừa hỏi người báo
 * (message_routes do worker ghi), ticket vừa tạo ở chat này (để "cái này bổ sung cho
 * TECH-Y" chuyển được nó sang Y).
 */
import { complete as defaultComplete, extractJson, type LlmConfig } from "../../worker/llm";
import { isBotComment } from "@vuihoc/bot-core/core";
import { isSystemActor } from "../kg/human-signals";

/**
 * Ngưỡng số bình luận tối thiểu của chuyên viên (thành viên dự án trên Itsaplan,
 * không phải bot/hệ thống và không phải người báo) để coi ticket là "đã có người xử lý"
 * khi người báo yêu cầu "đóng" ticket (ADR-0006 cập nhật 2026-10-10).
 */
export const MIN_SPECIALIST_COMMENTS_FOR_DONE = 3;

export type CancelOrCloseIntent = "cancel" | "close";
export interface ReplyCandidate {
  identifier: string;
  issueId: number;
  title?: string;
  /** Câu kỹ thuật vừa hỏi người báo về ticket này (nếu có). */
  techQuestion?: string;
  /** Ticket này thuộc chính người báo (binding cùng chat / mô tả có Telegram ID). */
  ownTicket: boolean;
  /** Người báo nhắc mã ticket này trong tin. */
  mentioned: boolean;
  /** Bot vừa chuyển tin của ticket này (comment kỹ thuật…) tới người báo. */
  recentlyRelayed?: boolean;
  /** Ticket bot vừa tạo ở chat này (ứng viên để chuyển sang ticket khác). */
  justCreated?: boolean;
}

export type TicketCommand =
  /** Thêm nội dung vào ticket (comment). `content` = phần cần ghi, nguyên văn. */
  | { action: "append"; identifier: string; content: string }
  /** Người báo yêu cầu đóng / huỷ ticket đã có (ADR-0006 cập nhật 10/10/2026, ADR-0008). */
  | { action: "cancel_or_close"; identifier: string; content: string; intent?: CancelOrCloseIntent }
  /** Sửa ticket theo `instruction` (tiêu đề / trường / câu trong mô tả). */
  | { action: "edit"; identifier: string; instruction: string }
  /** Hỏi tình trạng ticket. */
  | { action: "lookup"; identifier: string }
  /** Ticket bot vừa tạo (`from`) thật ra là bổ sung cho `identifier` → chuyển sang, huỷ bản trùng. */
  | { action: "move_created"; from: string; identifier: string }
  /** Sự cố mới / trả lời tờ khai đang soạn — luồng tiếp nhận bình thường. */
  | { action: "new" }
  | { action: "unclear" };

export interface TicketCommandInput {
  message: string;
  attachments: number;
  candidates: ReplyCandidate[];
  /** Tiêu đề tờ khai đang soạn dở (nếu có). */
  draftTitle?: string;
}

export interface TicketCommandInterpreter {
  interpret(input: TicketCommandInput): Promise<TicketCommand>;
}

/** Mã ticket được nhắc trong tin: "TECH-795", "tech 722", "ticket TECH795". */
export function mentionedIdentifiers(text: string, projectKey: string): string[] {
  // "TECH-989", "TECH_989", "TECH 989", "ticket 989", "tk 989", "#989" — người báo hay gõ không đủ "TECH-"
  // (TECH-1001, 30/09: "đây là ticket 989 mà", "cái này là của 989", "TECH_989" đều bị bỏ sót).
  const key = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keySep = /\d$/.test(projectKey) ? "[\\s_:#-]+" : "[\\s_:#-]*";
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${key}${keySep}|(?:ticket|tick|tk)[\\s_:#-]*)(\\d{1,6})(?!\\d)|#(\\d{2,6})(?!\\d)`,
    "giu",
  );
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(`${projectKey.toUpperCase()}-${Number(m[1] ?? m[2])}`);
  return [...out];
}

/** Mẫu nhận diện mã ticket được nêu trực tiếp trong câu (TECH-951, TECHTEST-951, ticket 951, tk 951, #951). */
const TICKET_ID_TOKEN_SOURCE =
  "(?:(?:TECH(?:TEST)?|PO|IRIS)[\\s_:#-]*\\d{1,6}|(?:ticket|tick|tk|vé)[\\s_:#-]+(?:(?:TECH(?:TEST)?|PO|IRIS)[\\s_:#-]*)?\\d{1,6}|#\\d{2,6})(?!\\d)";

const HAS_TICKET_ID_RE = new RegExp(`(?<![\\p{L}\\p{N}])${TICKET_ID_TOKEN_SOURCE}`, "iu");

/** Lệnh sửa tường minh vào tiêu đề / mô tả / trường dữ liệu — không coi là yêu cầu đóng/huỷ ticket. */
const EXPLICIT_FIELD_OR_TEXT_EDIT_RE =
  /(?<![\p{L}\p{N}])(?:(?:sửa|đổi|chỉnh|cập\s*nhật)\s+(?:(?:lại|giúp|hộ|em|mình)\s+)*(?:(?:ticket|tick|tk|vé)\s+)?(?:[A-Z]{2,10}[-\s_:#]*\d+\s+)?(?:tiêu\s*đề|mô\s*tả|nội\s*dung|sđt|số\s*điện\s*thoại|mã\s*(?:đơn|hs|học\s*sinh|khách\s*hàng|kh|phòng)|bộ\s*phận|hệ\s*thống|tài\s*khoản)|ghi\s+sai\s+(?:mã|sđt|số|tiêu\s*đề|mô\s*tả|thông\s*tin))(?![\p{L}\p{N}])/iu;

/** Lệnh chuyển/gộp ticket vừa tạo sang ticket khác (move_created). */
const MOVE_CREATED_HINT_RE =
  /(?<![\p{L}\p{N}])(?:bổ\s+sung\s+cho|là\s+của|gộp\s+(?:vào|sang)|chuyển\s+sang)\s+(?:ticket\s+|tick\s+|tk\s+|vé\s+)?[A-Z]{2,10}[-\s_:#]*\d+/iu;

/** Ngữ cảnh bổ sung thông tin sự cố hoặc so sánh vé cũ — không phải lệnh đóng/huỷ ticket. */
const SUPPLEMENT_OR_COMPARE_CONTEXT_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(?:",
    `bổ\\s+sung(?:\\s+(?:vào|cho|thêm|thông\\s*tin))?\\s+(?:(?:ticket|tick|tk|vé)\\s+)?${TICKET_ID_TOKEN_SOURCE}`,
    `|${TICKET_ID_TOKEN_SOURCE}\\s*[,:-]?\\s*bổ\\s+sung(?![\\p{L}\\p{N}])`,
    `|(?:lỗi\\s+)?(?:giống|tương\\s+tự)(?:\\s+(?:như|với|ticket|tick|tk|vé))*\\s+${TICKET_ID_TOKEN_SOURCE}`,
    ")",
  ].join(""),
  "iu",
);

/** Dấu hiệu câu yêu cầu gộp/chuyển ticket vừa tạo nhầm sang ticket khác (move_created), không phải bổ sung thường. */
const MOVE_CREATED_CUE_RE =
  /(?<![\p{L}\p{N}])(?:nhầm(?:\s+rồi)?|(?:cái|tin|ticket|vé)\s+(?:này|vừa\s+rồi|vừa\s+tạo)|gộp\s+(?:vào|sang)|chuyển\s+sang)(?![\p{L}\p{N}])/iu;

const SUPPLEMENT_COMMAND_PREFIX_RE = new RegExp(
  [
    "^\\s*(?:(?:dạ|vâng|em|mình|chị|anh|nhờ(?:\\s+(?:em|bot|ad|tech|kỹ\\s*thuật))?|xin)\\s+)*",
    "(?:",
    "(?:update|bổ\\s*sung|cập\\s*nhật|gửi(?:\\s+thêm)?|thêm|đính(?:\\s*kèm)?|gắn)",
    "(?:\\s+(?:thêm|ảnh|hình(?:\\s*ảnh)?|video|file|tệp|thông\\s*tin|nội\\s*dung))*",
    "(?:\\s+(?:vào|cho|lên|ở|tại))?",
    "|(?:ảnh|hình(?:\\s*ảnh)?|video|file|tệp|thông\\s*tin)(?:\\s+bổ\\s*sung)?\\s+(?:vào|cho|của)",
    ")\\s+",
    `(?:(?:ticket|tick|tk|vé|yêu\\s*cầu)\\s+)?(${TICKET_ID_TOKEN_SOURCE})`,
    "(?:\\s+(?:giúp|hộ|cho|dùm|giùm)(?:\\s+(?:em|mình|chị|anh))?)?",
    "(?:\\s+(?:nhé|nha|ạ|với|nhé\\s+ạ))*",
    "(?:[\\s,.:;-]+([\\s\\S]*))?$",
  ].join(""),
  "iu",
);

const SUPPLEMENT_COMMAND_TICKET_FIRST_RE = new RegExp(
  [
    "^\\s*(?:(?:dạ|vâng)\\s+)?(?:(?:ticket|tick|tk|vé|yêu\\s*cầu)\\s+)?",
    `(${TICKET_ID_TOKEN_SOURCE})[\\s,.:;-]+`,
    "(?:(?:em|mình|chị|anh|nhờ(?:\\s+(?:em|bot|ad|tech|kỹ\\s*thuật))?|xin)\\s+)*",
    "(?:update|bổ\\s*sung|cập\\s*nhật|đính(?:\\s*kèm)?|gắn)",
    "(?:\\s+(?:thêm|ảnh|hình(?:\\s*ảnh)?|video|file|tệp|thông\\s*tin|nội\\s*dung))*",
    "(?:\\s+(?:vào|cho)\\s+(?:ticket|tick|tk|vé))?",
    "(?:\\s+(?:giúp|hộ|cho|dùm|giùm)(?:\\s+(?:em|mình|chị|anh))?)?",
    "(?:\\s+(?:nhé|nha|ạ|với|nhé\\s+ạ))*",
    "(?:[\\s,.:;-]+([\\s\\S]*))?$",
  ].join(""),
  "iu",
);

/**
 * Bóc vỏ câu lệnh bổ sung / đính kèm ("update vào tick TECH-1218", "bổ sung TECH-1218: ...", "đính ảnh vào TECH-1218").
 * Khi người báo chỉ gõ câu lệnh trần (vì ảnh đã gửi ở tin trước hoặc chuẩn bị gửi ở tin sau),
 * `content` trả về `""` để pipeline không ghi nhầm chính câu lệnh ("update vào tick TECH-1218") thành comment.
 */
export function stripSupplementCommandWrapper(text: string): {
  isSupplementCommand: boolean;
  content: string;
} {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || !HAS_TICKET_ID_RE.test(trimmed)) {
    return { isSupplementCommand: false, content: trimmed };
  }
  if (
    EXPLICIT_FIELD_OR_TEXT_EDIT_RE.test(trimmed) ||
    MOVE_CREATED_CUE_RE.test(trimmed) ||
    classifyCancelOrCloseIntent(trimmed) !== null
  ) {
    return { isSupplementCommand: false, content: trimmed };
  }
  const m =
    trimmed.match(SUPPLEMENT_COMMAND_PREFIX_RE) ??
    trimmed.match(SUPPLEMENT_COMMAND_TICKET_FIRST_RE);
  if (!m) {
    return { isSupplementCommand: false, content: trimmed };
  }
  return {
    isSupplementCommand: true,
    content: (m[2] ?? "").trim(),
  };
}

const TICKET_NOUN_TARGET_SOURCE = `(?:(?:ticket|tick|tk|vé)(?:\\s+${TICKET_ID_TOKEN_SOURCE}|(?=\\s+(?:giúp|hộ|cho|của|em|mình|chị|anh|này|đó|nhé|nha|ạ|vì|do|rồi)(?![\\p{L}\\p{N}])|\\s*$|[.,!?]))|yêu\\s*cầu\\s+${TICKET_ID_TOKEN_SOURCE}|${TICKET_ID_TOKEN_SOURCE})`;

const NON_COMMAND_VERB_PREFIX_SOURCE =
  "(?<!(?:nút|lỗi|không|ko|chưa|chẳng|chả|bấm|nhấn|click|chọn|chức\\s*năng|chương\\s*trình|màn\\s*hình|phần\\s*mềm|hệ\\s*thống|tự|bị|đóng\\s*\\/\\s*|hủy\\s*\\/\\s*)\\s*)";

/** Dấu hiệu câu đang mô tả sự cố tiếp diễn hoặc mệnh đề tương phản ("nhưng...", "vẫn lỗi...", "bị văng..."). */
const ONGOING_SYMPTOM_OR_CONTRAST_RE =
  /(?<![\p{L}\p{N}])(?:nhưng|tuy\s+nhiên|mà\s+(?:vẫn|lại|không|ko|chưa|bị)|vẫn\s+(?:không|ko|chưa|bị|lỗi|quay|treo|kẹt)|lại\s+(?:bị|lỗi|không|ko|văng|treo)|bị\s+(?:văng|treo|lỗi|đứng|đóng\s+băng|trắng|kẹt|mất|ẩn|liệt)|(?:không|ko|chưa)\s+(?:nghe|thấy|vào|làm|mở|gọi|dùng|học|tải|kết\s+nối|hiển\s+thị|bấm|nhấn|hủy|đóng)|báo\s+lỗi)(?![\p{L}\p{N}])/iu;

/** Ý định HỦY rõ ràng nhắm trực tiếp vào ticket ("hủy TECH-951", "hủy ticket TECH-951", "TECH-1126 ... không cần sửa nữa") → luôn chuyển Cancelled. */
export const EXPLICIT_CANCEL_TICKET_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(?:",
    `${NON_COMMAND_VERB_PREFIX_SOURCE}(?:xin\\s+)?(?:hủy|huỷ|cancel|bỏ)\\s+(?:(?:giúp|hộ|cho|dùm|giùm|lại)\\s+(?:(?:em|mình|chị|anh|ad|bot)\\s+)?)?${TICKET_NOUN_TARGET_SOURCE}`,
    `|${TICKET_ID_TOKEN_SOURCE}(?:\\s*[,:-]?\\s*)(?:(?:mình|em|chị|anh)\\s+)?(?:(?:muốn|xin|nhờ(?:\\s+(?:em|tech|kỹ\\s*thuật|ad))?)\\s+)?(?:hủy|huỷ|cancel|bỏ)(?:\\s+(?:ticket|tick|tk|vé|yêu\\s*cầu|giúp|hộ|cho|em|mình|nhé|nha|ạ|vì|do)(?![\\p{L}\\p{N}])|\\s*$|[.,!?])`,
    ")(?![\\p{L}\\p{N}])",
  ].join(""),
  "iu",
);

const NO_LONGER_NEEDED_TICKET_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:không|ko|k|khỏi)\\s+cần\\s+(?:(?:sửa|xử\\s*lý|hỗ\\s*trợ|kiểm\\s*tra|check|làm|theo\\s*dõi)\\s+)?(?:${TICKET_NOUN_TARGET_SOURCE}\\s+)?nữa(?:\\s+(?:${TICKET_NOUN_TARGET_SOURCE}|đâu|ạ|nhé|nha|em|mình|chị|anh|ad|ơi|cảm\\s*ơn|thanks))*[.!?\\s]*$`,
  "iu",
);

/** Ý định ĐÓNG trực tiếp vào ticket ("Đóng ticket TECH-999", "xin đóng TECH-999"). */
const EXPLICIT_CLOSE_DIRECT_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(?:",
    `${NON_COMMAND_VERB_PREFIX_SOURCE}(?:xin\\s+)?(?:đóng|đóc|close)\\s+(?:(?:giúp|hộ|cho|dùm|giùm|lại)\\s+(?:(?:em|mình|chị|anh|ad|bot)\\s+)?)?${TICKET_NOUN_TARGET_SOURCE}`,
    `|${TICKET_ID_TOKEN_SOURCE}(?:\\s*[,:-]?\\s*)(?:(?:mình|em|chị|anh)\\s+)?(?:(?:muốn|xin|nhờ(?:\\s+(?:em|tech|kỹ\\s*thuật|ad))?)\\s+)?(?:đóng|đóc|close)(?:\\s+(?:lại|ticket|tick|tk|vé|yêu\\s*cầu|giúp|hộ|cho|em|mình|nhé|nha|ạ|vì|do)(?![\\p{L}\\p{N}])|\\s*$|[.,!?])`,
    ")(?![\\p{L}\\p{N}])",
  ].join(""),
  "iu",
);

/** Báo sự cố trên ticket đã tự hết / học sinh đã vào được rồi (không kèm mệnh đề lỗi tiếp diễn). */
const RESOLVED_CONFIRMATION_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(?<!(?:không|ko|chưa|chẳng|chả|k)\\s+)(?:",
    "đã\\s+(?:vào|làm(?:\\s+bài)?|gọi|dùng|sử\\s*dụng|học|mở|đăng\\s*nhập|truy\\s*cập|xử\\s*lý|hoạt\\s*động)\\s+(?:lại\\s+)?(?:được|đc|dc|bình\\s*thường|bt|ok|ổn)",
    "|(?:vào|làm(?:\\s+bài)?|gọi|dùng|sử\\s*dụng|học|mở|đăng\\s*nhập|truy\\s*cập|xử\\s*lý)\\s+(?:lại\\s+)?(?:được|đc|dc)\\s+(?:rồi|r(?![\\p{L}\\p{N}])|bình\\s*thường|bt(?![\\p{L}\\p{N}]))",
    "|(?:đã\\s+ổn|ổn\\s+rồi|đã\\s+ok|ok\\s+rồi|tự\\s+hết\\s+lỗi)",
    `)(?:\\s+(?:rồi|ạ|nhé|nha|em|mình|chị|anh|ad|ơi|cảm\\s*ơn|thanks|${TICKET_NOUN_TARGET_SOURCE}))*[.!?\\s]*$`,
  ].join(""),
  "iu",
);

/** Ý định ĐÓNG / báo đã tự hết (không nói rõ hủy) → chuyển Done nếu chuyên viên đã xử lý, ngược lại chuyển Cancelled. */
export const CLOSE_TICKET_RE = new RegExp(
  `${EXPLICIT_CLOSE_DIRECT_RE.source}|${RESOLVED_CONFIRMATION_RE.source}`,
  "iu",
);

/**
 * Phân loại ý định hủy rõ ("cancel") hay đóng ("close") trên câu của người báo.
 * Chỉ nhận diện khi câu CÓ nêu mã ticket và ý định hướng trực tiếp vào việc hủy/đóng ticket
 * (không bắt nhầm câu mô tả sự cố có chữ "đóng cửa sổ", "đóng băng", "hủy đơn hàng", "không cần sửa nữa"...).
 */
export function classifyCancelOrCloseIntent(text: string): CancelOrCloseIntent | null {
  if (!text || typeof text !== "string") return null;
  if (!HAS_TICKET_ID_RE.test(text)) return null;
  if (
    EXPLICIT_FIELD_OR_TEXT_EDIT_RE.test(text) ||
    MOVE_CREATED_HINT_RE.test(text) ||
    SUPPLEMENT_OR_COMPARE_CONTEXT_RE.test(text)
  ) {
    return null;
  }
  if (EXPLICIT_CANCEL_TICKET_RE.test(text)) return "cancel";
  if (!ONGOING_SYMPTOM_OR_CONTRAST_RE.test(text) && NO_LONGER_NEEDED_TICKET_RE.test(text))
    return "cancel";
  if (EXPLICIT_CLOSE_DIRECT_RE.test(text)) return "close";
  if (!ONGOING_SYMPTOM_OR_CONTRAST_RE.test(text) && RESOLVED_CONFIRMATION_RE.test(text))
    return "close";
  return null;
}

export function isCancelOrCloseTicketRequest(text: string): boolean {
  return classifyCancelOrCloseIntent(text) !== null;
}

const NON_SPECIALIST_ACTOR_RE =
  /\b(?:ti[eể]u\s*linh|tieulinh|iris|bot-ticket-intake|bot-iris-intake|onyx|bot|ai-coder|ai-lead|ai-qa|coder\s*ai|lead\s*ai|qa\s*ai)\b|^admin$/i;

export interface TimelineCommentEntry {
  kind?: string;
  body?: string | null;
  actorKind?: string | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorUserId?: string | null;
}

/**
 * Đếm số bình luận của chuyên viên (thành viên dự án trên Itsaplan, không phải bot/@tieulinh,
 * không phải người báo) trên timeline của một ticket.
 */
export function countSpecialistTimelineComments(
  timeline: unknown[],
  options?: {
    reporterNames?: Array<string | undefined | null>;
    projectAssignees?: Array<{
      userId?: string;
      name?: string;
      username?: string | null;
      kind?: string | null;
    }>;
  },
): number {
  if (!Array.isArray(timeline) || timeline.length === 0) return 0;
  const reporterSet = new Set(
    (options?.reporterNames ?? [])
      .map((n) =>
        String(n ?? "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const humanMembers = (options?.projectAssignees ?? []).filter(
    (a) =>
      a &&
      a.kind !== "agent" &&
      !isSystemActor(a.name) &&
      !NON_SPECIALIST_ACTOR_RE.test(`${a.name ?? ""} ${a.username ?? ""}`),
  );
  const memberIds = new Set(humanMembers.map((a) => String(a.userId ?? "").trim()).filter(Boolean));
  const memberNames = new Set(
    humanMembers.flatMap((a) =>
      [a.name, a.username]
        .map((s) =>
          String(s ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
  const enforceMemberList = memberIds.size > 0 || memberNames.size > 0;

  let count = 0;
  for (const raw of timeline) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as TimelineCommentEntry;
    if (item.kind !== "comment" || typeof item.body !== "string" || !item.body.trim()) continue;
    if (isBotComment(item.body)) continue;
    if (item.actorKind === "agent") continue;
    const actorName = String(item.actorName ?? "").trim();
    const actorUsername = String(item.actorUsername ?? "")
      .trim()
      .replace(/^@/, "");
    const actorUserId = String(item.actorUserId ?? "").trim();
    if (
      !actorName ||
      isSystemActor(actorName) ||
      NON_SPECIALIST_ACTOR_RE.test(`${actorName} ${actorUsername}`)
    )
      continue;
    if (
      reporterSet.has(actorName.toLowerCase()) ||
      (actorUsername && reporterSet.has(actorUsername.toLowerCase()))
    )
      continue;
    if (enforceMemberList) {
      const matchedById = Boolean(actorUserId && memberIds.has(actorUserId));
      const matchedByName =
        memberNames.has(actorName.toLowerCase()) ||
        (Boolean(actorUsername) && memberNames.has(actorUsername.toLowerCase()));
      if (!matchedById && !matchedByName) continue;
    }
    count++;
  }
  return count;
}
type CompleteFn = (config: LlmConfig, system: string, user: string) => Promise<string>;

const SYSTEM_PROMPT = `Bạn đọc MỘT tin nhắn Telegram người báo lỗi gửi cho bot tiếp nhận sự cố Tiểu Linh và cho biết người báo muốn gì với các ticket ĐÃ CÓ dưới đây. Bot sẽ luôn hỏi người báo xác nhận trước khi ghi, nhưng bạn phải hiểu đúng ý.
Hành động:
- "append": thêm thông tin / trả lời kỹ thuật cho một ticket đã có ("bổ sung TECH-795 …", "TECH-795 cập nhật thông tin thêm …", trả lời đúng điều kỹ thuật vừa hỏi như "đơn hàng gia hạn ạ", "DH900002"). "content" = phần nội dung cần ghi, NGUYÊN VĂN người báo (bỏ phần lệnh như "bổ sung TECH-795").
- "cancel_or_close": người báo yêu cầu HỦY / ĐÓNG / BỎ ticket đã có vì không cần xử lý nữa hoặc báo sự cố đã tự hết / học sinh đã vào dùng được ("Hủy TECH-951", "hủy TECH-951 vì học sinh đã vào được rồi", "Đóng ticket TECH-999", "hủy ticket TECH-1126", "xin đóng TECH-795"). "content" = nguyên văn lời người báo. TUYỆT ĐỐI KHÔNG chọn "edit" khi người báo muốn hủy hoặc đóng ticket.
- "edit": đề nghị SỬA ticket ("sửa TECH-795 SĐT thành …", "TECH-795 ghi sai mã đơn, đúng là …", "đổi tiêu đề TECH-795 …"). "instruction" = điều cần sửa, nguyên văn.
- "lookup": hỏi tình trạng ("TECH-795 tới đâu rồi", "check TECH-795", chỉ gõ mã).
- "move_created": ticket bot VỪA TẠO (đánh dấu "vừa tạo") thật ra là bổ sung cho một ticket khác ("cái này bổ sung cho TECH-795 chứ", "nhầm rồi, cái vừa rồi là của TECH-795"). "from" = ticket vừa tạo, "ticket" = ticket đích.
- "new": báo sự cố MỚI, trả lời câu hỏi của tờ khai đang soạn (bộ phận, hệ thống, xác nhận…), hoặc nhắc ticket cũ chỉ để so sánh ("lỗi giống TECH-722"). Tin tả một lỗi khác chủ đề ticket (vd ticket về hạn học, tin báo CRM không gọi được) cũng là "new".
- "unclear": tin ngắn/mơ hồ, có thể là trả lời kỹ thuật mà cũng có thể là việc khác. Đừng đoán bừa.
Trả về ĐÚNG một object JSON: {"action": "...", "ticket": "<mã>" | null, "from": "<mã>" | null, "content": "...", "instruction": "...", "reason": "..."}`;
function userPrompt(input: TicketCommandInput): string {
  const cands = input.candidates
    .map((c) =>
      [
        `- ${c.identifier}${c.title ? `: ${c.title}` : ""}`,
        c.ownTicket ? "  (ticket của chính người báo)" : "  (ticket của người khác)",
        c.mentioned ? "  (người báo nhắc mã này trong tin)" : "",
        c.justCreated ? "  (bot VỪA TẠO ticket này trong chat)" : "",
        c.techQuestion ? `  Kỹ thuật vừa hỏi người báo: "${c.techQuestion.slice(0, 600)}"` : "",
        c.recentlyRelayed && !c.techQuestion
          ? "  (bot vừa chuyển tin của kỹ thuật về ticket này cho người báo)"
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  return [
    `Ticket đã có liên quan:\n${cands}`,
    input.draftTitle
      ? `Tờ khai sự cố đang soạn dở: "${input.draftTitle}"`
      : "Không có tờ khai đang soạn.",
    `Tin nhắn mới${input.attachments ? ` (kèm ${input.attachments} ảnh/tệp)` : ""}:\n"${input.message.slice(0, 2000)}"`,
  ].join("\n\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class LlmTicketCommandInterpreter implements TicketCommandInterpreter {
  constructor(
    private readonly llm: LlmConfig,
    private readonly completeFn: CompleteFn = defaultComplete,
    private readonly timeoutMs = 45_000,
  ) {}

  async interpret(input: TicketCommandInput): Promise<TicketCommand> {
    const cancelIntent = classifyCancelOrCloseIntent(input.message);
    const supplement = stripSupplementCommandWrapper(input.message);
    const raw = await withTimeout(
      this.completeFn(this.llm, SYSTEM_PROMPT, userPrompt(input)),
      this.timeoutMs,
      "ticket-command",
    ).catch((err) => {
      if (cancelIntent || supplement.isSupplementCommand) return "{}";
      throw err;
    });
    const parsed = extractJson<Record<string, unknown>>(raw) ?? {};
    const action = String(parsed.action ?? "")
      .trim()
      .toLowerCase();
    const find = (v: unknown) =>
      input.candidates.find(
        (c) =>
          c.identifier.toUpperCase() ===
          String(v ?? "")
            .trim()
            .toUpperCase(),
      );
    const target = find(parsed.ticket);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
    if (action === "move_created" && target) {
      const from = find(parsed.from) ?? input.candidates.find((c) => c.justCreated);
      if (from?.justCreated && from.identifier !== target.identifier)
        return { action: "move_created", from: from.identifier, identifier: target.identifier };
    }
    const projectKeys = new Set([
      "TECH",
      ...input.candidates.map((c) => c.identifier.split("-")[0]).filter(Boolean),
    ]);
    const msgMentions = new Set(
      [...projectKeys].flatMap((pk) =>
        mentionedIdentifiers(input.message, pk).map((id) => id.toUpperCase()),
      ),
    );
    if (cancelIntent) {
      const mentionedOwn = input.candidates.find(
        (c) => (c.mentioned || msgMentions.has(c.identifier.toUpperCase())) && c.ownTicket,
      );
      const mentionedAny = input.candidates.find(
        (c) => c.mentioned || msgMentions.has(c.identifier.toUpperCase()),
      );
      // Chỉ nhận diện hủy/đóng khi người báo nêu mã ticket trong tin nhắn; không tự đoán sang ticket khác.
      const cancelTarget = mentionedOwn ?? mentionedAny;
      if (cancelTarget) {
        return {
          action: "cancel_or_close",
          identifier: cancelTarget.identifier,
          content: input.message.trim(),
          intent: cancelIntent,
        };
      }
    }
    if (action === "new") return { action: "new" };
    if (action === "lookup" && target) return { action: "lookup", identifier: target.identifier };
    if (
      action === "cancel_or_close" &&
      target &&
      cancelIntent &&
      (target.mentioned || msgMentions.has(target.identifier.toUpperCase()))
    ) {
      const content = text(parsed.content) || input.message.trim();
      return {
        action: "cancel_or_close",
        identifier: target.identifier,
        content,
        intent: cancelIntent,
      };
    }
    if (action === "edit" && target)
      return {
        action: "edit",
        identifier: target.identifier,
        instruction: text(parsed.instruction) || input.message,
      };
    if (action === "append" && target) {
      const llmContent = text(parsed.content);
      const content =
        supplement.isSupplementCommand && !supplement.content
          ? ""
          : llmContent && llmContent.toLowerCase() !== input.message.trim().toLowerCase()
            ? llmContent
            : supplement.isSupplementCommand
              ? supplement.content
              : llmContent || input.message;
      return { action: "append", identifier: target.identifier, content };
    }
    if (supplement.isSupplementCommand) {
      const mentionedOwn = input.candidates.find(
        (c) => (c.mentioned || msgMentions.has(c.identifier.toUpperCase())) && c.ownTicket,
      );
      const mentionedAny = input.candidates.find(
        (c) => c.mentioned || msgMentions.has(c.identifier.toUpperCase()),
      );
      const suppTarget = mentionedOwn ?? mentionedAny;
      if (suppTarget) {
        return { action: "append", identifier: suppTarget.identifier, content: supplement.content };
      }
    }
    return { action: "unclear" };
  }
}

// ── Sửa ticket (ADR-0008 quyết định 5) ─────────────────────────────────────────

export type EditOp =
  | { type: "title"; value: string }
  /** Dòng "- <label>: <giá trị>" ở mục "Thông tin sự cố" — thêm dòng nếu chưa có. */
  | { type: "field"; label: string; value: string }
  /** Thay một đoạn nguyên văn trong mô tả. */
  | { type: "replace"; old: string; new: string };

export interface EditChange {
  what: string;
  before: string;
  after: string;
}

const EDIT_PROMPT = `Người báo lỗi đề nghị sửa ticket. Dựa vào tiêu đề + mô tả hiện tại và lời đề nghị, trả về các thao tác sửa TỐI THIỂU.
Thao tác:
- {"type":"title","value":"<tiêu đề mới>"}
- {"type":"field","label":"<nhãn dòng ở mục Thông tin sự cố, đúng như đang có, vd 'Tài khoản HS / SĐT', 'Mã khách hàng', 'Bộ phận'>","value":"<giá trị mới>"}
- {"type":"replace","old":"<đoạn NGUYÊN VĂN đang có trong mô tả>","new":"<đoạn thay thế>"}
Không bịa, không sửa gì ngoài lời đề nghị. Không hiểu được thì trả ops rỗng.
Trả về ĐÚNG một object JSON: {"ops": [...]}`;

export async function planEdit(
  llm: LlmConfig,
  input: { title: string; description: string; instruction: string },
  completeFn: CompleteFn = defaultComplete,
  timeoutMs = 45_000,
): Promise<EditOp[]> {
  const raw = await withTimeout(
    completeFn(
      llm,
      EDIT_PROMPT,
      `Tiêu đề: ${input.title}\n\nMô tả hiện tại:\n${input.description.slice(0, 6000)}\n\nĐề nghị sửa:\n"${input.instruction}"`,
    ),
    timeoutMs,
    "ticket-edit",
  );
  const ops = extractJson<{ ops?: unknown }>(raw)?.ops;
  if (!Array.isArray(ops)) return [];
  const out: EditOp[] = [];
  for (const o of ops as any[]) {
    if (o?.type === "title" && typeof o.value === "string" && o.value.trim())
      out.push({ type: "title", value: o.value.trim() });
    else if (
      o?.type === "field" &&
      typeof o.label === "string" &&
      typeof o.value === "string" &&
      o.label.trim() &&
      o.value.trim()
    )
      out.push({ type: "field", label: o.label.trim(), value: o.value.trim() });
    else if (
      o?.type === "replace" &&
      typeof o.old === "string" &&
      typeof o.new === "string" &&
      o.old.trim()
    )
      out.push({ type: "replace", old: o.old, new: o.new });
  }
  return out;
}

/**
 * Áp thao tác sửa một cách tất định. Thao tác không áp được (đoạn cũ không có /
 * có nhiều chỗ) bị bỏ và ghi vào `rejected` để không sửa mù.
 */
export function applyEditOps(
  title: string,
  description: string,
  ops: EditOp[],
): { title: string; description: string; changes: EditChange[]; rejected: EditOp[] } {
  let t = title;
  let d = description;
  const changes: EditChange[] = [];
  const rejected: EditOp[] = [];
  for (const op of ops) {
    if (op.type === "title") {
      if (op.value !== t) changes.push({ what: "Tiêu đề", before: t, after: op.value });
      t = op.value;
    } else if (op.type === "field") {
      const esc = op.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^(- ${esc}:)[ \\t]*(.*)$`, "m");
      const m = d.match(re);
      if (m) {
        if (m[2].trim() !== op.value)
          changes.push({ what: op.label, before: m[2].trim(), after: op.value });
        d = d.replace(re, `$1 ${op.value}`);
      } else {
        const head = d.indexOf("## Thông tin sự cố");
        if (head < 0) {
          rejected.push(op);
          continue;
        }
        // Chèn cuối danh sách "- …" của mục Thông tin sự cố
        const lines = d.slice(head).split("\n");
        let i = 1;
        while (i < lines.length && lines[i].trim() === "") i++;
        while (i < lines.length && lines[i].startsWith("- ")) i++;
        lines.splice(i, 0, `- ${op.label}: ${op.value}`);
        d = d.slice(0, head) + lines.join("\n");
        changes.push({ what: op.label, before: "(chưa có)", after: op.value });
      }
    } else {
      const count = d.split(op.old).length - 1;
      if (count !== 1) {
        rejected.push(op);
        continue;
      }
      d = d.replace(op.old, op.new);
      changes.push({ what: "Mô tả", before: op.old, after: op.new });
    }
  }
  return { title: t, description: d, changes, rejected };
}

/** Phần "Mô tả" (giữa "### Mô tả" và mục kế tiếp) và các dòng ảnh của một mô tả ticket. */
export function descriptionBody(description: string): { body: string; images: string[] } {
  const start = description.indexOf("### Mô tả");
  let body = "";
  if (start >= 0) {
    const rest = description.slice(start + "### Mô tả".length);
    const end = rest.search(/\n(### |---)/);
    body = (end < 0 ? rest : rest.slice(0, end)).trim();
  }
  const images = description.match(/!\[[^\]]*\]\([^)]+\)/g) ?? [];
  return { body, images };
}
