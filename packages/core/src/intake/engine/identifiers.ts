/**
 * Identifier grounding (ticket 09) — pure helpers for the identifier-conflict
 * park (TECH-928). Carried verbatim-in-behaviour from intake
 * `lib/identifier-grounding.ts`, kept channel/tracker free.
 *
 * The engine never fabricates an identifier and never silently merges two
 * incidents whose identifiers disagree: a message carrying a conflicting
 * phone/student/order id parks and asks "new incident or append?" rather than
 * overwriting the draft (TECH-928: incident B merged into A's draft, B lost).
 */
import type { IdentifierKey } from "../ports";
import type { LabelledIdentifiers } from "../extractor/heuristics";
export {
  type LabelledIdentifiers,
  extractLabelledIdentifiers,
  extractBlockInfo,
} from "../extractor/heuristics";

/** Collapse to the digit run so spacing/dots/dashes don't matter. */
export function normalizeDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

/**
 * Giá trị chỉ đáng tin khi dãy chữ số của nó THẬT SỰ nằm trong nguồn đối
 * chiếu (đã chuẩn hoá số sẵn — vd lời kể của người báo). Giá trị không có
 * chữ số nào (mã toàn chữ) thì không đối chiếu được bằng cách này — coi như
 * grounded, giữ nguyên hành vi cũ thay vì chặn nhầm.
 */
export function isGroundedInDigits(value: string, sourceDigits: string): boolean {
  const digits = normalizeDigits(value);
  if (!digits) return true;
  return sourceDigits.includes(digits);
}

/** Mẫu SĐT/mã Việt Nam dùng để moi lại giá trị THẬT từ lời kể khi giá trị model điền bị bỏ vì không grounded. */
export const PHONE_OR_ACCOUNT_PATTERN = /(0\d{9,10}|\b\d{9,11}\b)/g;

/** Số điện thoại/mã thật sự có trong một đoạn văn bản — dùng để thay cho giá trị bịa bị bỏ, thay vì để trống. */
export function recoverAccountFromText(text: string): string | undefined {
  const matches = text.match(PHONE_OR_ACCOUNT_PATTERN);
  return matches?.length ? [...new Set(matches)].join(", ") : undefined;
}

/**
 * Two values of the SAME identifier kind conflict when both carry digits and
 * neither digit-run contains the other — a shortened phone or an added area
 * code is still the same number; genuinely different digits mean a different
 * incident/person (TECH-928).
 */
export function identifiersConflict(existingValue: string, incomingValue: string): boolean {
  const a = normalizeDigits(existingValue);
  const b = normalizeDigits(incomingValue);
  if (!a || !b || a === b) return false;
  return !a.includes(b) && !b.includes(a);
}

/**
 * Does any identifier field the incoming turn carries conflict with the same
 * field already captured in the draft? Returns the first conflicting key, or
 * null. This is the TECH-928 gate.
 */
export function findIdentifierConflict(
  existing: Partial<Record<IdentifierKey, string>>,
  incoming: Partial<Record<IdentifierKey, string>>,
): IdentifierKey | null {
  for (const key of Object.keys(incoming) as IdentifierKey[]) {
    const was = existing[key];
    const now = incoming[key];
    if (was && now && identifiersConflict(was, now)) return key;
  }
  return null;
}

/**
 * Hai bộ định danh có XUNG ĐỘT không? Chỉ so CÙNG LỚP (khách hàng với khách hàng,
 * học sinh với học sinh, SĐT với SĐT) và chỉ khi CẢ HAI bên đều có giá trị — "giá
 * trị mới mà tờ khai chưa từng có" KHÔNG phải xung đột. Tên người không tham gia.
 */
export function identityConflict(
  existing: LabelledIdentifiers,
  incoming: LabelledIdentifiers,
): "customer" | "student" | "phone" | undefined {
  for (const kind of ["customer", "student", "phone"] as const) {
    const a = existing[kind];
    const b = incoming[kind];
    if (a && b && identifiersConflict(a, b)) return kind;
  }
  return undefined;
}
