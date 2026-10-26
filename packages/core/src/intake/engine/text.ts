/**
 * Pure text helpers for the conversation engine (ticket 09): find ticket
 * identifiers a reporter mentioned, and fold text for button-match comparison.
 *
 * NGUỒN: intake `lib/intake-step/ticket-reply-router.ts` (`mentionedIdentifiers`)
 * and the `normalizeButtonText` / `foldForComparison` button-match used across
 * the pipeline (so a confirm fires only on an exact label match — ADR-0008).
 */

/**
 * Ticket ids a reporter named: "TECH-795", "TECH_795", "TECH 795", "ticket 795",
 * "tk 795", "#795". Reporters routinely drop the "TECH-" (TECH-1001, 30/09).
 */
export function mentionedIdentifiers(text: string, projectKey: string): string[] {
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

/**
 * Fold a button label / reporter reply for comparison: trim, drop leading
 * emoji/symbols, collapse whitespace, remove diacritics, lowercase. A confirm
 * fires only when the folded reply equals the folded button label.
 */
export function foldButton(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Người báo GÕ CHỮ thay vì bấm nút "Sự cố mới" (TECH-1013, 30/09: gõ "ticket mới ạ", tin bị
 * ghi tiếp vào ticket cũ). Chỉ dùng ở nơi lỡ hiểu sai còn an toàn: khi đang chờ người báo chọn,
 * hoặc ngay sau khi ticket vừa tạo — hiểu nhầm thành "sự cố mới" chỉ tốn thêm một ticket.
 */
export const NEW_INCIDENT_SAID =
  /(?<![\p{L}\p{N}])(?:(?:ticket|sự cố|lỗi|yêu cầu|vấn đề|việc|báo)\s+(?:mới|khác)|tạo\s+(?:(?:ticket|sự cố)\s+)?mới|không phải\s+(?:là\s+)?(?:thông tin\s+)?bổ sung|(?:phụ huynh|học sinh|khách hàng|khách|hs|ph)\s+khác)(?![\p{L}\p{N}])/iu;

export function saysNewIncident(text: string): boolean {
  return NEW_INCIDENT_SAID.test(text);
}

/** Bỏ cụm "ticket mới ạ" để biết người báo còn nói thêm nội dung sự cố hay không. */
export function stripNewIncidentDeclaration(text: string): string {
  return text
    .replace(new RegExp(NEW_INCIDENT_SAID.source, "giu"), " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Tin gõ tay kèm chữ "sự cố mới": nếu còn nội dung thì nối vào tin đang chờ, còn không thì bỏ. */
export function withTypedDetail(buffered: string, typed: string): string {
  return stripNewIncidentDeclaration(typed).length >= 12 ? `${buffered}\n${typed}` : buffered;
}

/** Mẫu nhận diện mã ticket được nêu trực tiếp trong câu (TECH-951, TECHTEST-951, ticket 951, tk 951, #951). */
const TICKET_ID_TOKEN_SOURCE =
  "(?:[A-Z0-9_]{2,10}[\\s_:#-]*\\d{1,6}|(?:ticket|tick|tk|vé)[\\s_:#-]+(?:[A-Z0-9_]{2,10}[\\s_:#-]*)?\\d{1,6}|#\\d{2,6})(?!\\d)";

const HAS_TICKET_ID_RE = new RegExp(`(?<![\\p{L}\\p{N}])${TICKET_ID_TOKEN_SOURCE}`, "iu");

/** Lệnh sửa tường minh vào tiêu đề / mô tả / trường dữ liệu — không coi là yêu cầu đóng/huỷ ticket. */
const EXPLICIT_FIELD_OR_TEXT_EDIT_RE =
  /(?<![\p{L}\p{N}])(?:(?:sửa|đổi|chỉnh|cập\s*nhật)\s+(?:(?:lại|giúp|hộ|em|mình)\s+)*(?:(?:ticket|tick|tk|vé)\s+)?(?:[A-Z0-9_]{2,10}[-\s_:#]*\d+\s+)?(?:tiêu\s*đề|mô\s*tả|nội\s*dung|sđt|số\s*điện\s*thoại|mã\s*(?:đơn|hs|học\s*sinh|khách\s*hàng|kh|phòng)|bộ\s*phận|hệ\s*thống|tài\s*khoản)|ghi\s+sai\s+(?:mã|sđt|số|tiêu\s*đề|mô\s*tả|thông\s*tin))(?![\p{L}\p{N}])/iu;

/** Lệnh chuyển/gộp ticket vừa tạo sang ticket khác (move_created). */
const MOVE_CREATED_HINT_RE =
  /(?<![\p{L}\p{N}])(?:bổ\s+sung\s+cho|là\s+của|gộp\s+(?:vào|sang)|chuyển\s+sang)\s+(?:ticket\s+|tick\s+|tk\s+|vé\s+)?[A-Z0-9_]{2,10}[-\s_:#]*\d+/iu;

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

const TICKET_NOUN_TARGET_SOURCE = `(?:(?:ticket|tick|tk|vé)(?:\\s+${TICKET_ID_TOKEN_SOURCE}|(?=\\s+(?:giúp|hộ|cho|của|em|mình|chị|anh|này|đó|nhé|nha|ạ|vì|do|rồi)(?![\\p{L}\\p{N}])|\\s*$|[.,!?]))|yêu\\s*cầu\\s+${TICKET_ID_TOKEN_SOURCE}|${TICKET_ID_TOKEN_SOURCE})`;

const NON_COMMAND_VERB_PREFIX_SOURCE =
  "(?<!(?:nút|lỗi|không|ko|chưa|chẳng|chả|bấm|nhấn|click|chọn|chức\\s*năng|chương\\s*trình|màn\\s*hình|phần\\s*mềm|hệ\\s*thống|tự|bị|đóng\\s*\\/\\s*|hủy\\s*\\/\\s*)\\s*)";

const ONGOING_SYMPTOM_OR_CONTRAST_RE =
  /(?<![\p{L}\p{N}])(?:nhưng|tuy\s+nhiên|mà\s+(?:vẫn|lại|không|ko|chưa|bị)|vẫn\s+(?:không|ko|chưa|bị|lỗi|quay|treo|kẹt)|lại\s+(?:bị|lỗi|không|ko|văng|treo)|bị\s+(?:văng|treo|lỗi|đứng|đóng\s+băng|trắng|kẹt|mất|ẩn|liệt)|(?:không|ko|chưa)\s+(?:nghe|thấy|vào|làm|mở|gọi|dùng|học|tải|kết\s+nối|hiển\s+thị|bấm|nhấn|hủy|đóng)|báo\s+lỗi)(?![\p{L}\p{N}])/iu;

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

const EXPLICIT_CLOSE_DIRECT_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(?:",
    `${NON_COMMAND_VERB_PREFIX_SOURCE}(?:xin\\s+)?(?:đóng|đóc|close)\\s+(?:(?:giúp|hộ|cho|dùm|giùm|lại)\\s+(?:(?:em|mình|chị|anh|ad|bot)\\s+)?)?${TICKET_NOUN_TARGET_SOURCE}`,
    `|${TICKET_ID_TOKEN_SOURCE}(?:\\s*[,:-]?\\s*)(?:(?:mình|em|chị|anh)\\s+)?(?:(?:muốn|xin|nhờ(?:\\s+(?:em|tech|kỹ\\s*thuật|ad))?)\\s+)?(?:đóng|đóc|close)(?:\\s+(?:lại|ticket|tick|tk|vé|yêu\\s*cầu|giúp|hộ|cho|em|mình|nhé|nha|ạ|vì|do)(?![\\p{L}\\p{N}])|\\s*$|[.,!?])`,
    ")(?![\\p{L}\\p{N}])",
  ].join(""),
  "iu",
);

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

export function classifyCancelOrCloseIntent(text: string): "cancel" | "close" | null {
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

/**
 * Bóc vỏ câu lệnh bổ sung / đính kèm ("update vào tick TECH-1218", "bổ sung TECH-1218: ...", "đính ảnh vào TECH-1218").
 * Khi người báo chỉ gõ câu lệnh trần (vì ảnh đã gửi ở tin trước hoặc chuẩn bị gửi ở tin sau),
 * `content` trả về `""` để không ghi nhầm chính câu lệnh thành comment.
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

/** Nhận diện câu hỏi tiến độ / tình trạng không nêu mã ticket (D9). */
const PROGRESS_INQUIRY_RE =
  /(?<![\p{L}\p{N}])(?:tình\s*trạng|tiến\s*độ|xong\s*chưa|check\s*giúp|xử\s*lý\s*(?:tới|đến)\s*đâu|tới\s*đâu\s*rồi|đến\s*đâu\s*rồi|kiểm\s*tra\s*giúp|xem\s*giúp)(?![\p{L}\p{N}])/iu;

export function isProgressInquiry(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length > 60) return false;
  if (/(?:không|chưa|lỗi|hỏng|bị|mất|văng|treo|đơ|lag|sập|đổi\s+lịch|sai\b)/iu.test(trimmed)) {
    return false;
  }
  return PROGRESS_INQUIRY_RE.test(trimmed);
}
