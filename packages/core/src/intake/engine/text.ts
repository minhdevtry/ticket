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
