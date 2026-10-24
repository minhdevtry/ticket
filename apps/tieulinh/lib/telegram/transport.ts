/**
 * Một cổng duy nhất ra Telegram Bot API.
 *
 * Trước đây `worker/notifier.ts` và `worker/telegram-handler.ts` mỗi bên tự
 * viết lấy một wrapper `fetch`, và lệch nhau ở những chỗ không ai cố ý: một
 * bên timeout 15s ném lỗi, bên kia 10s nuốt lỗi và trả nguyên body thay vì
 * `result`. Gom về đây thì cách gọi, cách đọc lỗi và cách bóc `result` chỉ
 * còn một bản.
 *
 * Hai chính sách lỗi vẫn giữ, nhưng giờ là lựa chọn tường minh chứ không phải
 * lệch ngẫu nhiên: `call` ném lỗi cho việc chính (gửi thông báo — hỏng là
 * phải biết), `tryCall` nuốt lỗi cho việc phụ (đóng nút, trả lời callback —
 * hỏng cũng không được làm gãy luồng).
 */
import { getLogger } from "@vuihoc/bot-core/core";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface TelegramTransportOptions {
  botToken: string;
  /** Mặc định 15s. Luồng webhook cần trả nhanh thì truyền ngắn hơn. */
  timeoutMs?: number;
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  description?: string;
  result?: T;
}

export class TelegramTransport {
  private readonly botToken: string;
  private readonly timeoutMs: number;

  constructor(options: TelegramTransportOptions) {
    this.botToken = options.botToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Gọi Bot API. Ném lỗi khi Telegram báo hỏng. Trả thẳng `result`. */
  async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as TelegramEnvelope<T>;
    if (!res.ok || body?.ok === false) {
      throw new Error(`Telegram ${method} lỗi: ${body?.description ?? res.status}`);
    }
    return body.result as T;
  }

  /** Như `call` nhưng hỏng thì ghi log rồi trả `null`, không làm gãy luồng gọi. */
  async tryCall<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.call<T>(method, payload);
    } catch (err: any) {
      getLogger().warn(`[telegram] Gọi ${method} thất bại: ${err.message}`);
      return null;
    }
  }

  /** Gửi multipart/form-data tới Telegram Bot API (cho sendPhoto, sendVideo, sendDocument dạng file upload). */
  async sendFormData<T = unknown>(method: string, formData: FormData): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as TelegramEnvelope<T>;
    if (!res.ok || body?.ok === false) {
      throw new Error(`Telegram ${method} (form-data) lỗi: ${body?.description ?? res.status}`);
    }
    return body.result as T;
  }

  /** Như `sendFormData` nhưng hỏng thì ghi log rồi trả null. */
  async trySendFormData<T = unknown>(method: string, formData: FormData): Promise<T | null> {
    try {
      return await this.sendFormData<T>(method, formData);
    } catch (err: any) {
      getLogger().warn(`[telegram] Gửi form-data ${method} thất bại: ${err.message}`);
      return null;
    }
  }

  /** Tải file theo `file_path` mà `getFile` trả về. */
  async downloadFile(filePath: string): Promise<Buffer> {
    const res = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Telegram tải file lỗi: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
