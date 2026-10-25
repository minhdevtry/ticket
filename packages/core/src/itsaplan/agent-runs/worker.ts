/**
 * Worker polling cho hàng đợi external agent runs của itsaplan.
 *
 * Vòng đời một run: `claim` (nhận lease) → chạy `handler` trong khi gửi heartbeat
 * định kỳ → báo `result`. Worker KHÔNG giữ trạng thái bền: hàng đợi là của server,
 * dừng giữa chừng chỉ làm lease hết hạn và run được giao lại.
 *
 * Đảm bảo:
 *  - tối đa `concurrency` run cùng lúc (server còn tự tuần tự hoá run cùng issue);
 *  - claim lỗi: backoff luỹ thừa có jitter; 401/403/409 chỉ là lỗi CHẾT sau `fatalAfter`
 *    lần liên tiếp (một lần 401 do key đang xoay hoặc proxy chập chờn không giết bot);
 *  - heartbeat/result gắn `attempt` để run đã đổi lượt không bị ghi đè nhầm;
 *  - heartbeat trả `lost` → huỷ handler (`signal`) và không báo kết quả;
 *  - handler ném lỗi → báo `failed` (server KHÔNG thử lại run failed);
 *  - handler trả `retry` → nhả lease để server giao lại; ở lượt cuối (`maxAttempts`) thì
 *    báo `failed` kèm lý do thay vì để lease hết hạn trong im lặng;
 *  - kết quả đã tính xong mà báo thất bại → giữ trong `ledger`, lần nhận lại cùng run
 *    sẽ báo lại kết quả cũ thay vì chạy handler lần nữa (idempotency);
 *  - run đang chạy mà bị giao lại (lease hết hạn khi heartbeat hỏng) → huỷ handler cũ và
 *    chạy tiếp bằng lượt mới, không bỏ qua (nếu bỏ qua thì lượt mới trôi hết lease);
 *  - `stop()`: ngừng nhận việc, chờ run đang chạy tối đa `drainTimeoutMs`, quá hạn thì
 *    huỷ và KHÔNG báo gì (lease hết hạn → server giao lại, nên handler phải chạy lại được).
 *    Handler không tuân thủ `signal` cũng không giữ `stop()` quá `abortGraceMs` nữa.
 */
import { getLogger, type IntakeLogger } from "../../core/logger";
import { AgentRunsApiError, type AgentRunsClient } from "./client";
import { RunTrace } from "./trace";
import type { AgentRunResult, AgentRunUsage, ClaimedAgentRun } from "./types";

/** Kết quả handler trả về. */
export type AgentRunOutcome =
  | { status: "success"; output?: string; usage?: AgentRunUsage | null }
  | { status: "failed"; error: string; output?: string; usage?: AgentRunUsage | null }
  /**
   * Không báo gì, nhả lease: server giao lại sau khi lease hết hạn (mặc định 300 giây),
   * tối đa số lần thử của instance (mặc định 3). Dùng cho lỗi tạm thời.
   */
  | { status: "retry"; reason?: string };

/** Handler được phép trả chuỗi (= success + output) hoặc không trả gì (= success). */
// biome-ignore lint/suspicious/noConfusingVoidType: handler async không trả gì là hợp lệ
export type AgentRunHandlerResult = AgentRunOutcome | string | undefined | void;

/** Ngữ cảnh worker đưa cho handler. */
export interface AgentRunHandlerContext {
  run: ClaimedAgentRun;
  /** Bị huỷ khi mất lease, hết `runTimeoutMs` hoặc tắt cưỡng bức. */
  signal: AbortSignal;
  logger: IntakeLogger;
  /** Ghi trace lên itsaplan (an toàn gọi dù server không muốn trace: thành no-op). */
  trace: RunTrace;
  /** Khoá ổn định cho một run, dùng để chống làm trùng việc ngoài (vd dấu trong comment). */
  idempotencyKey: string;
  /** Lượt thử hiện tại (bắt đầu từ 1). */
  attempt: number;
  /** Số lượt tối đa server cho một run. Hết lượt thì `retry` bị đổi thành `failed`. */
  maxAttempts: number;
}

export type AgentRunHandler = (ctx: AgentRunHandlerContext) => Promise<AgentRunHandlerResult>;

/** Sổ nhớ kết quả đã tính xong nhưng chưa báo được. Mặc định in-memory; bot có thể cắm kho bền. */
export interface RunLedger {
  get(runId: number): AgentRunResult | undefined | Promise<AgentRunResult | undefined>;
  set(runId: number, result: AgentRunResult): void | Promise<void>;
  delete(runId: number): void | Promise<void>;
}

