import { redactIncidentPII } from "./pii-redactor";

/**
 * Các luật cửa lọc thuần mã để quyết định tài liệu có đủ chuẩn đưa vào kho tri thức hay không.
 * Kế thừa các chuẩn đo lường thực tế từ ONYX-KHI-DONE.md.
 */

/** Cửa 1: Loại ticket test */
export function isTestTicket(title?: string): boolean {
  if (!title) return false;
  return (
    /\[(?:TEST(?:\s*BOT)?|BOT\s*TEST)\]/i.test(title) ||
    /^\s*\[?(?:TEST|BOT\s*TEST|TEST\s*BOT)\b/i.test(title)
  );
}

/** Cửa 2: Loại nguyên liệu thô quá ngắn (< 300 ký tự) */
export function isRawTooShort(rawContent?: string, minLength = 300): boolean {
  return (rawContent || "").trim().length < minLength;
}

/** Cửa 3: Kiểm tra có bài học tri thức (nguyên nhân hoặc cách khắc phục rõ ràng) */
export function hasKnowledge(doc: { rootCause?: string; resolution?: string }): boolean {
  const root = (doc.rootCause || "").trim().toLowerCase();
  const fix = (doc.resolution || "").trim().toLowerCase();

  const isUnknown = (text: string) =>
    !text ||
    text.includes("chưa ghi nhận") ||
    text.includes("chưa rõ") ||
    text.includes("không rõ") ||
    text.includes("chưa xác định") ||
    text.length < 10;

  return !isUnknown(root) || !isUnknown(fix);
}

/** Cửa 4: Kiểm tra còn sót PII chưa che sau biên tập */
export function containsPii(text: string): boolean {
  if (!text) return false;
  return redactIncidentPII(text) !== text;
}

export interface FilterDecision {
  pass: boolean;
  reason?: string;
}

/**
 * Đánh giá trước khi gọi LLM (loại bỏ ticket test hoặc không đủ thông tin để học)
 */
export function evaluatePreLlmFilter(
  ticket: { title?: string },
  rawContent: string,
  minLength = 300,
): FilterDecision {
  if (isTestTicket(ticket.title)) {
    return { pass: false, reason: "Ticket thử nghiệm (tiêu đề chứa [TEST])" };
  }
  if (isRawTooShort(rawContent, minLength)) {
    return {
      pass: false,
      reason: `Nguyên liệu thô quá ngắn (${rawContent.trim().length} < ${minLength} ký tự)`,
    };
  }
  return { pass: true };
}

/**
 * Đánh giá sau khi LLM biên tập (đảm bảo tài liệu có bài học hữu ích và sạch PII)
 */
export function evaluatePostLlmFilter(
  doc: { rootCause?: string; resolution?: string },
  documentText: string,
): FilterDecision {
  if (!hasKnowledge(doc)) {
    return {
      pass: false,
      reason: "Không có tri thức rõ ràng (cả nguyên nhân và cách khắc phục đều không rõ)",
    };
  }
  if (containsPii(documentText)) {
    return {
      pass: false,
      reason: "Phát hiện dữ liệu nhạy cảm / PII trong tài liệu sau biên tập",
    };
  }
  return { pass: true };
}
