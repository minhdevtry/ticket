import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

/**
 * Tạo `ItsaplanClient` với chính sách mạng của Tiểu Linh.
 *
 * Thư viện mặc định thử lại tới 3 lần khi gặp 429/5xx — kể cả POST. Với Tiểu Linh
 * điều đó có thể tạo ticket/comment TRÙNG nếu Itsaplan đã ghi rồi mới trả 5xx, và
 * Tiểu Linh chưa từng thử lại ở tầng này (worker tự có hàng đợi/retry riêng). Nên
 * tắt thử lại (`maxRetries: 0`); timeout mỗi request vẫn là mặc định của thư viện.
 * Muốn bật retry sau này: đổi ở đúng một chỗ này.
 */
export function createItsaplanClient(baseUrl: string, apiKey: string): ItsaplanClient {
  return new ItsaplanClient(baseUrl, apiKey, { retryOptions: { maxRetries: 0 } });
}
