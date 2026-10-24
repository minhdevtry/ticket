/**
 * Đường báo động cho quản trị viên của Tiểu Linh.
 *
 * Sinh ra từ sự cố 14/09/2026: `sendMessage` trả `400 BUTTON_DATA_INVALID`, bot im
 * hẳn với người dùng, và dấu vết duy nhất là một dòng trong `journalctl` mà không
 * ai đọc. Phần "bắn rồi quên" + chống lặp nằm ở `Alerter` của
 * `@vuihoc/bot-core/telegram`; thư viện không đọc `process.env`, nên file này giữ
 * mặt tiền theo biến môi trường (`alertAdmin(key, text)`, `configureAlerts`).
 */
import { Alerter, TelegramTransport } from "@vuihoc/bot-core/telegram";

export interface AlertConfig {
  botToken?: string;
  /** Chat nhận báo động. Thiếu thì chỉ ghi log. */
  chatId?: string;
}

let config: AlertConfig | null = null;
let alerter: Alerter | null = null;

/** Cấu hình mặc định lấy từ biến môi trường, để mọi tiến trình dùng chung một lối. */
function resolveConfig(): AlertConfig {
  if (config) return config;
  const adminIds = (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.ALERT_CHAT_ID ?? adminIds[0],
  };
  return config;
}

function getAlerter(): Alerter {
  if (alerter) return alerter;
  const { botToken, chatId } = resolveConfig();
  alerter =
    botToken && chatId
      ? new Alerter({
          // Không thử lại khi 429: giữ nguyên hành vi cũ, báo động hỏng thì bỏ.
          transport: new TelegramTransport({ botToken, timeoutMs: 10_000, maxRetries: 0 }),
          adminChatIds: [chatId],
        })
      : new Alerter();
  return alerter;
}

/** Cho host tự khai, thay vì đọc môi trường. Gọi một lần lúc khởi động. */
export function configureAlerts(next: AlertConfig | null): void {
  config = next;
  alerter = null; // dựng lại với cấu hình mới; đồng thời xoá bộ nhớ chống lặp
}

/**
 * Báo cho quản trị viên biết có chuyện. Không `await` — hỏng thì chịu, nhưng
 * luồng chính phải chạy tiếp.
 *
 * `key` là thứ dùng để chống lặp (30 phút). Đặt theo LOẠI sự cố, đừng nhét giá
 * trị thay đổi từng lượt vào, không thì chống lặp thành vô nghĩa.
 */
export function alertAdmin(key: string, text: string): void {
  getAlerter().alert(key, text);
}
