/**
 * Generic retrying HTTP helper — ported from CM `cm/lib/http-client.ts`.
 *
 * NOTE (ticket 04): this is a generic utility, not Itsaplan-specific. It lives
 * under `src/itsaplan/` for now because that is the only consumer in this layer;
 * it could move to `src/core/http.ts` later (see `## Comments`). Kept dependency
 * -free except for the core logger so a compiled binary stays small.
 *
 * MERGED (0.1.0): taken wholesale from CM — intake had no standalone retry
 * helper (it inlined a non-retrying `fetch` in its client). CM is the strict
 * superset here, so CM wins.
 */
import { getLogger } from "../core/logger";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatuses?: number[];
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /**
   * Thời gian chờ tối đa cho MỖI lần thử (ms). Tín hiệu huỷ được tạo lại cho từng lần
   * thử nên retry vẫn có đủ thời gian chờ.
   */
  timeoutMs?: number;
  /**
   * Trần riêng cho giá trị `Retry-After` mà server yêu cầu chờ (ms). Mặc định
   * {@link MAX_HONOURED_RETRY_AFTER_MS}. Tách khỏi `maxDelayMs` vì hai thứ khác
   * nhau: `maxDelayMs` chặn backoff tự tính, còn đây chặn một header do server gửi.
   */
  maxRetryAfterMs?: number;
}

/** Trần chờ theo `Retry-After`: xa hơn mọi hạn mức thật, nhưng không để header sai treo tiến trình. */
export const MAX_HONOURED_RETRY_AFTER_MS = 300_000;

export class HttpError extends Error {
  status: number;
  headers?: Headers;
  data?: unknown;

  constructor(status: number, message: string, headers?: Headers, data?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
    this.data = data;
  }
}

/** Exponential backoff with full jitter. */
export function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/** Parse a `Retry-After` header value (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(headerValue?: string | null): number | null {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (!isNaN(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }
  const asDate = Date.parse(headerValue);
  if (!isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

/** Run an async op with exponential backoff and HTTP 429 Retry-After support. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const retryStatuses = options.retryOnStatuses ?? [429, 500, 502, 503, 504];

  let attempt = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (err: unknown) {
      attempt++;
      if (attempt > maxRetries) {
        throw err;
      }

      let delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
      let isRetryable = false;

      if (err instanceof HttpError) {
        if (retryStatuses.includes(err.status)) {
          isRetryable = true;
          if (err.status === 429 && err.headers) {
            const retryAfterMs = parseRetryAfter(err.headers.get("retry-after"));
            // KHÔNG cắt `Retry-After` xuống dưới `maxDelayMs`. `maxDelayMs` là trần
            // cho backoff tự tính; header là mệnh lệnh của server. Vẫn có trần riêng
            // (`maxRetryAfterMs`) vì header do server kiểm soát: một header sai (24h)
            // sẽ treo worker suốt đêm.
            if (retryAfterMs !== null) {
              delayMs = Math.min(
                options.maxRetryAfterMs ?? MAX_HONOURED_RETRY_AFTER_MS,
                retryAfterMs,
              );
            }
          }
        }
      } else {
        // Network / timeout / unknown transient errors
        isRetryable = true;
      }

      if (!isRetryable) {
        throw err;
      }

      if (options.onRetry) {
        options.onRetry(attempt, err, delayMs);
      } else {
        getLogger().warn(
          `[HTTP Retry] Attempt ${attempt}/${maxRetries} failed: ${err instanceof Error ? err.message : String(err)}. Retrying in ${delayMs}ms...`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Wrapper around global `fetch` that retries on 429/5xx and honours per-attempt timeouts. */
export async function fetchWithRetry(
  input: Request | URL | string,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  return withRetry(async () => {
    // Tín hiệu huỷ tạo lại mỗi lần thử: dùng chung một signal thì lần thử sau thừa
    // hưởng và thất bại ngay. `AbortSignal.any` để không mất signal caller truyền vào.
    const perAttemptSignal =
      options?.timeoutMs != null
        ? init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeoutMs)])
          : AbortSignal.timeout(options.timeoutMs)
        : init?.signal;
    const res = await fetch(input, { ...init, signal: perAttemptSignal });
    if (!res.ok) {
      const retryStatuses = options?.retryOnStatuses ?? [429, 500, 502, 503, 504];
      if (retryStatuses.includes(res.status)) {
        let errorBody = "";
        try {
          errorBody = await res.text();
        } catch {
          // ignore
        }
        throw new HttpError(
          res.status,
          `HTTP ${res.status}: ${res.statusText || "Request failed"} - ${errorBody}`,
          res.headers,
        );
      }
    }
    return res;
  }, options);
}
