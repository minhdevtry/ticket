/**
 * `createBot` — dựng runtime của một bot từ khai báo `defineBot`.
 *
 * Vòng đời: `createBot` (đồng bộ: kiểm khai báo, nạp + kiểm env, dựng đối tượng, KHÔNG
 * mạng, KHÔNG nghe cổng) → `start()` (kiểm tra kết nối dự án, bật worker run, webhook,
 * `/healthz`) → `health()` bất cứ lúc nào → `stop()` (êm, idempotent).
 *
 * Env luôn truyền tường minh qua `options.env`; `.env` chỉ đọc khi truyền `envFile`.
 * Biến chuẩn của kit (đọc bởi `createBot`):
 *
 * | Biến | Ý nghĩa |
 * |---|---|
 * | `ITSAPLAN_BASE_URL`, `ITSAPLAN_AGENT_KEY` | bắt buộc khi có `backoffice` |
 * | `BOT_RUN_CONCURRENCY`, `BOT_POLL_INTERVAL_MS` | ghi đè `backoffice.runs` |
 * | `BOT_DRAIN_TIMEOUT_MS` | chờ run đang chạy khi dừng (mặc định 5000; xem `Bot.stopBudgetMs`) |
 * | `BOT_HEALTH_PORT`, `BOT_HEALTH_HOST` | bật `/healthz` |
 * | `BOT_WEBHOOK_PORT`, `BOT_WEBHOOK_HOST`, `ITSAPLAN_WEBHOOK_SECRET` | nhận webhook cho `rules` |
 * | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_API`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_DEADLINE_MS` | bật `ctx.llm` (đặt đủ ba biến đầu, hoặc không đặt biến nào) |
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  type EnvShape,
  type InferEnv,
  type LoadedConfig,
  defineEnv,
  createScrubber,
  loadConfig,
  mergeEnv,
  secret,
} from "../core/config";
import { type IntakeLogger, getLogger } from "../core/logger";
import { LLM_ENV_KEYS, type Llm, type LlmUsageEvent, llmEnv, llmFromConfig } from "../llm";
import { type Clock, systemClock } from "../intake/ports";
import {
  type ItsaplanWebhookEnvelope,
  ItsaplanClient,
  ItsaplanWebhookServer,
  AgentRunsClient,
  type AgentRunHandler,
  AgentRunWorker,
  type AgentRunWorkerHealth,
  type AgentRunWorkerOptions,
  type RunLedger,
} from "../itsaplan";
import {
  type RuleRunSummary,
  RuleEngine,
  createRunDispatcher,
  createScopedTracker,
} from "../backoffice";
import { type BotDefinition, BotDefinitionError, validateBotDefinition } from "./define";
import { type HealthServerHandle, startHealthServer } from "./health-server";
import { botLogger } from "./logging";

export type BotState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

export type BotStatus = "starting" | "ok" | "degraded" | "down" | "stopped";

/** Ảnh chụp sức khoẻ. JSON thuần, không chứa secret. */
export interface BotHealth {
  status: BotStatus;
  bot: string;
  state: BotState;
  /** ISO. `null` khi chưa start. */
  startedAt: string | null;
  uptimeSec: number;
  components: {
    backoffice?: {
      worker: Omit<AgentRunWorkerHealth, "lastPollAt" | "lastClaimAt"> & {
        lastPollAt: string | null;
        lastClaimAt: string | null;
      };
      rules: number;
    };
    webhook?: { listening: boolean; port: number | null };
    receptionist?: { state: "declared-not-running"; note: string };
  };
  /** Lý do khi `degraded`/`down`. */
  reasons: string[];
}

