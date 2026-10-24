/**
 * Client có kiểu cho hàng đợi "external agent runs" của itsaplan.
 *
 * Xác thực bằng API key của CHÍNH agent (header `x-api-key`): key định danh agent
 * và server chỉ giao việc của agent đó. Client này không giữ trạng thái; mọi
 * lease/attempt nằm ở server.
 *
 * Retry: `heartbeat`, `appendEvents`, `report` là idempotent nên được thử lại khi
 * lỗi mạng/429/5xx (có backoff + `Retry-After`). `claim` KHÔNG thử lại ở đây —
 * vòng lặp của worker backoff thay, vì claim thất bại giữa chừng có thể đã giữ
 * lease một run.
 */
import { calculateBackoff, parseRetryAfter } from "../http";
import {
  AGENT_RUN_LIMITS,
  type AgentRunEventsAck,
  type AgentRunEventsBatch,
  type AgentRunResult,
  type ClaimedAgentRun,
} from "./types";

/** Lỗi HTTP từ server agent-runs. `body` là phần đầu của phản hồi (đã cắt). */
export class AgentRunsApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`POST ${path} → ${status}${body ? `: ${body}` : ""}`);
    this.name = "AgentRunsApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }

  /**
   * Lỗi mà thử lại cũng vô ích: key sai/không phải agent (401/403) hoặc agent có
   * invocation URL nên server tự đẩy việc, không cho claim (409 ở `/claim`).
   */
  get fatal(): boolean {
    return (
      this.status === 401 ||
      this.status === 403 ||
      (this.status === 409 && this.path.endsWith("/claim"))
    );
  }
}

/** Phản hồi 2xx nhưng không đúng giao thức (thiếu `run`, id không phải số…). */
export class AgentRunsProtocolError extends Error {
  constructor(path: string, detail: string) {
    super(`Phản hồi ${path} không đúng giao thức agent-runs: ${detail}`);
    this.name = "AgentRunsProtocolError";
  }
}

export interface AgentRunsRetryOptions {
  /** Số lần thử LẠI (không tính lần đầu) cho các lời gọi idempotent. Mặc định 3. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface AgentRunsClientOptions {
  /** Gốc API của itsaplan, vd `https://itsaplan.example.com`. */
  baseUrl: string;
  /** API key của agent (KHÔNG phải key người dùng thường). */
  apiKey: string;
  /** Hạn cho mỗi request (ms). Mặc định 30 000: không lời gọi nào làm việc nặng ở server. */
  timeoutMs?: number;
  retry?: AgentRunsRetryOptions;
  /** Thay `fetch` (test, proxy). */
  fetch?: typeof fetch;
}

/** Kết quả `heartbeat`: `lost` = server không còn coi run này là của ta. */
export type HeartbeatOutcome = "ok" | "lost";
/** Kết quả `report`: `stale` = run đã kết thúc/đổi lượt, báo lại cũng không có tác dụng. */
export type ReportOutcome = "recorded" | "stale";

const ERROR_BODY_CHARS = 300;

