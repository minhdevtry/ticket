/**
 * Phân loại lỗi "tạm thời" (thử lại có thể thành công) và lỗi "vĩnh viễn".
 *
 * Khác `isRetryableItsaplanError` ở chỗ KHÔNG coi mọi thứ không phải `ItsaplanApiError`
 * là tạm thời: một `TypeError: x is undefined` do bug thì thử lại cũng vô ích và còn che mất
 * lỗi. Chỉ nhận ra: 5xx/429 của itsaplan hoặc agent-runs, phản hồi 2xx đọc hỏng, hết giờ,
 * và lỗi mạng (kết nối bị từ chối/ngắt, DNS, `fetch failed`).
 */
import { ItsaplanApiError, ItsaplanMalformedResponseError } from "./client";
import { AgentRunsApiError } from "./agent-runs/client";
import { HttpError } from "./http";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UnableToConnect",
]);

const NETWORK_MESSAGE =
  /fetch failed|network|socket|connection (?:closed|refused|reset)|unable to connect|econn|etimedout|timed out|timeout/i;

const isTransientStatus = (status: number) => status === 429 || status >= 500;

/** `true` nếu thử lại sau một lúc có thể thành công. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ItsaplanApiError || err instanceof AgentRunsApiError) {
    return isTransientStatus(err.status);
  }
  if (err instanceof HttpError) return isTransientStatus(err.status);
  if (err instanceof ItsaplanMalformedResponseError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  if (err.name === "TimeoutError") return true;
  // `AbortError` là do ta huỷ (signal), không phải lỗi mạng: để caller tự quyết.
  if (err.name === "AbortError") return false;
  if (err instanceof TypeError || err.name === "FetchError")
    return NETWORK_MESSAGE.test(err.message);
  return false;
}