export interface CreateBotOptions {
  /** Nguồn env. BẮT BUỘC, truyền `process.env` hoặc object thử nghiệm. */
  env: Record<string, string | undefined>;
  /** Đường dẫn `.env` (chỉ đọc khi truyền). Biến trong `env` thắng file. */
  envFile?: string;
  /** Logger gốc. Mặc định logger của process. Luôn được bọc: tiền tố bot + lọc secret. */
  logger?: IntakeLogger;
  clock?: Clock;
  /** `false` tắt `/healthz` kể cả khi có `BOT_HEALTH_PORT`; object ghi đè env. */
  healthServer?: false | { port?: number; host?: string; path?: string };
  /** `false` tắt nghe webhook; object ghi đè env. */
  webhook?: false | { port?: number; host?: string; secrets?: string[] };
  /** Có kiểm tra kết nối dự án lúc `start()` không (fail-fast key/dự án sai). Mặc định true. */
  preflight?: boolean;
  /** Thay `fetch` cho client agent-runs (test/proxy). */
  fetch?: typeof fetch;
  /** Tuỳ chỉnh worker run (drain, backoff, ledger…). */
  worker?: Partial<
    Pick<
      AgentRunWorkerOptions,
      | "drainTimeoutMs"
      | "abortGraceMs"
      | "errorBackoff"
      | "minPollIntervalMs"
      | "trace"
      | "fatalAfter"
    >
  > & { ledger?: RunLedger };
  /**
   * LLM của bot. Mặc định dựng từ `LLM_*` trong env (không có thì `ctx.llm` là `undefined`).
   * `false`: không bao giờ có LLM; `client`: dùng client dựng sẵn thay cho env (test, host tự
   * quản); `onUsage`: nhận mỗi lời gọi thành công để ghi token/chi phí; `fetch`: thay `fetch`.
   */
  llm?: false | { client?: Llm; onUsage?: (event: LlmUsageEvent) => void; fetch?: typeof fetch };
  /** Client itsaplan dựng sẵn (test). Mặc định dựng từ env, tắt retry cho lệnh ghi. */
  itsaplanClient?: ItsaplanClient;
  /** Thử lại lệnh ĐỌC của tracker khi itsaplan lỗi tạm thời (lệnh ghi không bao giờ thử lại). */
  trackerReads?: { retries?: number; baseDelayMs?: number };
}

/** Bot đang chạy được. */
export interface Bot {
  readonly id: string;
  readonly state: BotState;
  /** Client LLM của bot (từ `LLM_*` hoặc `options.llm.client`), `undefined` nếu chưa cấu hình. */
  readonly llm: Llm | undefined;
  /** Bắt đầu chạy. Ném (sau khi dọn) nếu kiểm tra kết nối hoặc bind cổng thất bại. */
  start(): Promise<void>;
  /** Dừng êm (chờ run đang chạy tới hạn drain). Gọi lại là an toàn. */
  stop(): Promise<void>;
  health(): BotHealth;
  /**
   * Tổng thời gian tối đa `stop()` cần trong trường hợp xấu (ms): drain + chờ sau khi huỷ + dọn
   * server. `runBot` lấy số này làm hạn thoát cưỡng bức; đặt `docker stop -t` / `TimeoutStopSec`
   * lớn hơn nó.
   */
  readonly stopBudgetMs: number;
  /**
   * Đăng ký nghe lỗi chết (worker bị từ chối key liên tiếp…): bot chuyển `failed` và `health()`
   * là `down`. Trả hàm huỷ đăng ký. Host (`runBot`) dùng để thoát với mã khác 0.
   */
  onFatal(listener: (error: Error) => void): () => void;
  /**
   * Đưa một webhook envelope vào luật của bot (cho host đã có webhook server riêng, vd
   * Tiểu Linh hoặc OpenClaw). Trả danh sách luật đã chạy. Không ném.
   */
  handleEvent(envelope: ItsaplanWebhookEnvelope): Promise<RuleRunSummary[]>;
  /** Địa chỉ đang nghe (sau `start()`). */
  addresses(): {
    health?: { host: string; port: number };
    webhook?: { host: string; port: number };
  };
}

const portSchema = z.coerce.number().int().min(0).max(65535);

