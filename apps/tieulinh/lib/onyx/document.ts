/**
 * Dựng thân tài liệu Onyx theo đúng khuôn mà bên tra cứu (client.ts#searchViaMcp) đang parse
 * bằng regex — khuôn này kế thừa nguyên trạng từ bot-core/src/onyx/document.ts (ONYX-KHI-DONE.md
 * §4⑤), nơi các document đầu tiên trong docset ticket-history/tech-done-tickets đã được nạp theo
 * đúng dạng này. Đường nạp hiện tại (ingest.service.ts) trước đây dùng khuôn câu chữ khác
 * ("TRIỆU CHỨNG SỰ CỐ:", "NGUYÊN NHÂN GỐC RỄ:", ...) nên regex bên tra cứu không khớp được.
 */

const VUIHOC_META_RE = /<!--\s*vuihoc-meta:\s*(\{[\s\S]*?\})\s*-->/;

/** Đọc lại khối JSON ẩn `<!-- vuihoc-meta: {...} -->` mà formatTicketDescription() đã ghi vào mô tả. */
export function parseVuihocMeta(description: string): Record<string, unknown> | null {
  const match = description.match(VUIHOC_META_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

const isBlank = (v?: string | null) =>
  !v || /^\s*(không rõ|khong ro|không có|khong co|chưa rõ|n\/a|none)\s*$/i.test(v.trim());

export interface OnyxDocumentFields {
  identifier: string;
  system?: string;
  errorCategory?: string;
  closedDate: string;
  symptom: string;
  rootCause?: string;
  resolution?: string;
  prevention?: string;
}

/**
 * Thân tài liệu: dòng tiêu đề "MÃ · Hệ thống · Phân loại · đóng YYYY-MM-DD" rồi các mục
 * TRIỆU CHỨNG / NGUYÊN NHÂN / CÁCH KHẮC PHỤC / CÁCH PHÒNG TRÁNH — không colon, mỗi mục cách
 * nhau một dòng trống, đúng câu chữ để regex bên searchViaMcp cắt được. Mục nào rỗng hoặc
 * "không rõ" thì bỏ hẳn, không in dòng rỗng (ONYX-KHI-DONE.md §12.5 — dòng rỗng chỉ làm loãng vector).
 */
export function buildOnyxDocumentBody(fields: OnyxDocumentFields): string {
  const header = [
    fields.identifier,
    fields.system,
    fields.errorCategory,
    `đóng ${fields.closedDate}`,
  ]
    .filter((part) => part && String(part).trim().length > 0)
    .join(" · ");

  const section = (title: string, value?: string): string[] =>
    isBlank(value) ? [] : [title, value!.trim(), ""];

  const lines = [
    header,
    "",
    ...section("TRIỆU CHỨNG", fields.symptom),
    ...section("NGUYÊN NHÂN", fields.rootCause),
    ...section("CÁCH KHẮC PHỤC", fields.resolution),
    ...section("CÁCH PHÒNG TRÁNH", fields.prevention),
  ];

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