export class AgentRunsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: Required<AgentRunsRetryOptions>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentRunsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = {
      maxRetries: options.retry?.maxRetries ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 300,
      maxDelayMs: options.retry?.maxDelayMs ?? 5_000,
    };
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async send(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, ERROR_BODY_CHARS);
      const error = new AgentRunsApiError(res.status, path, text);
      (error as { retryAfterMs?: number | null }).retryAfterMs = parseRetryAfter(
        res.headers.get("retry-after"),
      );
      throw error;
    }
    return res;
  }

  /** POST với retry cho lời gọi idempotent. Lỗi 4xx (trừ 429) ném ngay. */
  private async post(
    path: string,
    body: unknown,
    options: { retry: boolean; signal?: AbortSignal },
  ): Promise<Response> {
    const maxRetries = options.retry ? this.retry.maxRetries : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(path, body, options.signal);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        const status = err instanceof AgentRunsApiError ? err.status : null;
        const transient = status === null || status === 429 || status >= 500;
        if (!transient || attempt >= maxRetries) throw err;
        const hinted = (err as { retryAfterMs?: number | null }).retryAfterMs;
        const delay =
          hinted != null
            ? Math.min(hinted, 60_000)
            : calculateBackoff(attempt + 1, this.retry.baseDelayMs, this.retry.maxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Nhận run kế tiếp của agent, hoặc `null` khi hàng đợi trống. Run được "thuê"
   * (lease): phải gửi heartbeat hoặc báo kết quả, nếu không server giao lại.
   * Ném `AgentRunsApiError` (`fatal` khi 401/403/409).
   */
  async claim(signal?: AbortSignal): Promise<ClaimedAgentRun | null> {
    const res = await this.post("/agent-runs/claim", undefined, { retry: false, signal });
    const json = (await res.json().catch(() => null)) as { run?: unknown } | null;
    if (!json || typeof json !== "object" || !("run" in json)) {
      throw new AgentRunsProtocolError("/agent-runs/claim", "thiếu khoá `run`");
    }
    if (json.run === null) return null;
    return normalizeRun(json.run);
  }

  /** Gia hạn lease. `lost` khi run không còn của ta (đã xong, hoặc lease hết hạn và run đổi lượt). */
  async heartbeat(
    runId: number,
    attempt?: number,
    signal?: AbortSignal,
  ): Promise<HeartbeatOutcome> {
    try {
      await this.post(
        `/agent-runs/${runId}/heartbeat`,
        attempt === undefined ? undefined : { attempt },
        { retry: true, signal },
      );
      return "ok";
    } catch (err) {
      if (err instanceof AgentRunsApiError && err.status === 404) return "lost";
      throw err;
    }
  }

  /**
   * Báo kết quả. Thất bại (`failed`) là KẾT THÚC: server không giao lại. Muốn run
   * được thử lại thì đừng báo gì và để lease hết hạn.
   * `stale` (404) nghĩa là run đã kết thúc hoặc đã sang lượt khác; an toàn để bỏ qua.
   */
  async report(runId: number, result: AgentRunResult, attempt?: number): Promise<ReportOutcome> {
    const body = {
      ...(attempt === undefined ? {} : { attempt }),
      status: result.status,
      ...(result.output == null
        ? {}
        : { output: result.output.slice(0, AGENT_RUN_LIMITS.outputChars) }),
      ...(result.status === "failed"
        ? { error: (result.error ?? "Run failed").slice(0, AGENT_RUN_LIMITS.errorChars) }
        : {}),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
    try {
      await this.post(`/agent-runs/${runId}/result`, body, { retry: true });
      return "recorded";
    } catch (err) {
      if (err instanceof AgentRunsApiError && err.status === 404) return "stale";
      throw err;
    }
  }

  /**
   * Gửi lô sự kiện trace cho lần thử hiện tại. Idempotent theo `offset`: gửi lại
   * lô đã nhận trả về ack hiện tại. `lost` (404) khi lần thử không còn hoạt động;
   * `conflict` (409) khi `offset` lệch hoặc phiên đã gắn khác.
   */
  async appendEvents(
    runId: number,
    batch: AgentRunEventsBatch,
  ): Promise<AgentRunEventsAck | "lost" | "conflict"> {
    if (batch.events.length === 0 || batch.events.length > AGENT_RUN_LIMITS.eventsPerBatch) {
      throw new RangeError(`Lô sự kiện phải có 1–${AGENT_RUN_LIMITS.eventsPerBatch} phần tử`);
    }
    try {
      const res = await this.post(`/agent-runs/${runId}/events`, batch, { retry: true });
      const ack = (await res.json().catch(() => null)) as Partial<AgentRunEventsAck> | null;
      if (!ack || typeof ack.nextOffset !== "number") {
        throw new AgentRunsProtocolError(`/agent-runs/${runId}/events`, "thiếu `nextOffset`");
      }
      return { nextOffset: ack.nextOffset, truncated: ack.truncated === true };
    } catch (err) {
      if (err instanceof AgentRunsApiError) {
        if (err.status === 404) return "lost";
        if (err.status === 409) return "conflict";
      }
      throw err;
    }
  }
}

function normalizeRun(raw: unknown): ClaimedAgentRun {
  const run = raw as Record<string, unknown> | null;
  if (!run || typeof run !== "object") {
    throw new AgentRunsProtocolError("/agent-runs/claim", "`run` không phải object");
  }
  if (typeof run.id !== "number" || !Number.isFinite(run.id)) {
    throw new AgentRunsProtocolError("/agent-runs/claim", "`run.id` không phải số");
  }
  if (typeof run.trigger !== "string") {
    throw new AgentRunsProtocolError("/agent-runs/claim", "`run.trigger` không phải chuỗi");
  }
  return {
    id: run.id,
    trigger: run.trigger,
    prompt: typeof run.prompt === "string" ? run.prompt : "",
    systemPrompt: typeof run.systemPrompt === "string" ? run.systemPrompt : "",
    // Instance cũ có thể thiếu hai trường này.
    attempts: typeof run.attempts === "number" && run.attempts > 0 ? run.attempts : 1,
    traceEvents: run.traceEvents === true,
    issueId: typeof run.issueId === "number" ? run.issueId : null,
    issueIdentifier: typeof run.issueIdentifier === "string" ? run.issueIdentifier : null,
  };
}
