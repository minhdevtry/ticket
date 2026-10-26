/**
 * `createLlm`: client LLM tối thiểu, không phụ thuộc SDK. Gọi HTTP trần tới endpoint tương
 * thích Anthropic Messages hoặc OpenAI Chat Completions (mặc định của bot VuiHoc: MiniMax).
 *
 * Base URL và key luôn do config đưa vào, không có giá trị mặc định nào được viết cứng. Môi
 * trường dev đi qua proxy giữ secret chạy cục bộ nên base URL có thể là `http://127.0.0.1:<cổng>`.
 *
 * Thử lại CHỈ với 429, 5xx, lỗi mạng và hết giờ từng lần gọi; backoff luỹ thừa có jitter, tôn
 * trọng `Retry-After` (nếu server đòi chờ lâu hơn `maxRetryAfterMs` thì thất bại ngay thay vì
 * thử sớm). Có hạn TỔNG `deadlineMs` cho cả lời gọi (gồm backoff). Huỷ bằng `signal` thì dừng
 * ngay, không thử lại.
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
  /**
   * Hạn TỔNG cho một `complete` gồm mọi lần thử lại và backoff (ms). Mặc định 120 000; `0` =
   * không giới hạn. Request ghi đè được bằng `LlmRequest.deadlineMs`. Quá hạn ném
   * `LlmTimeoutError` với `scope: "deadline"`.
   */
  deadlineMs?: number;
  /** Số lần THỬ LẠI tối đa sau lần đầu (tổng lần gọi = `maxRetries + 1`). Mặc định 2. */
  maxRetries?: number;
  /** Nền của backoff (ms). Mặc định 500. */
  retryBaseDelayMs?: number;
  /** Trần backoff tự tính (ms). Mặc định 8000. */
  retryMaxDelayMs?: number;
  /** Trần cho `Retry-After` của server (ms). Server đòi lâu hơn thì không thử lại. Mặc định 30 000. */
  maxRetryAfterMs?: number;
  /** Thay `fetch` (test, proxy). */
  fetch?: typeof fetch;
  /** Gọi sau mỗi lần gọi HTTP đã biết token (kể cả lần hỏng): ghi token/chi phí. Lỗi trong hook bị nuốt. */
  onUsage?: (event: LlmUsageEvent) => void;
  /** Thay hàm ngủ (test). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Thay nguồn ngẫu nhiên của backoff (test). Mặc định `Math.random`; truyền hàm cố định
   * để thời gian chờ giữa các lần thử lại là tất định.
   */
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DEADLINE_MS = 120_000;
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
  const defaultDeadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  const baseDelay = options.retryBaseDelayMs ?? 500;
  const maxDelay = options.retryMaxDelayMs ?? 8000;
  const random = options.random ?? Math.random;
  const maxRetryAfter = options.maxRetryAfterMs ?? 30_000;
  const scrub = createScrubber([apiKey]);
  const clean = (text: string): string => String(scrub(redactUrlCredentials(text)));

  /** Một lần gọi HTTP. Ném lỗi đã phân loại. */
  async function attemptOnce(
    body: string,
    model: string,
    signal: AbortSignal | undefined,
    attempts: number,
    deadline: { at: number; ms: number } | null,
  ): Promise<LlmResponse> {
    if (signal?.aborted) throw new LlmAbortError();
    const remaining = deadline ? deadline.at - Date.now() : Number.POSITIVE_INFINITY;
    if (deadline && remaining <= 0) throw new LlmTimeoutError(deadline.ms, "deadline");
    const attemptMs = timeoutMs > 0 ? timeoutMs : Number.POSITIVE_INFINITY;
    const limitMs = Math.min(attemptMs, remaining);
    const timer = Number.isFinite(limitMs) ? AbortSignal.timeout(Math.ceil(limitMs)) : undefined;
    const timedOut = (): LlmTimeoutError =>
      deadline && remaining <= attemptMs
        ? new LlmTimeoutError(deadline.ms, "deadline")
        : new LlmTimeoutError(timeoutMs);
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
      if (timer?.aborted) throw timedOut();
      const reason = clean(err instanceof Error ? err.message : String(err));
      throw new LlmNetworkError(`Không gọi được LLM (${api}): ${reason}`, safeCause(err, reason));
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
      if (timer?.aborted) throw timedOut();
      throw new LlmResponseError(
        `Phản hồi LLM (${api}) không phải JSON: ${clean((err as Error).message)}`,
      );
    }
    return api === "anthropic-messages"
      ? parseAnthropicResponse(json, model)
      : parseOpenAiResponse(json, model);
  }

  /** Báo token cho hook; hook hỏng không được làm hỏng lời gọi. */
  const report = (event: LlmUsageEvent): void => {
    if (!options.onUsage) return;
    try {
      options.onUsage(event);
    } catch {
      // bỏ qua
    }
  };

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
      const deadlineMs = request.deadlineMs ?? defaultDeadlineMs;
      const deadline = deadlineMs > 0 ? { at: started + deadlineMs, ms: deadlineMs } : null;
      let attempts = 0;
      while (true) {
        attempts++;
        try {
          const response = await attemptOnce(body, model, request.signal, attempts, deadline);
          report({
            outcome: "ok",
            api,
            model: response.model,
            usage: response.usage,
            stopReason: response.stopReason,
            durationMs: Date.now() - started,
            attempts,
          });
          return response;
        } catch (err) {
          if (err instanceof LlmResponseError && err.usage) {
            // Phản hồi hỏng nhưng server đã tính tiền: vẫn phải vào sổ.
            report({
              outcome: "error",
              api,
              model,
              usage: err.usage,
              stopReason: "other",
              durationMs: Date.now() - started,
              attempts,
            });
          }
          if (!(err instanceof LlmError) || !err.retryable || attempts > maxRetries) throw err;
          const retryAfter = err instanceof LlmApiError ? err.retryAfterMs : null;
          // Server đòi chờ lâu hơn trần: thử sớm chỉ tốn thêm một lần bị từ chối, nên dừng luôn.
          if (retryAfter !== null && retryAfter > maxRetryAfter) throw err;
          const delay = retryAfter ?? calculateBackoff(attempts, baseDelay, maxDelay, random);
          // Không đủ thời gian để chờ rồi gọi lại trong hạn tổng: trả lỗi thật thay vì ngủ vô ích.
          if (deadline && Date.now() + delay >= deadline.at) throw err;
          await sleep(delay, request.signal);
        }
      }
    },
  };
}

/** Bản sao của lỗi fetch với thông điệp đã che key (không giữ URL/header của lỗi gốc). */
function safeCause(err: unknown, cleanMessage: string): Error {
  const copy = new Error(cleanMessage);
  if (err instanceof Error) {
    copy.name = err.name;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") (copy as { code?: string }).code = code;
  }
  return copy;
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
