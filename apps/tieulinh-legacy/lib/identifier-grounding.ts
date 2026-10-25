/**
 * Trường định danh model/LLM có thể điền từ hội thoại — SĐT, mã học sinh, mã
 * khách hàng, mã phòng, mã giao dịch, mã bài tập. Đây là những ô đội Kỹ thuật
 * dùng để TRA CỨU người dùng thật, nên bịa hoặc gộp nhầm một chữ số là dẫn
 * nhầm người.
 *
 * Dùng CHUNG giữa hai chốt chặn khác nhau, cùng một khái niệm "định danh phải
 * GROUNDED — dãy chữ số của nó phải thật sự nằm trong lời kể của người báo,
 * không phải bịa hay lẫn từ một sự cố khác":
 * - `mcp/tieulinh/domain/ticket-formatter.ts` (TECH-928 phần 1, 26/09/2026):
 *   chặn model/extractor tự bịa SĐT không ai cung cấp lúc dựng mô tả ticket.
 * - `lib/intake-step/pipeline.ts` (TECH-928 phần 2, đo lại 28/09/2026 — nguyên
 *   nhân thật): chặn việc GỘP LẶNG LẼ hai sự cố khác nhau vào cùng một tờ khai
 *   đang chờ xác nhận, khi tin nhắn mới mang định danh xung đột với tờ khai.
 */
export const IDENTIFIER_FIELD_KEYS = [
  "customerId",
  "studentAccount",
  "roomCode",
  "transactionId",
  "assignmentId",
] as const;

export type IdentifierFieldKey = (typeof IDENTIFIER_FIELD_KEYS)[number];

/** Chuẩn hoá về dãy chữ số để so khớp dù người dùng gõ có khoảng trắng, dấu chấm hay gạch ngang xen giữa. */
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
 * Hai giá trị CÙNG LOẠI định danh (vd cùng là studentAccount) coi là XUNG ĐỘT
 * khi cả hai đều có chữ số và KHÔNG bên nào là tập con chữ số của bên kia —
 * số điện thoại gõ rút gọn hay thêm mã vùng vẫn coi là cùng một số, chỉ số
 * THỰC SỰ khác nhau (khác sự cố, khác người) mới coi là xung đột.
 *
 * Đo được ở TECH-928 (26/09/2026): tờ khai đang chờ xác nhận đã có
 * `studentAccount = "0900000003"` (sự cố A: đơn hàng DH900003). Tin nhắn kế
 * tiếp của CHÍNH người báo lại mang `studentAccount = "0900000004"` — SĐT
 * thật của một đơn hàng khác (sự cố B: DH900004). Pipeline gộp lặng lẽ, ghi
 * đè A bằng B; ticket TECH-928 ra đời với tiêu đề của A nhưng SĐT của B, còn
 * B thì mất trắng — không phải model bịa, mà là hai sự cố bị nhập làm một.
 */
export function identifiersConflict(existingValue: string, incomingValue: string): boolean {
  const a = normalizeDigits(existingValue);
  const b = normalizeDigits(incomingValue);
  if (!a || !b || a === b) return false;
  return !a.includes(b) && !b.includes(a);
}