function kitEnv(needsItsaplan: boolean) {
  return defineEnv({
    ITSAPLAN_BASE_URL: needsItsaplan ? z.url() : z.url().optional(),
    ITSAPLAN_AGENT_KEY: secret(needsItsaplan ? z.string().min(1) : z.string().min(1).optional()),
    BOT_RUN_CONCURRENCY: z.coerce.number().int().min(1).optional(),
    BOT_POLL_INTERVAL_MS: z.coerce.number().int().min(0).optional(),
    BOT_HEALTH_PORT: portSchema.optional(),
    BOT_HEALTH_HOST: z.string().min(1).optional(),
    BOT_WEBHOOK_PORT: portSchema.optional(),
    BOT_WEBHOOK_HOST: z.string().min(1).optional(),
    ITSAPLAN_WEBHOOK_SECRET: secret(z.string().min(1).optional()),
    BOT_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  });
}

const DEGRADED_ERRORS = 3;
const STALE_FLOOR_MS = 30_000;
const DEFAULT_DRAIN_MS = 5_000;
const DEFAULT_ABORT_GRACE_MS = 1_000;
/** Dọn webhook/health server tối đa bấy nhiêu ms khi dừng (không để một kết nối treo giữ bot). */
const SERVER_STOP_MS = 1_000;

const isLoopbackHost = (host: string | undefined): boolean =>
  host === undefined ||
  host === "localhost" ||
  host === "::1" ||
  host === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(host);

/** Chờ `promise` tối đa `ms`; quá hạn thì bỏ mặc (không ném). */
const bounded = (promise: Promise<unknown> | undefined, ms: number): Promise<unknown> =>
  promise
    ? Promise.race([
        promise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
      ])
    : Promise.resolve();

/**
 * Dựng bot. Ném `BotDefinitionError` (khai báo sai) hoặc `ConfigError` (env thiếu/sai, gom
 * mọi lỗi) ngay tại đây, trước khi chạm mạng. Chưa nghe cổng nào cho tới `start()`.
 */