/** Ledger in-memory có chặn kích thước (xoá mục cũ nhất). */
export class MemoryRunLedger implements RunLedger {
  private readonly map = new Map<number, AgentRunResult>();
  constructor(private readonly max = 500) {}
  get(runId: number) {
    return this.map.get(runId);
  }
  set(runId: number, result: AgentRunResult) {
    this.map.set(runId, result);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(runId: number) {
    this.map.delete(runId);
  }
}

/** Phần của `AgentRunsClient` mà worker cần (để test truyền bản giả). */
export type WorkerClient = Pick<AgentRunsClient, "claim" | "heartbeat" | "report" | "appendEvents">;

export interface AgentRunWorkerOptions {
  client: WorkerClient;
  handler: AgentRunHandler;
  /** Số run chạy song song. Mặc định 1. */
  concurrency?: number;
  /** Chờ bao lâu khi hàng đợi trống (ms). Mặc định 3000, sàn `minPollIntervalMs`. */
  pollIntervalMs?: number;
  /** Sàn của `pollIntervalMs`. Poll rỗng tốn 3 lần ghi ở server nên mặc định 1000. */
  minPollIntervalMs?: number;
  /** Chu kỳ heartbeat (ms). Mặc định 60 000 (lease mặc định của server là 300 s). */
  heartbeatIntervalMs?: number;
  /** Backoff khi claim lỗi. Mặc định 5 s, tối đa 60 s. */
  errorBackoff?: { baseMs?: number; maxMs?: number };
  /** Hạn một run (ms). Quá hạn thì huỷ và báo `failed`. Mặc định 30 phút. */
  runTimeoutMs?: number;
  /**
   * Thời gian chờ run đang chạy khi `stop()` (ms). Mặc định 5 000: vừa trong hạn 10 giây
   * mặc định của `docker stop`. Handler chạy lâu (gọi LLM) cần nâng số này và hạn dừng của
   * orchestrator (`docker stop -t`, `TimeoutStopSec`); phần chưa xong bị huỷ và server giao lại.
   */
  drainTimeoutMs?: number;
  /** Sau khi huỷ vì quá hạn drain, chờ thêm tối đa bấy nhiêu ms rồi bỏ mặc. Mặc định 1 000. */
  abortGraceMs?: number;
  /** Số lượt thử tối đa của một run phía server. Mặc định 3. */
  maxAttempts?: number;
  /** Lease phía server (ms), chỉ để kiểm `heartbeatIntervalMs`. Mặc định 300 000. */
  leaseMs?: number;
  /** Số lần 401/403/409 liên tiếp ở `claim` mới coi là lỗi chết. Mặc định 3. */
  fatalAfter?: number;
  ledger?: RunLedger;
  logger?: IntakeLogger;
  /** Có gửi trace không (khi server cũng muốn). Mặc định true. */
  trace?: boolean;
  /** Gọi khi gặp lỗi chết (key bị từ chối…). Worker tự dừng claim. */
  onFatal?: (error: Error) => void;
  /** Đồng hồ (ms). Mặc định `Date.now`. */
  now?: () => number;
}

export type AgentRunWorkerState = "created" | "running" | "stopping" | "stopped" | "failed";

export interface AgentRunWorkerHealth {
  state: AgentRunWorkerState;
  active: number;
  activeRunIds: number[];
  concurrency: number;
  /** Thời điểm (ms) claim gần nhất THÀNH CÔNG (kể cả trả rỗng). */
  lastPollAt: number | null;
  /** Thời điểm nhận được run gần nhất. */
  lastClaimAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  totals: {
    claimed: number;
    succeeded: number;
    failed: number;
    retried: number;
    /** Run bị bỏ không báo (mất lease, tắt cưỡng bức). */
    dropped: number;
    /** Lần báo kết quả thất bại sau mọi retry (kết quả nằm trong ledger). */
    reportErrors: number;
  };
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
  /** Vì sao bị huỷ: quyết định có báo kết quả không. */
  abortedFor: null | "lease-lost" | "shutdown" | "superseded";
  abort(reason: "lease-lost" | "shutdown" | "superseded"): void;
}

/** Chờ `promise` tới `ms`; trả `"done"` hoặc `"timeout"`. Không để timer treo process. */
async function raceWithTimer(promise: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class AgentRunWorker {
  private readonly client: WorkerClient;
  private readonly handler: AgentRunHandler;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly runTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly maxAttempts: number;
  private readonly fatalAfter: number;
  private readonly ledger: RunLedger;
  private readonly logger: IntakeLogger;
  private readonly traceEnabled: boolean;
  private readonly onFatal?: (error: Error) => void;
  private readonly now: () => number;

  private state: AgentRunWorkerState = "created";
  private readonly active = new Map<number, ActiveRun>();
  private loopAbort = new AbortController();
  private loop: Promise<void> | null = null;
  private lastPollAt: number | null = null;
  private lastClaimAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private consecutiveFatal = 0;
  private readonly totals = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    dropped: 0,
    reportErrors: 0,
  };

  constructor(options: AgentRunWorkerOptions) {
    this.client = options.client;
    this.handler = options.handler;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.pollIntervalMs = Math.max(
      options.minPollIntervalMs ?? 1000,
      options.pollIntervalMs ?? 3000,
    );
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
    this.backoffBaseMs = options.errorBackoff?.baseMs ?? 5_000;
    this.backoffMaxMs = options.errorBackoff?.maxMs ?? 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    this.abortGraceMs = options.abortGraceMs ?? 1_000;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.fatalAfter = Math.max(1, Math.floor(options.fatalAfter ?? 3));
    const leaseMs = options.leaseMs ?? 300_000;
    if (!(this.heartbeatIntervalMs > 0) || this.heartbeatIntervalMs > leaseMs / 2) {
      throw new RangeError(
        `heartbeatIntervalMs phải > 0 và <= một nửa lease (${leaseMs / 2}ms), nhận ${this.heartbeatIntervalMs}`,
      );
    }
    if (!(this.runTimeoutMs > 0)) throw new RangeError("runTimeoutMs phải > 0");
    if (!(this.drainTimeoutMs >= 0)) throw new RangeError("drainTimeoutMs phải >= 0");
    this.ledger = options.ledger ?? new MemoryRunLedger();
    this.logger = options.logger ?? getLogger();
    this.traceEnabled = options.trace ?? true;
    this.onFatal = options.onFatal;
    this.now = options.now ?? Date.now;
  }

  /** Bắt đầu poll. Gọi lại khi đang chạy thì không làm gì. */
  start(): void {
    if (this.state === "running") return;
    if (this.state !== "created") throw new Error(`Worker đã ${this.state}, hãy tạo worker mới`);
    this.state = "running";
    this.loop = this.runLoop();
  }

  /**
   * Dừng nhận việc, chờ các run đang chạy tối đa `drainTimeoutMs`, rồi huỷ phần còn lại
   * (không báo kết quả; lease hết hạn thì server giao lại). Gọi lại là an toàn.
   */
  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "created") {
      this.state = "stopped";
      return;
    }
    if (this.state === "running") this.state = "stopping";
    this.loopAbort.abort();
    await this.loop;
    if (this.active.size > 0) {
      const settled = () => Promise.allSettled([...this.active.values()].map((a) => a.promise));
      if ((await raceWithTimer(settled(), this.drainTimeoutMs)) === "timeout") {
        this.logger.warn(
          `[agent-runs] ${this.active.size} run chưa xong sau ${this.drainTimeoutMs}ms, huỷ (lease sẽ hết hạn và server giao lại)`,
        );
        for (const entry of this.active.values()) entry.abort("shutdown");
        if ((await raceWithTimer(settled(), this.abortGraceMs)) === "timeout") {
          this.logger.error(
            `[agent-runs] ${this.active.size} run không dừng sau ${this.abortGraceMs}ms kể từ khi huỷ (handler không tuân thủ signal); bỏ mặc`,
          );
          this.totals.dropped += this.active.size;
          this.active.clear();
        }
      }
    }
    if (this.state !== "failed") this.state = "stopped";
  }

  health(): AgentRunWorkerHealth {
    return {
      state: this.state,
      active: this.active.size,
      activeRunIds: [...this.active.keys()],
      concurrency: this.concurrency,
      lastPollAt: this.lastPollAt,
      lastClaimAt: this.lastClaimAt,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      totals: { ...this.totals },
    };
  }

  /** Chờ tới khi không còn run nào đang chạy (hữu ích cho test). */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    }
  }

  private backoff(errors: number): number {
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (errors - 1));
    // Jitter đều trong [exp/2, exp]: không đồng loạt thử lại, cũng không chờ quá ngắn.
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  private async runLoop(): Promise<void> {
    const { signal } = this.loopAbort;
    while (!signal.aborted) {
      if (this.active.size >= this.concurrency) {
        await Promise.race([
          ...[...this.active.values()].map((a) => a.promise),
          abortableSleep(60_000, signal),
        ]);
        continue;
      }
      let run: ClaimedAgentRun | null;
      try {
        run = await this.client.claim({ signal });
        this.lastPollAt = this.now();
        this.consecutiveErrors = 0;
        this.consecutiveFatal = 0;
      } catch (err) {
        if (signal.aborted) break;
        this.lastError = errorMessage(err);
        if (err instanceof AgentRunsApiError && err.fatal) {
          // Một lần 401/403 có thể do key đang xoay hoặc proxy: chỉ dừng khi lặp lại.
          this.consecutiveFatal++;
          if (this.consecutiveFatal >= this.fatalAfter) {
            this.logger.error(
              `[agent-runs] dừng: ${err.message} (${this.consecutiveFatal} lần liên tiếp)`,
            );
            this.state = "failed";
            this.onFatal?.(err);
            return;
          }
        } else {
          this.consecutiveFatal = 0;
        }
        this.consecutiveErrors++;
        const delay = this.backoff(this.consecutiveErrors);
        this.logger.warn(
          `[agent-runs] claim lỗi (${this.consecutiveErrors} lần liên tiếp): ${this.lastError}; thử lại sau ${delay}ms`,
        );
        await abortableSleep(delay, signal);
        continue;
      }
      if (!run) {
        await abortableSleep(this.pollIntervalMs, signal);
        continue;
      }
      this.lastClaimAt = this.now();
      this.totals.claimed++;
      const previous = this.active.get(run.id);
      if (previous) {
        // Lease cũ hết hạn trong khi ta vẫn làm (heartbeat hỏng) và server giao lại run này cho
        // chính ta với lượt mới. Lượt cũ không còn báo được gì (server từ chối attempt cũ), nên
        // huỷ nó và làm tiếp bằng lượt mới; bỏ qua thì lượt mới trôi hết lease vô ích.
        this.logger.warn(
          `[agent-runs] run #${run.id} được giao lại (lần ${run.attempts}) khi đang chạy: huỷ lượt cũ, nhận lượt mới`,
        );
        previous.abort("superseded");
      }
      this.dispatch(run);
    }
  }

  private dispatch(run: ClaimedAgentRun): void {
    const controller = new AbortController();
    const entry: ActiveRun = {
      controller,
      abortedFor: null,
      promise: Promise.resolve(),
      abort(reason) {
        entry.abortedFor ??= reason;
        controller.abort(new Error(reason));
      },
    };
    entry.promise = this.process(run, entry).finally(() => {
      // Lượt mới có thể đã thay chỗ của lượt này: chỉ xoá khi vẫn là mình.
      if (this.active.get(run.id) === entry) this.active.delete(run.id);
    });
    this.active.set(run.id, entry);
  }

  /** Vỏ an toàn: không để lỗi bất ngờ nào thành unhandled rejection làm sập process. */
  private async process(run: ClaimedAgentRun, entry: ActiveRun): Promise<void> {
    try {
      await this.processRun(run, entry);
    } catch (err) {
      this.totals.dropped++;
      this.logger.error(
        `[agent-runs] run #${run.id}: lỗi nội bộ worker (${errorMessage(err)}); không báo kết quả, lease hết hạn sẽ giao lại`,
      );
    }
  }

  private async processRun(run: ClaimedAgentRun, entry: ActiveRun): Promise<void> {
    const label = run.issueIdentifier ?? `run #${run.id}`;
    const logger = this.logger;
    logger.info(`[agent-runs] ${label}: nhận run #${run.id} (${run.trigger}, lần ${run.attempts})`);

    const beat = setInterval(() => {
      this.client
        .heartbeat({ runId: run.id, attempt: run.attempts })
        .then((outcome) => {
          if (outcome === "lost") {
            logger.warn(`[agent-runs] ${label}: mất lease, huỷ run`);
            entry.abort("lease-lost");
          }
        })
        .catch((err) => logger.warn(`[agent-runs] ${label}: heartbeat lỗi: ${errorMessage(err)}`));
    }, this.heartbeatIntervalMs);

    const trace = new RunTrace(this.client, run, logger, this.traceEnabled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let result: AgentRunResult;
      const remembered = await (async () => this.ledger.get(run.id))().catch((err) => {
        logger.warn(
          `[agent-runs] ${label}: đọc ledger lỗi (${errorMessage(err)}), coi như chưa có`,
        );
        return undefined;
      });
      if (remembered) {
        logger.info(
          `[agent-runs] ${label}: đã có kết quả từ lần trước, báo lại không chạy handler`,
        );
        result = remembered;
      } else {
        let outcome = await this.invoke(run, entry, trace, (t) => {
          timer = t;
        });
        if (entry.abortedFor) {
          this.totals.dropped++;
          logger.warn(`[agent-runs] ${label}: bỏ kết quả (${entry.abortedFor})`);
          return;
        }
        if (outcome.status === "retry" && run.attempts >= this.maxAttempts) {
          // Lượt cuối: nhả lease chỉ làm run chết im lặng sau khi hết hạn. Báo failed kèm lý do.
          outcome = {
            status: "failed",
            error: `Hết lượt thử (${run.attempts}/${this.maxAttempts}): ${outcome.reason ?? "lỗi tạm thời"}`,
          };
        }
        if (outcome.status === "retry") {
          this.totals.retried++;
          logger.info(
            `[agent-runs] ${label}: nhả lease để thử lại${outcome.reason ? ` (${outcome.reason})` : ""}`,
          );
          return;
        }
        result = toResult(outcome);
        try {
          await this.ledger.set(run.id, result);
        } catch (err) {
          // Không có ledger thì mất bảo đảm "không chạy lại handler" nếu báo lỗi, nhưng vẫn báo.
          logger.warn(
            `[agent-runs] ${label}: ghi ledger lỗi (${errorMessage(err)}), vẫn báo kết quả`,
          );
        }
      }

      await trace.emit(
        result.status === "success"
          ? { type: "RUN_FINISHED" }
          : { type: "RUN_ERROR", message: (result.error ?? "Run failed").slice(0, 2000) },
      );
      await trace.flush();

      try {
        const reported = await this.client.report({
          runId: run.id,
          result,
          attempt: run.attempts,
        });
        await (async () => this.ledger.delete(run.id))().catch((err) => {
          logger.warn(`[agent-runs] ${label}: xoá ledger lỗi (${errorMessage(err)})`);
        });
        if (reported === "stale") {
          this.totals.dropped++;
          logger.warn(
            `[agent-runs] ${label}: server không nhận kết quả (run đã kết thúc/đổi lượt)`,
          );
        } else if (result.status === "success") {
          this.totals.succeeded++;
        } else {
          this.totals.failed++;
          logger.warn(`[agent-runs] ${label}: failed — ${result.error ?? ""}`);
        }
      } catch (err) {
        this.totals.reportErrors++;
        logger.error(
          `[agent-runs] ${label}: báo kết quả lỗi (${errorMessage(err)}); giữ trong ledger, báo lại khi run được giao lại`,
        );
      }
    } finally {
      clearInterval(beat);
      if (timer) clearTimeout(timer);
    }
  }

  /** Chạy handler với hạn thời gian; chuẩn hoá mọi kiểu trả về/ném thành `AgentRunOutcome`. */
  private async invoke(
    run: ClaimedAgentRun,
    entry: ActiveRun,
    trace: RunTrace,
    keepTimer: (timer: ReturnType<typeof setTimeout>) => void,
  ): Promise<AgentRunOutcome> {
    await trace.emit({ type: "RUN_STARTED" });
    const timeout = new Promise<AgentRunOutcome>((resolve) => {
      keepTimer(
        setTimeout(() => {
          entry.controller.abort(new Error("timeout"));
          resolve({ status: "failed", error: `Timed out after ${this.runTimeoutMs}ms` });
        }, this.runTimeoutMs),
      );
    });
    // Mất lease/tắt cưỡng bức/bị thay lượt: không chờ handler (có thể phớt lờ `signal`).
    const aborted = new Promise<AgentRunOutcome>((resolve) => {
      const onAbort = () => {
        if (entry.abortedFor) resolve({ status: "retry", reason: entry.abortedFor });
      };
      if (entry.controller.signal.aborted) onAbort();
      else entry.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = (async (): Promise<AgentRunOutcome> => {
      try {
        const raw = await this.handler({
          run,
          signal: entry.controller.signal,
          logger: this.logger,
          trace,
          idempotencyKey: `agent-run:${run.id}`,
          attempt: run.attempts,
          maxAttempts: this.maxAttempts,
        });
        if (raw === undefined || raw === null) return { status: "success" };
        if (typeof raw === "string") return { status: "success", output: raw };
        return raw;
      } catch (err) {
        return { status: "failed", error: errorMessage(err) };
      }
    })();
    return Promise.race([work, timeout, aborted]);
  }
}

function toResult(outcome: Exclude<AgentRunOutcome, { status: "retry" }>): AgentRunResult {
  return outcome.status === "success"
    ? { status: "success", output: outcome.output ?? null, usage: outcome.usage }
    : {
        status: "failed",
        error: outcome.error,
        output: outcome.output ?? null,
        usage: outcome.usage,
      };
}

/** Tạo worker (đồng nghĩa `new AgentRunWorker(options)`). */
export function createAgentRunWorker(options: AgentRunWorkerOptions): AgentRunWorker {
  return new AgentRunWorker(options);
}
