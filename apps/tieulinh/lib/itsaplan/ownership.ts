/**
 * Yêu cầu / ticket có phải của chính người đang chat không.
 *
 * Căn cứ: binding của mã đó thuộc chat này, hoặc mô tả ghi Telegram ID của họ
 * (ticket tạo bằng bot cũ chưa có binding). Dùng chung cho tra cứu và bổ sung của IRIS —
 * PO 01/10: IRIS đọc cả yêu cầu của người khác (PO-84, PO-87) rồi kể lại.
 */
import type { TicketBindingRepository } from "../storage/binding-repository";

function bareChat(chatId: string | number): string {
  return String(chatId).replace(/^telegram:/i, "");
}

export function isOwnTicket(
  repo: Pick<TicketBindingRepository, "getBindingByIdentifier"> | undefined,
  identifier: string,
  description: string | undefined,
  chatId: string | number | undefined,
): boolean {
  if (chatId === undefined || chatId === null || chatId === "") return false;
  const bare = bareChat(chatId);
  const binding = repo?.getBindingByIdentifier(identifier);
  if (binding && bareChat(binding.chatId) === bare) return true;
  return (
    /^\d{5,}$/.test(bare) &&
    Boolean(description) &&
    new RegExp(`(?<!\\d)${bare}(?!\\d)`).test(description!)
  );
}
