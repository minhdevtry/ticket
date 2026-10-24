/**
 * Đường báo động cho quản trị viên.
 *
 * Sinh ra từ sự cố 14/09/2026: `sendMessage` trả `400 BUTTON_DATA_INVALID`,
 * bot im hẳn với người dùng, và dấu vết duy nhất là một dòng trong
 * `journalctl` mà không ai đọc. Hỏng câm suốt ba ngày. Log là để điều tra
 * SAU khi biết có chuyện — nó không thay được việc phải báo cho ai đó.
 *
 * Cố tình "bắn rồi quên": báo động hỏng thì tuyệt đối không được làm gãy
 * luồng đang chạy. Và cố tình chống lặp: những chỗ gọi hàm này nằm trong
 * đường đi của MỖI lượt chat, nên không gom lại thì một lỗi dai dẳng sẽ thành
 * hàng trăm tin nhắn — spam tới mức bị bỏ qua thì cũng bằng không báo.
 */
import { getLogger } from "../logger";
import { TelegramTransport } from "./transport";

/** Cùng một nội dung báo động chỉ gửi lại sau ngần này. */
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

export interface AlertConfig {
  botToken?: string;
  /** Chat nhận báo động. Thiếu thì chỉ ghi log. */
  chatId?: string;
}

let config: AlertConfig | null = null;
const lastSentAt = new Map<string, number>();

/** Cấu hình mặc định lấy từ biến môi trường, để mọi tiến trình dùng chung một lối. */
function resolveConfig(): AlertConfig {
  if (config) return config;
  const adminIds = (process.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.ALERT_CHAT_ID ?? adminIds[0],
  };
  return config;
}

/** Cho host tự khai, thay vì đọc môi trường. Gọi một lần lúc khởi động. */
export function configureAlerts(next: AlertConfig | null): void {
  config = next;
  lastSentAt.clear();
}

/**
 * Báo cho quản trị viên biết có chuyện. Không `await` — hỏng thì chịu, nhưng
 * luồng chính phải chạy tiếp.
 *
 * `key` là thứ dùng để chống lặp. Đặt theo LOẠI sự cố, đừng nhét giá trị thay
 * đổi từng lượt vào, không thì chống lặp thành vô nghĩa.
 */
export function alertAdmin(key: string, text: string): void {
  const now = Date.now();
  const previous = lastSentAt.get(key);
  if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) return;
  lastSentAt.set(key, now);

  getLogger().error(`[alert] ${text}`);

  const { botToken, chatId } = resolveConfig();
  if (!botToken || !chatId) {
    getLogger().warn(
      "[alert] Chưa có TELEGRAM_BOT_TOKEN hoặc ALERT_CHAT_ID/ADMIN_IDS — báo động chỉ nằm trong log.",
    );
    return;
  }

  void new TelegramTransport({ botToken, timeoutMs: 10_000 })
    .tryCall("sendMessage", { chat_id: chatId, text: `⚠️ ${text}` })
    .catch(() => {
      /* `tryCall` đã log; báo động hỏng thì không còn đường nào để báo nữa */
    });
}
