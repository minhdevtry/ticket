/**
 * One gate out to the Telegram Bot API.
 *
 * NGUỒN: intake `lib/telegram/transport.ts` (`call`/`tryCall`/`sendFormData`/
 * `trySendFormData`/`downloadFile`) + intake `worker/notifier.ts` `api()` wrapper
 * (`isEntityParseError`/`plainText`, commit 40f7062) + CM `worker/broadcast-dispatcher.ts`
 * 429 `retry_after` handling.
 *
 * Everything the bot wiring supplies is INJECTED — `botToken`, `baseUrl`,
 * `fetch`, `now`, `sleep` — so a test never touches the network or the clock and
 * no `https://api.telegram.org` is hardcoded (research §8: a hardcoded base URL
 * and a hardcoded `fetch` are why the two bots' wrappers drifted and why nothing
 * could be tested without a live token).
 *
 * TWO ERROR POLICIES, both deliberate (kept from intake):
 *  - `call` THROWS: the main job (notify a reporter) — a failure must be seen.
 *  - `tryCall` SWALLOWS and returns null: side jobs (close a button, ack an icon,
 *    answer a callback) — a failure here must never break the main flow.
 */
import { getLogger } from "../core/logger";

/** api.telegram.org, overridable so tests point at a fake on 127.0.0.1. */
export const DEFAULT_TELEGRAM_BASE_URL = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Floor on a 429 wait — Telegram sometimes answers `retry_after: 0`; without a
 * floor the retry is a hot loop. Source: CM broadcast-dispatcher `RETRY_BASE_MS`. */
const MIN_RETRY_AFTER_MS = 1_000;
/** Cap on a single 429 wait so a bogus `retry_after` cannot park a turn forever. */
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

/** The `fetch` shape the transport needs — injected so tests pass a fake. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface TelegramTransportOptions {
  botToken: string;
  /** Base URL of the Bot API. Default `https://api.telegram.org`. */
  baseUrl?: string;
  /** Injected fetch. Default: global `fetch`. */
  fetch?: FetchLike;
  /** Default 15s. A webhook flow that must answer fast passes a shorter one. */
  timeoutMs?: number;
  /** Injected clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Injected sleep for 429 backoff. Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to honour a 429 `retry_after` before giving up. Default 1. */
  maxRetries?: number;
  /** Cap on a single 429 wait. Default 60s. */
  maxRetryAfterMs?: number;
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: T;
}

/**
 * A typed Telegram failure. Callers can branch on `errorCode`/`isParseEntities`/
 * `retryAfterMs` instead of regex-matching a message string.
 */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly httpStatus: number;
  readonly errorCode?: number;
  readonly description?: string;
  /** Present on a 429. Milliseconds Telegram asked the bot to wait. */
  readonly retryAfterMs?: number;

  constructor(args: {
    method: string;
    httpStatus: number;
    errorCode?: number;
    description?: string;
    retryAfterMs?: number;
  }) {
    super(`Telegram ${args.method} lỗi: ${args.description ?? args.httpStatus}`);
    this.name = "TelegramApiError";
    this.method = args.method;
    this.httpStatus = args.httpStatus;
    this.errorCode = args.errorCode;
    this.description = args.description;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** `true` when this is a rate-limit (429) stop order from Telegram. */
  get isRateLimited(): boolean {
    return this.httpStatus === 429 || this.errorCode === 429;
  }

  /** `true` when Telegram could not parse the message's markup (commit 40f7062). */
  get isParseEntities(): boolean {
    return isEntityParseError(this);
  }
}

/**
 * Telegram rejected a message because its Markdown/HTML markup is malformed —
 * usually an underscore in a name (`PO_UserC`, `@PRO_UserB`) read as a stray
 * italic. Source: intake `worker/notifier.ts` (commit 40f7062, PO-91 01/10).
 */
export function isEntityParseError(err: unknown): boolean {
  const desc = err instanceof TelegramApiError ? err.description ?? "" : "";
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  return /can'?t parse entities/i.test(desc) || /can'?t parse entities/i.test(msg);
}

/** Strip the `**` bold we added ourselves; the rest is the author's own words. */
export function plainText(s: string): string {
  return s.replace(/\*\*/g, "");
}

function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelegramTransport {
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly injectedFetch?: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;

  constructor(options: TelegramTransportOptions) {
    this.botToken = options.botToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_TELEGRAM_BASE_URL).replace(/\/+$/, "");
    this.injectedFetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  }

  /** Resolve fetch lazily so a test that swaps globalThis.fetch after construction is honoured. */
  private get doFetch(): FetchLike {
    return this.injectedFetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.botToken}/${method}`;
  }

  private async parseEnvelope<T>(res: {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }): Promise<TelegramEnvelope<T>> {
    return ((await res.json().catch(() => ({}))) ?? {}) as TelegramEnvelope<T>;
  }

  private envelopeError<T>(
    method: string,
    res: { status: number },
    body: TelegramEnvelope<T>,
  ): TelegramApiError {
    const retryAfter = body.parameters?.retry_after;
    return new TelegramApiError({
      method,
      httpStatus: res.status,
      errorCode: body.error_code,
      description: body.description,
      retryAfterMs:
        typeof retryAfter === "number"
          ? Math.min(this.maxRetryAfterMs, Math.max(MIN_RETRY_AFTER_MS, retryAfter * 1000))
          : undefined,
    });
  }

  /**
   * Call the Bot API. Throws `TelegramApiError` on failure, returns `result` on
   * success. Honours a 429 `retry_after` up to `maxRetries` times, each wait
   * floored at 1s and capped at `maxRetryAfterMs` — Telegram's 429 is a stop
   * order for the whole bot, not a per-message error (CM broadcast-dispatcher).
   */
  async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.doFetch(this.url(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await this.parseEnvelope<T>(res);
      if (res.ok && body?.ok !== false) return body.result as T;

      const err = this.envelopeError(method, res, body);
      if (err.isRateLimited && err.retryAfterMs != null && attempt < this.maxRetries) {
        attempt++;
        getLogger().warn(
          `[telegram] ${method}: 429, chờ ${err.retryAfterMs}ms rồi thử lại (lần ${attempt}/${this.maxRetries}).`,
        );
        await this.sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }
  }

  /** Like `call` but logs and returns null on failure — never breaks the caller. */
  async tryCall<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      return await this.call<T>(method, payload);
    } catch (err) {
      getLogger().warn(
        `[telegram] Gọi ${method} thất bại: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Send multipart/form-data (sendPhoto/sendVideo/sendDocument file upload). */
  async sendFormData<T = unknown>(method: string, formData: FormData): Promise<T> {
    const res = await this.doFetch(this.url(method), {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await this.parseEnvelope<T>(res);
    if (!res.ok || body?.ok === false) throw this.envelopeError(method, res, body);
    return body.result as T;
  }

  /** Like `sendFormData` but logs and returns null on failure. */
  async trySendFormData<T = unknown>(method: string, formData: FormData): Promise<T | null> {
    try {
      return await this.sendFormData<T>(method, formData);
    } catch (err) {
      getLogger().warn(
        `[telegram] Gửi form-data ${method} thất bại: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Download a file by the `file_path` returned from `getFile`. */
  async downloadFile(filePath: string): Promise<Buffer> {
    const res = await this.doFetch(`${this.baseUrl}/file/bot${this.botToken}/${filePath}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Telegram tải file lỗi: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
