/**
 * Nhãn nút bấm của bot — KHÔNG phải lời người báo.
 *
 * Khi người báo bấm nút trên Telegram, nhãn nút được gửi lại cho bot như một tin
 * nhắn thường (thay vì callback nội bộ). Nhãn vì thế có thể lọt vào `rawText` —
 * tức vào mục "### Mô tả" của ticket, là nơi chỉ nên có lời kể của người báo
 * (ADR-0010). Mô tả đúng, có nhãn nút trong đó, làm người đọc tưởng người báo
 * tự nói "Sự cố mới" (TECH-1141, TECH-1201).
 *
 * Nhãn ở đây là hằng số, dùng chung cho cả pipeline (dựng nút) và merger (lọc
 * khỏi lời kể) để không có hai danh sách lệch nhau.
 */
export const CONFIRM_LABEL = "✅ Đúng rồi, tạo ticket";
/**
 * Nhãn 2 nút hỏi "sự cố mới hay bổ sung" (TECH-928) — cố định, không phải
 * danh sách từ khoá đoán ý định: pipeline chỉ so message tiếp theo với ĐÚNG
 * hai chuỗi này (như đã làm với `CONFIRM_LABEL`/"đúng rồi" từ trước tới giờ),
 * không suy luận ý người dùng từ câu chữ tự do.
 */
export const NEW_INCIDENT_LABEL = "Sự cố mới";
/** Nút huỷ bản xem trước ghi vào ticket đã có. */
export const CANCEL_ACTION_LABEL = "Huỷ";
/** Nút giữ lại ticket khi người báo đang xem trước thao tác Hủy / Đóng ticket (ADR-0006 cập nhật 10/10/2026). */
export const KEEP_TICKET_LABEL = "Giữ lại";
/** Nút gộp tin xung đột vào tờ khai đang mở ngay lượt đó. */
export const CONTINUE_DRAFT_LABEL = "Bổ sung sự cố đang chờ";
/** Nút nhắc về tờ khai bị gác lại (`IntakeDocument.parkedDocId`) sau khi sự cố mới vừa xong. */
export const RESUME_PARKED_LABEL = "Tiếp tục sự cố đang chờ";

/**
 * Mọi nhãn nút bot, kèm lời xác nhận ("đúng rồi") — cả hai đều là lời của BOT,
 * không phải mô tả sự cố nên không được ghi vào mô tả ticket.
 */
export const BOT_BUTTON_LABELS: readonly string[] = [
  CONFIRM_LABEL,
  NEW_INCIDENT_LABEL,
  CANCEL_ACTION_LABEL,
  KEEP_TICKET_LABEL,
  CONTINUE_DRAFT_LABEL,
  RESUME_PARKED_LABEL,
  "đúng rồi",
];

/**
 * Chuẩn hoá một dòng để so sánh: bỏ dấu markdown, gộp khoảng trắng, không phân
 * biệt hoa thường. Dùng để so "dòng này đã nằm trong lời kể chưa".
 */
export function normalizeLine(text: string): string {
  return text
    .replace(/[*_`~#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Dòng này là lời của bot (nhãn nút) chứ không phải lời người báo? */
export function isBotButtonLabel(line: string): boolean {
  const normalized = normalizeLine(line);
  if (!normalized) return false;
  return BOT_BUTTON_LABELS.some((label) => normalizeLine(label) === normalized);
}
