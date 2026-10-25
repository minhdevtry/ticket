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
  temperature?: number;
  /** Ghi đè model của client cho riêng lời gọi này. */
  model?: string;
  /** Huỷ lời gọi (kể cả đang chờ backoff). Không bao giờ được thử lại sau khi huỷ. */
  signal?: AbortSignal;
}

/** Số token đã dùng. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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

/** Sự kiện báo mỗi lời gọi `complete` thành công (cho hook dùng/chi phí). */
export interface LlmUsageEvent {
  api: LlmApi;
  model: string;
  usage: LlmUsage;
  stopReason: LlmStopReason;
  /** Tổng thời gian gồm cả các lần thử lại (ms). */
  durationMs: number;
  /** Số lần gọi HTTP đã thực hiện (1 = không phải thử lại). */
  attempts: number;
}

/** Client LLM. Dựng bằng `createLlm`. */
export interface Llm {
  readonly api: LlmApi;
  readonly model: string;
  /** Gọi model một lần (có thử lại khi 429/5xx/mạng). */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
