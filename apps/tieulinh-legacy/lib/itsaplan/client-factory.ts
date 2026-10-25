import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

/**
 * Tạo `ItsaplanClient` với chính sách mạng của Tiểu Linh — giữ NGUYÊN hành vi
 * của bản client cũ của bot, bằng tuỳ chọn tường minh (thư viện có mặc định tốt
 * hơn cho bot mới, nhưng Tiểu Linh là baseline đóng băng):
 *
 * - `retryOptions.maxRetries: 0` — thư viện mặc định thử lại 3 lần khi 429/5xx, kể
 *   cả POST: có thể tạo ticket/comment TRÙNG nếu Itsaplan đã ghi rồi mới trả 5xx.
 *   Tiểu Linh chưa từng thử lại ở tầng này (worker tự có hàng đợi/retry riêng).
 * - `timeoutMs: 0` — không timeout. Bản cũ không có; abort giữa chừng một request
 *   ghi chậm rồi thử lại có thể sinh bản trùng, và upload lớn bị cắt.
 * - `strictResponses: false` — 2xx body rỗng → `{}`, không phải JSON → trả chuỗi,
 *   như cũ (thay vì ném `ItsaplanMalformedResponseError`).
 */
export const TIEULINH_ITSAPLAN_CLIENT_OPTIONS = {
  retryOptions: { maxRetries: 0 },
  timeoutMs: 0,
  strictResponses: false,
} as const;

export function createItsaplanClient(baseUrl: string, apiKey: string): ItsaplanClient {
  return new ItsaplanClient(baseUrl, apiKey, { ...TIEULINH_ITSAPLAN_CLIENT_OPTIONS });
}
