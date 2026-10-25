/**
 * Lỗi có kiểu của lớp LLM. Không lỗi nào chứa API key: thông điệp được che theo giá trị key
 * và không bao giờ chứa header.
 */
import type { LlmApi } from "./types";

/** Gốc của mọi lỗi LLM. */
export class LlmError extends Error {
  /** Thử lại có thể thành công (429, 5xx, mạng, hết giờ). */
  readonly retryable: boolean;
  /**
   * Cùng nghĩa với `retryable`, theo tên mà `isTransientError` (`@vuihoc/bot-core/itsaplan`)
   * nhận ra: handler ném lỗi này thì run được đóng là `retry` thay vì `failed`.
   */
  readonly transient: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmError";
    this.retryable = options.retryable ?? false;
    this.transient = this.retryable;
  }
}

/** Server LLM trả HTTP lỗi (sau khi đã thử lại hết số lần cho phép nếu lỗi tạm thời). */
export class LlmApiError extends LlmError {
  readonly status: number;
  readonly api: LlmApi;
  /** Phần đầu của thân phản hồi lỗi (đã cắt, đã che key). */
  readonly body: string;
  /** Giá trị `Retry-After` server yêu cầu (ms), nếu có. */
  readonly retryAfterMs: number | null;
  /** Số lần gọi HTTP đã thực hiện cho yêu cầu này. */
  readonly attempts: number;

  constructor(init: {
    status: number;
    api: LlmApi;
    body: string;
    message: string;
    retryAfterMs?: number | null;
    attempts?: number;
  }) {
    super(init.message, { retryable: init.status === 429 || init.status >= 500 });
    this.name = "LlmApiError";
    this.status = init.status;
    this.api = init.api;
    this.body = init.body;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.attempts = init.attempts ?? 1;
  }
}

/** Không tới được server (DNS, kết nối bị từ chối/ngắt…). Luôn `retryable`. */
export class LlmNetworkError extends LlmError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = "LlmNetworkError";
  }
}

/** Một lần gọi quá `timeoutMs`. Luôn `retryable`. */
export class LlmTimeoutError extends LlmError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`LLM không trả lời trong ${timeoutMs} ms`, { retryable: true });
    this.name = "LlmTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Người gọi huỷ (`signal`). Không bao giờ `retryable`. */
export class LlmAbortError extends LlmError {
  constructor(message = "Lời gọi LLM bị huỷ") {
    super(message);
    this.name = "LlmAbortError";
  }
}

/** Server trả 2xx nhưng nội dung không đúng hình dạng đã hứa. Không `retryable`. */
export class LlmResponseError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseError";
  }
}

/** Cấu hình LLM thiếu hoặc sai (dựng client, hoặc handler cần LLM mà bot chưa cấu hình). */
export class LlmConfigError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}