export function createBot<E extends EnvShape = Record<never, never>>(
  def: BotDefinition<E>,
  options: CreateBotOptions,
): Bot {
  const issues = validateBotDefinition(def);
  if (issues.length > 0) throw new BotDefinitionError(def?.id, issues);

  const clock = options.clock ?? systemClock;
  const back = def.backoffice;

  const userEnv = def.env ?? (defineEnv({}) as unknown as NonNullable<typeof def.env>);
  const loaded = loadConfig(mergeEnv(mergeEnv(kitEnv(!!back), llmEnv()), userEnv), {
    env: options.env,
    envFile: options.envFile,
    context: `bot ${def.id}`,
  });
  // Che theo GIÁ TRỊ mọi secret đã khai (key agent, secret webhook, secret của bot) trong log,
  // health và thông báo lỗi, ngoài việc lọc theo mẫu.
  const scrub = createScrubber([
    ...loaded.secretValues,
    ...(options.webhook ? (options.webhook.secrets ?? []) : []),
  ]);
  const logger = botLogger(def.id, options.logger ?? getLogger(), scrub);
  warnIfBunAutoLoadsEnv(options, logger);
  const kit = loaded.values as Record<string, any>;
  // LLM: `false` tắt hẳn; `client` thắng env; còn lại dựng từ LLM_* (thiếu một phần thì ném ConfigError).
  const llmOpt = options.llm;
  const llm: Llm | undefined =
    llmOpt === false
      ? undefined
      : (llmOpt?.client ??
        llmFromConfig(kit, {
          fetch: llmOpt?.fetch,
          onUsage: (event) => {
            logger.debug(
              `llm ${event.model}${event.outcome === "error" ? " (phản hồi hỏng)" : ""}: ${event.usage.inputTokens} vào / ${event.usage.outputTokens} ra, ${event.durationMs} ms, lần gọi ${event.attempts}`,
            );
            llmOpt?.onUsage?.(event);
          },
        }));
  // Chỉ phần của bot (không kèm biến kit) tới tay handler. `LLM_*` không bao giờ vào `ctx.config`
  // (kể cả khi bot gộp `llmEnv()` vào env của mình để bắt buộc): handler dùng `ctx.llm`, và
  // `LLM_API_KEY` không có lý do nằm trong tay handler.
  const userKeys = Object.keys(userEnv.shape).filter((k) => !LLM_ENV_KEYS.includes(k));
  const config = Object.fromEntries(
    userKeys.map((k) => [k, (loaded.values as Record<string, unknown>)[k]]),
  ) as InferEnv<E>;

  let state: BotState = "created";
  let startedAt: number | null = null;
  let stopping: Promise<void> | null = null;
  let healthHandle: HealthServerHandle | null = null;
  let webhookServer: ItsaplanWebhookServer | null = null;

  // ── hậu cần ──
  let worker: AgentRunWorker | null = null;
  let engine: RuleEngine<InferEnv<E>> | null = null;
  let tracker: ReturnType<typeof createScopedTracker> | null = null;
  let pollIntervalMs = 3000;
  let fatalError: Error | null = null;
  const fatalListeners = new Set<(error: Error) => void>();
  const drainTimeoutMs =
    options.worker?.drainTimeoutMs ?? kit.BOT_DRAIN_TIMEOUT_MS ?? DEFAULT_DRAIN_MS;
  const abortGraceMs = options.worker?.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const stopBudgetMs = drainTimeoutMs + abortGraceMs + SERVER_STOP_MS + 500;

  if (back) {
    const baseUrl = kit.ITSAPLAN_BASE_URL as string;
    const apiKey = kit.ITSAPLAN_AGENT_KEY as string;
    const client =
      options.itsaplanClient ??
      // Tắt retry: lệnh ghi (comment, tạo ticket) retry theo 5xx có thể ghi trùng.
      new ItsaplanClient(baseUrl, apiKey, { retryOptions: { maxRetries: 0 } });
    tracker = createScopedTracker(client, def.tracker, {
      clock,
      readRetries: options.trackerReads?.retries,
      readRetryBaseMs: options.trackerReads?.baseDelayMs,
    });
    const dispatcher = createRunDispatcher(back, {
      botId: def.id,
      projectKey: def.tracker.project,
      tracker,
      config,
      logger,
      clock,
      llm,
      scrub,
    });
    // Thông điệp lỗi và output của run được gửi lên itsaplan: che secret trước khi đi.
    const handler: AgentRunHandler = async (ctx) => {
      try {
        const outcome = await dispatcher(ctx);
        return outcome && typeof outcome === "object" ? scrub(outcome) : outcome;
      } catch (err) {
        if (err instanceof Error && String(scrub(err.message)) !== err.message) {
          throw new Error(String(scrub(err.message)));
        }
        throw err;
      }
    };
    const runs = back.runs ?? {};
    pollIntervalMs = kit.BOT_POLL_INTERVAL_MS ?? runs.pollIntervalMs ?? 3000;
    worker = new AgentRunWorker({
      client: new AgentRunsClient({ baseUrl, apiKey, fetch: options.fetch }),
      handler,
      concurrency: kit.BOT_RUN_CONCURRENCY ?? runs.concurrency ?? 1,
      pollIntervalMs,
      heartbeatIntervalMs: runs.heartbeatIntervalMs,
      runTimeoutMs: runs.runTimeoutMs,
      maxAttempts: runs.maxAttempts,
      drainTimeoutMs,
      abortGraceMs,
      logger,
      now: () => clock.now(),
      onFatal: (err) => {
        state = "failed";
        fatalError = new Error(String(scrub(err.message)));
        logger.error(`dừng vì lỗi không thể tự hồi phục: ${err.message}`);
        for (const listener of fatalListeners) {
          try {
            listener(fatalError);
          } catch {
            // listener hỏng không được che mất lỗi chết
          }
        }
      },
      ...options.worker,
    });
    if ((back.rules ?? []).length > 0) {
      engine = new RuleEngine({
        rules: back.rules ?? [],
        tracker,
        config,
        logger,
        clock,
      });
    }
  }

  if (def.receptionist) {
    logger.warn(
      "receptionist đã khai báo nhưng CHƯA chạy (runtime lễ tân thuộc milestone 2); chỉ backoffice hoạt động",
    );
  }

  function health(): BotHealth {
    const now = clock.now();
    const reasons: string[] = [];
    const components: BotHealth["components"] = {};
    let status: BotStatus;

    if (worker) {
      const w = worker.health();
      components.backoffice = {
        worker: {
          ...w,
          lastError: w.lastError === null ? null : scrub(w.lastError),
          lastPollAt: w.lastPollAt === null ? null : new Date(w.lastPollAt).toISOString(),
          lastClaimAt: w.lastClaimAt === null ? null : new Date(w.lastClaimAt).toISOString(),
        },
        rules: back?.rules?.length ?? 0,
      };
      if (state === "running") {
        if (w.state === "failed") reasons.push("worker run đã dừng vì lỗi chết");
        if (w.consecutiveErrors >= DEGRADED_ERRORS) {
          reasons.push(
            `claim lỗi ${w.consecutiveErrors} lần liên tiếp: ${scrub(w.lastError ?? "")}`,
          );
        }
        const stale = Math.max(STALE_FLOOR_MS, pollIntervalMs * 5 + STALE_FLOOR_MS);
        const since = w.lastPollAt ?? startedAt ?? now;
        // Đang bận hết `concurrency` thì worker cố ý không poll: không phải dấu hiệu hỏng.
        const saturated = w.active >= w.concurrency;
        if (w.state === "running" && !saturated && now - since > stale) {
          reasons.push(`chưa poll thành công trong ${Math.round((now - since) / 1000)}s`);
        }
      }
    }
    if (webhookServer) {
      components.webhook = { listening: webhookServer.port() !== null, port: webhookServer.port() };
    }
    if (def.receptionist) {
      components.receptionist = {
        state: "declared-not-running",
        note: "runtime lễ tân thuộc milestone 2",
      };
    }

    if (state === "created" || state === "starting") status = "starting";
    else if (state === "stopped" || state === "stopping") status = "stopped";
    else if (state === "failed" || worker?.health().state === "failed") status = "down";
    else status = reasons.length > 0 ? "degraded" : "ok";

    return {
      status,
      bot: def.id,
      state,
      startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
      uptimeSec: startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000)),
      components,
      reasons: reasons.map((r) => String(scrub(r))),
    };
  }

  async function teardown(): Promise<void> {
    await Promise.allSettled([
      worker?.stop(),
      bounded(webhookServer?.stop?.(), SERVER_STOP_MS),
      bounded(healthHandle?.stop(), SERVER_STOP_MS),
    ]);
  }

  const bot: Bot = {
    id: def.id,
    get state() {
      return state;
    },
    llm,

    async start() {
      if (state === "running" || state === "starting") return;
      if (state !== "created") throw new Error(`Bot ${def.id} đã ${state}, hãy createBot lại`);
      state = "starting";
      try {
        logger.info("khởi động", loaded.redacted);

        if (tracker && (options.preflight ?? true)) {
          // Fail-fast: key sai hoặc dự án không tồn tại thì dừng ở đây, không chờ poll đầu.
          await tracker.ready().catch((err: unknown) => {
            throw new Error(
              `Không truy cập được dự án ${tracker?.ref} trên itsaplan: ${scrub(err instanceof Error ? err.message : String(err))}`,
            );
          });
        }

        const webhookOpt = options.webhook;
        const webhookPort =
          webhookOpt === false ? undefined : (webhookOpt?.port ?? kit.BOT_WEBHOOK_PORT);
        if (engine) {
          if (webhookPort === undefined) {
            logger.warn(
              "có `rules` nhưng không nghe webhook (đặt BOT_WEBHOOK_PORT, hoặc host tự gọi bot.handleEvent)",
            );
          } else {
            const secrets = [
              ...(webhookOpt ? (webhookOpt.secrets ?? []) : []),
              ...(kit.ITSAPLAN_WEBHOOK_SECRET ? [kit.ITSAPLAN_WEBHOOK_SECRET as string] : []),
            ];
            const listenHost = (webhookOpt ? webhookOpt.host : undefined) ?? kit.BOT_WEBHOOK_HOST;
            if (secrets.length === 0 && !isLoopbackHost(listenHost)) {
              // Không chữ ký mà nghe ngoài loopback = ai trong mạng cũng giả được webhook.
              throw new Error(
                `webhook nghe ở ${listenHost} (ngoài loopback) mà chưa đặt ITSAPLAN_WEBHOOK_SECRET: từ chối khởi động`,
              );
            }
            webhookServer = new ItsaplanWebhookServer({
              itsaplanSecrets: secrets,
              listenHost,
            });
            const rules = engine;
            webhookServer.onEvent(async (envelope) => {
              await rules.handle(envelope);
            });
            await webhookServer.start(webhookPort);
          }
        }

        worker?.start();
        startedAt = clock.now();

        const healthOpt = options.healthServer;
        const healthPort =
          healthOpt === false ? undefined : (healthOpt?.port ?? kit.BOT_HEALTH_PORT);
        if (healthPort !== undefined) {
          healthHandle = await startHealthServer({
            port: healthPort,
            host: (healthOpt || undefined)?.host ?? kit.BOT_HEALTH_HOST,
            path: (healthOpt || undefined)?.path,
            health,
          });
        }
        if (state === "starting") state = "running";
        logger.info("đã chạy");
      } catch (err) {
        state = "failed";
        await teardown();
        throw err;
      }
    },

    stop() {
      stopping ??= (async () => {
        if (state === "created") {
          state = "stopped";
          return;
        }
        state = "stopping";
        logger.info("đang dừng");
        await teardown();
        state = "stopped";
        logger.info("đã dừng");
      })();
      return stopping;
    },

    health,
    stopBudgetMs,

    onFatal(listener) {
      fatalListeners.add(listener);
      if (fatalError) queueMicrotask(() => listener(fatalError as Error));
      return () => {
        fatalListeners.delete(listener);
      };
    },

    async handleEvent(envelope) {
      return engine ? engine.handle(envelope) : [];
    },

    addresses() {
      const out: ReturnType<Bot["addresses"]> = {};
      if (healthHandle) out.health = { host: healthHandle.host, port: healthHandle.port };
      const wp = webhookServer?.port();
      if (webhookServer && wp != null) out.webhook = { host: webhookServer.host() ?? "", port: wp };
      return out;
    },
  };
  return bot;
}

/**
 * Bun tự nạp `.env` (và `.env.local`…) của thư mục hiện tại vào `process.env` trước khi code
 * chạy, nên "env tường minh" chỉ đúng khi tắt việc đó. Ta không phát hiện được chắc chắn, chỉ
 * cảnh báo khi có `.env` cạnh nơi chạy và không thấy cờ `--no-env-file`.
 */
function warnIfBunAutoLoadsEnv(options: CreateBotOptions, logger: IntakeLogger): void {
  if (options.env !== process.env) return;
  if (typeof (process.versions as Record<string, string | undefined>).bun !== "string") return;
  if ([...process.execArgv, ...process.argv].includes("--no-env-file")) return;
  try {
    if (!existsSync(".env")) return;
  } catch {
    return;
  }
  logger.warn(
    "thư mục hiện tại có `.env` và Bun tự nạp nó vào process.env dù `envFile` không được truyền; biến trong file này có thể che cấu hình bạn nghĩ là đang dùng. Chạy `bun --no-env-file run ...` để chỉ đọc file qua `envFile`.",
  );
}

export type { LoadedConfig };
