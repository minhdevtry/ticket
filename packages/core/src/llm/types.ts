/**
 * Kiểu trung lập nhà cung cấp cho lời gọi LLM: cùng một hình dạng request/response dù đứng
 * sau là Anthropic Messages hay OpenAI Chat Completions.
 */

/** Kiểu API của endpoint LLM. */
export type LlmApi = "anthropic-messages" | "openai-chat";

/** JSON Schema (object) mô tả tham số của một tool. */
export type JsonSchema = Record<string, unknown>;

/** Một lời gọi tool do model yêu cầu. */
export interface LlmToolCall {
  /** Id do nhà cung cấp cấp; kết quả tool phải trả lại đúng id này. */
  id: string;
  name: string;
  /** Tham số đã parse. `undefined` khi model sinh JSON hỏng (xem `argsError`). */
  args: unknown;
  /** Có khi `args` không parse được thành JSON (kiểu OpenAI trả tham số dạng chuỗi). */
  argsError?: string;
  /** Chuỗi tham số nguyên văn khi `argsError` có giá trị (giữ để phát lại đúng như model đã gửi). */
  rawArgs?: string;
}

/** Tin nhắn của người dùng (hoặc đầu vào do bot đưa). */
export interface LlmUserMessage {
  role: "user";
  content: string;
}

/** Tin nhắn của model, có thể kèm lời gọi tool. */
export interface LlmAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: LlmToolCall[];
  /**
   * Phản hồi gốc của nhà cung cấp, giữ nguyên để gửi lại ở lượt sau. MiniMax (và các model có
   * suy luận xen kẽ) yêu cầu trả lại khối `thinking` trong hội thoại nhiều lượt có tool. Không
   * sửa giá trị này; nó chỉ có nghĩa với đúng kiểu `api` đã sinh ra nó.
   */
  raw?: { api: LlmApi; value: unknown };
}

/** Kết quả của một lời gọi tool, trả lại cho model. */
export interface LlmToolMessage {
  role: "tool";
  /** Id của `LlmToolCall` đang trả lời. */
  toolCallId: string;
  /** Tên tool (không bắt buộc; OpenAI không cần, một số proxy cần). */
  name?: string;
  content: string;
  /** Kết quả là lỗi (tham số sai, tool ném lỗi): model nên sửa và thử lại. */
  isError?: boolean;
}

/** Tin nhắn trong hội thoại. */
export type LlmMessage = LlmUserMessage | LlmAssistantMessage | LlmToolMessage;

/** Khai báo tool gửi cho model. */
export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema kiểu `object`. */
  parameters: JsonSchema;
}

/** Cách model chọn tool. */
export type LlmToolChoice = "auto" | "none" | "required" | { name: string };

/** Một lời gọi `complete`. */
export interface LlmRequest {
  system?: string;
  messages: readonly LlmMessage[];
  tools?: readonly LlmToolSpec[];
  toolChoice?: LlmToolChoice;
  /** Mặc định 4096. */
  maxTokens?: number;
  /** Không gửi nếu bỏ trống (dùng mặc định của nhà cung cấp; một số model từ chối 0). */
  temperature?: number;
  /**
   * Hạn TỔNG (ms) cho lời gọi này, gồm mọi lần thử lại và thời gian chờ backoff. Ghi đè
   * `deadlineMs` của client; `0` = không giới hạn. Quá hạn ném `LlmTimeoutError` (`scope: "deadline"`).
   */
  deadlineMs?: number;
  /** Ghi đè model của client cho riêng lời gọi này. */
  model?: string;
  /** Huỷ lời gọi (kể cả đang chờ backoff). Không bao giờ được thử lại sau khi huỷ. */
  signal?: AbortSignal;
}

/**
 * Số token đã dùng. `inputTokens` là MỌI token đầu vào, gồm cả phần đọc/ghi cache (với Anthropic:
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; với OpenAI:
 * `prompt_tokens`), nên `totalTokens = inputTokens + outputTokens` và trần token tính cả cache.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Phần của `inputTokens` đọc từ cache prompt (0 nếu nhà cung cấp không báo). */
  cacheReadTokens: number;
  /** Phần của `inputTokens` ghi vào cache prompt (0 nếu nhà cung cấp không báo). */
  cacheCreationTokens: number;
}

/** Vì sao model dừng. */
export type LlmStopReason = "end" | "tool_use" | "max_tokens" | "content_filter" | "other";

/** Phản hồi của `complete`. */
export interface LlmResponse {
  /** Văn bản của model (đã bỏ khối suy luận), `""` nếu chỉ gọi tool. */
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** Model do server báo (hoặc model đã yêu cầu nếu server không báo). */
  model: string;
  /** Tin nhắn assistant tương ứng, dùng thẳng để nối vào `messages` của lượt sau. */
  message: LlmAssistantMessage;
}

/**
 * Sự kiện dùng token (cho hook dùng/chi phí): một sự kiện cho mỗi lần gọi HTTP mà server đã
 * báo token, kể cả lần hỏng (phản hồi 2xx sai hình dạng, `outcome: "error"`) và lần được thử
 * lại, vì các lần đó vẫn bị tính tiền. Lần lỗi HTTP không có số token thì không có sự kiện.
 */
export interface LlmUsageEvent {
  /** `error`: phản hồi hỏng nhưng server đã báo token. */
  outcome: "ok" | "error";
  api: LlmApi;
  model: string;
  usage: LlmUsage;
  stopReason: LlmStopReason;
  /** Tổng thời gian tính tới sự kiện này, gồm cả các lần thử lại trước đó (ms). */
  durationMs: number;
  /** Số lần gọi HTTP đã thực hiện tới lúc này (1 = lần đầu). */
  attempts: number;
}

/** Client LLM. Dựng bằng `createLlm`. */
export interface Llm {
  readonly api: LlmApi;
  readonly model: string;
  /** Gọi model một lần (có thử lại khi 429/5xx/mạng/hết giờ từng lần). */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
