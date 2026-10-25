/**
 * `createLlm`: client LLM tối thiểu, không phụ thuộc SDK. Gọi HTTP trần tới endpoint tương
 * thích Anthropic Messages hoặc OpenAI Chat Completions (mặc định của bot VuiHoc: MiniMax).
 *
 * Base URL và key luôn do config đưa vào, không có giá trị mặc định nào được viết cứng. Môi
 * trường dev đi qua proxy giữ secret chạy cục bộ nên base URL có thể là `http://127.0.0.1:<cổng>`.
 *
 * Thử lại CHỈ với 429, 5xx, lỗi mạng và hết giờ từng lần gọi; backoff luỹ thừa có jitter, tôn
 * trọng `Retry-After`. Huỷ bằng `signal` thì dừng ngay, không thử lại.
 */
import { createScrubber, redactUrlCredentials } from "../core/config";
import { calculateBackoff, parseRetryAfter } from "../itsaplan/http";
import {
  LlmAbortError,
  LlmApiError,
  LlmConfigError,
  LlmError,
  LlmNetworkError,
  LlmResponseError,
  LlmTimeoutError,
} from "./errors";
import type { Llm, LlmApi, LlmRequest, LlmResponse, LlmUsageEvent } from "./types";
import {
  buildAnthropicBody,
  buildOpenAiBody,
  endpointUrl,
  parseAnthropicResponse,
  parseOpenAiResponse,
  requestHeaders,
} from "./wire";

/** Tuỳ chọn của {@link createLlm}. */
export interface CreateLlmOptions {
  /**
   * Gốc API. `anthropic-messages`: không có `/v1` (client thêm `/v1/messages`), vd
   * `http://127.0.0.1:18999`. `openai-chat`: gồm `/v1` (client thêm `/chat/completions`).
   */
  baseUrl: string;
  /** Khoá API. Rỗng = không gửi header xác thực. Không bao giờ vào thông điệp lỗi. */
  apiKey: string;
  /** Model mặc định (request có thể ghi đè). */
  model: string;
  api: LlmApi;
  /** Hạn cho MỖI lần gọi HTTP (ms). Mặc định 60 000; `0` = không giới hạn. */
  timeoutMs?: number;
  /** Số lần THỬ LẠI tối đa sau lần đầu (tổng lần gọi = `maxRetries + 1`). Mặc định 2. */
  maxRetries?: number;
  /** Nền của backoff (ms). Mặc định 500. */
  retryBaseDelayMs?: number;
  /** Trần backoff tự tính (ms). Mặc định 8000. */
  retryMaxDelayMs?: number;
  /** Trần cho `Retry-After` của server (ms). Mặc định 30 000. */
  maxRetryAfterMs?: number;
  /** Thay `fetch` (test, proxy). */
  fetch?: typeof fetch;
  /** Gọi sau mỗi `complete` thành công: ghi token/chi phí. Lỗi trong hook bị nuốt. */
  onUsage?: (event: LlmUsageEvent) => void;
  /** Thay hàm ngủ (test). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const BODY_SNIPPET_CHARS = 300;

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Dựng client LLM. Ném `LlmConfigError` nếu `baseUrl`/`model`/`api` sai. */
export function createLlm(options: CreateLlmOptions): Llm {
  if (options.api !== "anthropic-messages" && options.api !== "openai-chat") {
    throw new LlmConfigError(
      `api phải là "anthropic-messages" hoặc "openai-chat" (nhận ${String(options.api)})`,
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.baseUrl);
  } catch {
    throw new LlmConfigError("baseUrl không phải URL hợp lệ");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new LlmConfigError("baseUrl phải là http(s)");
  }
  if (!options.model) throw new LlmConfigError("model không được rỗng");

  const { api, apiKey } = options;
  const url = endpointUrl(api, options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  const baseDelay = options.retryBaseDelayMs ?? 500;
  const maxDelay = options.retryMaxDelayMs ?? 8000;
  const maxRetryAfter = options.maxRetryAfterMs ?? 30_000;
  const scrub = createScrubber([apiKey]);
  const clean = (text: string): string => String(scrub(redactUrlCredentials(text)));

  /** Một lần gọi HTTP. Ném lỗi đã phân loại. */
  async function attemptOnce(
    body: string,
    model: string,
    signal: AbortSignal | undefined,
    attempts: number,
  ): Promise<LlmResponse> {
    if (signal?.aborted) throw new LlmAbortError();
    const timer = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined =
      signal && timer ? AbortSignal.any([signal, timer]) : (signal ?? timer ?? undefined);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: requestHeaders(api, apiKey),
        body,
        signal: combined,
        redirect: "manual",
      });
    } catch (err) {
      if (signal?.aborted) throw new LlmAbortError();
      if (timer?.aborted) throw new LlmTimeoutError(timeoutMs);
      throw new LlmNetworkError(
        `Không gọi được LLM (${api}): ${clean(err instanceof Error ? err.message : String(err))}`,
        err,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const snippet = clean(extractErrorMessage(text)).slice(0, BODY_SNIPPET_CHARS);
      throw new LlmApiError({
        status: res.status,
        api,
        body: snippet,
        message: `LLM (${api}) trả HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        attempts,
      });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (signal?.aborted) throw new LlmAbortError();
      if (timer?.aborted) throw new LlmTimeoutError(timeoutMs);
      throw new LlmResponseError(
        `Phản hồi LLM (${api}) không phải JSON: ${clean((err as Error).message)}`,
      );
    }
    return api === "anthropic-messages"
      ? parseAnthropicResponse(json, model)
      : parseOpenAiResponse(json, model);
  }

  return {
    api,
    model: options.model,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const model = request.model ?? options.model;
      const body = JSON.stringify(
        api === "anthropic-messages"
          ? buildAnthropicBody(request, model)
          : buildOpenAiBody(request, model),
      );
      const started = Date.now();
      let attempts = 0;
      while (true) {
        attempts++;
        try {
          const response = await attemptOnce(body, model, request.signal, attempts);
          if (options.onUsage) {
            try {
              options.onUsage({
                api,
                model: response.model,
                usage: response.usage,
                stopReason: response.stopReason,
                durationMs: Date.now() - started,
                attempts,
              });
            } catch {
              // hook hỏng không được làm hỏng lời gọi
            }
          }
          return response;
        } catch (err) {
          if (!(err instanceof LlmError) || !err.retryable || attempts > maxRetries) throw err;
          const retryAfter = err instanceof LlmApiError ? err.retryAfterMs : null;
          const delay =
            retryAfter !== null
              ? Math.min(maxRetryAfter, retryAfter)
              : calculateBackoff(attempts, baseDelay, maxDelay);
          await sleep(delay, request.signal);
        }
      }
    },
  };
}

/** Lấy thông điệp từ thân lỗi dạng `{ error: { message } }` / `{ error: "…" }`; không thì cả thân. */
function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed?.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // không phải JSON
  }
  return text;
}
