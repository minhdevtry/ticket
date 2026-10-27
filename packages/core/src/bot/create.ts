/**
 * `createBot` — dựng runtime WORKER HẬU CẦN của một bot từ khai báo `defineBot`.
 *
 * Lưu ý vai trò (RFC 0001, RFC 0002):
 * `createBot` CHỈ phụ trách vai hậu cần (backoffice): poll `agent-runs` native của
 * itsaplan, nhận webhook, chạy lịch cron, hẹn giờ và `/healthz`. Nó KHÔNG chạy lễ tân:
 * vai lễ tân là một pack MCP + skill cắm vào harness agent (OpenClaw), dựng bằng
 * `createReceptionistMcpServer` và `exportSkillPack`.
 *
 * Vòng đời: `createBot` (đồng bộ: kiểm khai báo, nạp + kiểm env, dựng đối tượng, KHÔNG
 * mạng, KHÔNG nghe cổng) → `start()` (kiểm tra kết nối dự án, bật worker run, webhook,
 * `/healthz`) → `health()` bất cứ lúc nào → `stop()` (êm, idempotent).
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
 * | `BOT_DATA_DIR` | thư mục kho bền SQLite (`<dir>/<bot.id>.sqlite`): ledger run, khoá chống trùng, mốc cron, hẹn giờ. Không đặt thì in-memory |
 * | `BOT_TIMEZONE` | múi giờ của `backoffice.schedule` (mặc định `Asia/Ho_Chi_Minh`) |
 * | `BOT_WEBHOOK_AUTO_REGISTER`, `BOT_WEBHOOK_URL`, `ITSAPLAN_WEBHOOK_KEY` | tự đăng ký webhook theo `rules` (opt-in) |
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
import {
  LLM_ENV_KEYS,
  type Llm,
  type LlmUsageEvent,
  llmEnv,
  llmFromConfig,
  withSignal,
} from "../llm";
import { type Clock, systemClock } from "../intake/ports";
import {
  type ItsaplanWebhookEnvelope,
  ItsaplanClient,
  isTransientError,
  ItsaplanWebhookServer,
  AgentRunsClient,
  type AgentRunHandler,
  AgentRunWorker,
  type AgentRunWorkerHealth,
  type AgentRunWorkerOptions,
  type RunLedger,
} from "../itsaplan";
import {
  type InboundContext,
  type RuleRunSummary,
  BotScheduler,
  type BotSchedulerHealth,
  BotStore,
  DEFAULT_TIMEZONE,
  RuleEngine,
  type ScheduleContext,
  type ScheduleEntry,
  WebhookPermissionError,
  assertTimezone,
  createKeysProvider,
  createRunDispatcher,
  createScopedTracker,
  ensureRuleWebhook,
  parseCron,
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
    webhook?: {
      listening: boolean;
      port: number | null;
      autoRegistered?: boolean;
      /** Webhook của bot bị người khác tắt (bot không tự bật lại). */
      disabledWebhookId?: number;
    };
    /** Lịch cron và hẹn giờ của luật (khi bot có `schedule` hoặc `closeAfter`/`after`). */
    scheduler?: Omit<BotSchedulerHealth, "lastTickAt" | "lastErrorAt"> & {
      lastTickAt: string | null;
      lastErrorAt: string | null;
    };
    /** Kho bền: `durable` là `true` khi có `BOT_DATA_DIR`/`dataDir` (sống qua restart). */
    store?: { durable: boolean };
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
  webhook?:
    | false
    | {
        port?: number;
        host?: string;
        secrets?: string[];
        /** `secret_token` đã khai khi `setWebhook` của Telegram (ghi đè `TELEGRAM_WEBHOOK_SECRET`). */
        telegramSecret?: string;
        /** URL mà itsaplan gọi tới được, để tự đăng ký (ghi đè `BOT_WEBHOOK_URL`). */
        url?: string;
        /**
         * Tự đăng ký webhook của dự án theo `rules` khi `start()` (ghi đè `BOT_WEBHOOK_AUTO_REGISTER`).
         * Mặc định TẮT. Cần `url` và một key có quyền webhook (`ITSAPLAN_WEBHOOK_KEY`); thiếu quyền
         * thì `start()` ném `WebhookPermissionError`. Chỉ đụng dự án của `tracker`.
         */
        autoRegister?: boolean;
      };
  /**
   * Thư mục kho bền (ghi đè `BOT_DATA_DIR`). Có thì file `<dataDir>/<bot.id>.sqlite` giữ ledger
   * run, khoá chống trùng (`reply#n`, sự kiện webhook), mốc cron và hẹn giờ qua restart. Không có
   * thì mọi thứ in-memory (mặc định của test). Nên là đường dẫn tuyệt đối.
   */
  dataDir?: string;
  /**
   * Kho dựng sẵn (test, hoặc host chia sẻ một kho). `createBot` KHÔNG đóng kho này khi `stop()`:
   * ai mở thì người đó đóng. Ưu tiên hơn `dataDir`.
   */
  store?: BotStore;
  /** Tinh chỉnh bộ chạy lịch/hẹn giờ. */
  scheduler?: {
    /** Chu kỳ tick (ms). Mặc định 1000. */
    tickMs?: number;
    /** Lease của lịch/timer đang chạy (ms). Mặc định 120 000. */
    leaseMs?: number;
    timerMaxAttempts?: number;
    timerBackoffMs?: number;
  };

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
  /**
   * Kho bền của bot (`null` nếu bot không có hậu cần). Đọc hẹn giờ/mốc cron để vận hành hoặc test;
   * không tự đóng nó (bot đóng khi `stop()` nếu chính bot mở).
   */
  readonly store: BotStore | null;
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
    TELEGRAM_WEBHOOK_SECRET: secret(z.string().min(1).optional()),
    BOT_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
    BOT_DATA_DIR: z.string().min(1).optional(),
    BOT_TIMEZONE: z
      .string()
      .min(1)
      .refine(
        (tz) => {
          try {
            assertTimezone(tz);
            return true;
          } catch {
            return false;
          }
        },
        { message: `múi giờ IANA không hợp lệ (vd "${DEFAULT_TIMEZONE}")` },
      )
      .optional(),
    BOT_WEBHOOK_URL: z.url().optional(),
    BOT_WEBHOOK_AUTO_REGISTER: z.stringbool().optional(),
    ITSAPLAN_WEBHOOK_KEY: secret(z.string().min(1).optional()),
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
  let autoRegistered = false;
  let disabledWebhookId: number | null = null;

  // ── kho bền ──
  const webhookOpt0 = options.webhook === false ? undefined : options.webhook;
  const autoRegister = webhookOpt0?.autoRegister ?? kit.BOT_WEBHOOK_AUTO_REGISTER ?? false;
  const registerUrl: string | undefined = webhookOpt0?.url ?? kit.BOT_WEBHOOK_URL;
  if (autoRegister) {
    const problems: string[] = [];
    if (options.webhook === false) problems.push("`webhook: false` đang tắt webhook");
    if (!(back?.rules ?? []).length)
      problems.push("bot không có `backoffice.rules` (không có gì để đăng ký)");
    if (!registerUrl) problems.push("thiếu BOT_WEBHOOK_URL (URL mà itsaplan gọi tới được)");
    else if (!/^https?:\/\//i.test(registerUrl))
      problems.push("BOT_WEBHOOK_URL phải bắt đầu bằng http:// hoặc https://");
    if (problems.length > 0) {
      throw new Error(
        `tự đăng ký webhook (BOT_WEBHOOK_AUTO_REGISTER) không dùng được: ${problems.join("; ")}`,
      );
    }
  }
  const dataDir: string | undefined = options.dataDir ?? kit.BOT_DATA_DIR;
  let store: BotStore | null = null;
  let ownsStore = false;
  if (back) {
    if (options.store) {
      store = options.store;
    } else if (dataDir) {
      if (!isAbsolute(dataDir)) {
        logger.warn(
          `BOT_DATA_DIR "${dataDir}" là đường dẫn tương đối: file kho tính theo thư mục chạy hiện tại; nên dùng đường dẫn tuyệt đối`,
        );
      }
      const file = join(resolve(dataDir), `${def.id}.sqlite`);
      try {
        store = BotStore.open(file);
      } catch (err) {
        throw new Error(
          `Không mở được kho dữ liệu của bot "${def.id}" ở ${file}: ${scrub(err instanceof Error ? err.message : String(err))}`,
        );
      }
      ownsStore = true;
    } else {
      store = BotStore.memory();
      ownsStore = true;
    }
  }
  const durable = store?.durable === true;
  const keysProvider = createKeysProvider(store, () => clock.now());
  const closeStore = () => {
    if (ownsStore) store?.close();
  };

  // ── hậu cần ──
  let worker: AgentRunWorker | null = null;
  let scheduler: BotScheduler | null = null;
  let itsaplanClient: ItsaplanClient | null = null;
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
    itsaplanClient = client;
    const nowMs = () => clock.now();
    tracker = createScopedTracker(client, def.tracker, {
      clock,
      readRetries: options.trackerReads?.retries,
      readRetryBaseMs: options.trackerReads?.baseDelayMs,
      // Khoá comment đã ghi (`reply#n`…) sống qua restart khi có kho bền.
      keys: durable ? store?.keys("comment", { now: nowMs }) : undefined,
    });
    const dispatcher = createRunDispatcher(back, {
      botId: def.id,
      projectKey: def.tracker.project,
      tracker,
      config,
      logger,
      clock,
      llm,
      keys: keysProvider,
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
      // Kết quả đã tính xong mà chưa báo được sống qua restart khi có kho bền.
      ...(durable && store ? { ledger: store.ledger({ now: nowMs }) } : {}),
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
        store: store ?? undefined,
        llm,
        keys: keysProvider,
        reporter: back.reporter,
        // Sự kiện webhook đã xử lý xong sống qua restart khi có kho bền.
        seen: durable ? store?.keys("rule-seen", { ttlMs: 7 * 86_400_000, now: nowMs }) : undefined,
      });
    }

    // ── lịch cron của bot + hẹn giờ của luật ──
    const scheduleOpts = back.scheduleOptions ?? {};
    const scoped = tracker;
    const entries: ScheduleEntry[] = Object.entries(back.schedule ?? {}).map(([expr, value]) => {
      const job = typeof value === "function" ? { run: value } : value;
      const timezone =
        job.timezone ?? scheduleOpts.timezone ?? kit.BOT_TIMEZONE ?? DEFAULT_TIMEZONE;
      const cron = parseCron(expr, timezone);
      return {
        id: `${cron.expression}@${timezone}`,
        cron,
        missed: job.missed ?? scheduleOpts.missed ?? "skip",
        run: async (info, signal) => {
          const ctx: ScheduleContext<InferEnv<E>> = {
            bot: { id: def.id, project: def.tracker.project, ref: scoped.ref, agent: back.agent },
            job: cron.expression,
            scheduledFor: info.scheduledFor,
            firedAt: info.firedAt,
            timezone,
            missed: info.missed,
            missedCount: info.missedCount,
            config,
            logger,
            signal,
            tracker: scoped.forSignal(signal),
            llm: llm ? withSignal(llm, signal) : undefined,
            clock,
            idempotencyKey: `cron:${cron.expression}:${info.scheduledFor}`,
            keys: keysProvider,
          };
          await job.run(ctx);
        },
      };
    });
    const activeEngine = engine as RuleEngine<InferEnv<E>> | null;
    if (store && (entries.length > 0 || activeEngine?.hasTimers())) {
      scheduler = new BotScheduler({
        store,
        clock,
        logger,
        entries,
        timers: activeEngine?.hasTimers()
          ? { fire: (row, signal) => activeEngine.fireTimer(row, signal) }
          : undefined,
        graceMs: scheduleOpts.graceMs,
        ...options.scheduler,
      });
    }
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
    if (disabledWebhookId !== null && state === "running") {
      reasons.push(
        `webhook #${disabledWebhookId} đang bị tắt trên itsaplan: luật không nhận sự kiện`,
      );
    }
    if (webhookServer) {
      components.webhook = {
        listening: webhookServer.port() !== null,
        port: webhookServer.port(),
        ...(autoRegister ? { autoRegistered } : {}),
        ...(disabledWebhookId !== null ? { disabledWebhookId } : {}),
      };
    }
    if (scheduler) {
      const h = scheduler.health();
      components.scheduler = {
        ...h,
        lastTickAt: h.lastTickAt === null ? null : new Date(h.lastTickAt).toISOString(),
        lastErrorAt: h.lastErrorAt === null ? null : new Date(h.lastErrorAt).toISOString(),
        lastError: h.lastError === null ? null : String(scrub(h.lastError)),
      };
      if (state === "running") {
        const lagLimit = Math.max(30_000, (options.scheduler?.tickMs ?? 1000) * 10);
        if (h.tickLagMs !== null && h.tickLagMs > lagLimit) {
          reasons.push(`bộ chạy lịch không tick suốt ${Math.round(h.tickLagMs / 1000)}s`);
        }
        if (h.lastError !== null) reasons.push(`lịch/hẹn giờ lỗi gần đây: ${scrub(h.lastError)}`);
        if (h.failedTimers > 0) {
          reasons.push(
            `${h.failedTimers} hẹn giờ đã bỏ cuộc trong 24 giờ qua (xem bot.store.listTimers({ state: "failed" }))`,
          );
        }
      }
    }
    if (store) components.store = { durable };

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
      scheduler?.stop(drainTimeoutMs, abortGraceMs),
      bounded(webhookServer?.stop?.(), SERVER_STOP_MS),
      bounded(healthHandle?.stop(), SERVER_STOP_MS),
    ]);
    // Đóng kho SAU cùng: worker và bộ chạy lịch còn ghi vào nó tới phút cuối.
    closeStore();
  }

  /**
   * Tự đăng ký webhook theo `rules` (opt-in). Chỉ đụng dự án của bot. Lỗi quyền hoặc cấu hình ném
   * ra (start() thất bại, nói rõ cần làm gì); itsaplan chập chờn (5xx/mạng) chỉ cảnh báo vì việc
   * đăng ký lặp lại ở lần khởi động sau.
   */
  async function registerWebhook(
    rules: RuleEngine<InferEnv<E>>,
    scoped: ReturnType<typeof createScopedTracker>,
    client: ItsaplanClient,
  ): Promise<void> {
    const webhookKey = kit.ITSAPLAN_WEBHOOK_KEY as string | undefined;
    const registrar = webhookKey
      ? new ItsaplanClient(kit.ITSAPLAN_BASE_URL as string, webhookKey, {
          retryOptions: { maxRetries: 0 },
        })
      : client;
    try {
      const { projectId } = await scoped.ready();
      const result = await ensureRuleWebhook({
        client: registrar,
        projectRef: scoped.ref,
        projectId,
        url: registerUrl as string,
        events: rules.requiredEvents(),
        secret: (kit.ITSAPLAN_WEBHOOK_SECRET as string | undefined) || undefined,
      });
      if (result.action === "disabled") {
        disabledWebhookId = result.webhookId;
        logger.warn(
          `webhook #${result.webhookId} của ${scoped.ref} (${registerUrl}) đang bị TẮT: bot không tự bật lại (có thể là chủ ý). Bật nó trên itsaplan để luật nhận sự kiện${(result.missingEvents ?? []).length > 0 ? `; webhook còn thiếu sự kiện ${(result.missingEvents ?? []).join(", ")}` : ""}`,
        );
        return;
      }
      autoRegistered = true;
      logger.info(
        `webhook ${result.action} (#${result.webhookId}) cho ${scoped.ref}: ${result.events.join(", ")}`,
      );
      if (result.secretMatches === false) {
        logger.warn(
          `secret của webhook #${result.webhookId} KHÁC ITSAPLAN_WEBHOOK_SECRET: chữ ký sẽ bị từ chối. Đặt ITSAPLAN_WEBHOOK_SECRET đúng secret của webhook này`,
        );
      } else if (result.secretMatches === null && !kit.ITSAPLAN_WEBHOOK_SECRET) {
        logger.warn(
          "webhook có secret do itsaplan cấp nhưng ITSAPLAN_WEBHOOK_SECRET chưa đặt: lấy secret từ webhook trên itsaplan và đặt biến này để kiểm chữ ký",
        );
      }
    } catch (err) {
      if (err instanceof WebhookPermissionError) throw err;
      if (isTransientError(err)) {
        logger.warn(
          `không đăng ký được webhook (lỗi tạm thời, thử lại ở lần khởi động sau): ${scrub(err instanceof Error ? err.message : String(err))}`,
        );
        return;
      }
      throw err;
    }
  }

  const bot: Bot = {
    id: def.id,
    store,
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
        const inbound = back?.inbound;
        const hasInbound = !!(
          inbound?.reporterOk ||
          inbound?.reporterReply ||
          inbound?.telegramUpdate ||
          inbound?.forceNew
        );
        if (engine || hasInbound) {
          if (webhookPort === undefined) {
            logger.warn(
              engine
                ? "có `rules` nhưng không nghe webhook (đặt BOT_WEBHOOK_PORT, hoặc host tự gọi bot.handleEvent)"
                : "có `inbound` nhưng không nghe webhook (đặt BOT_WEBHOOK_PORT): tin của người báo không tới được bot",
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
            const telegramSecret =
              (webhookOpt ? webhookOpt.telegramSecret : undefined) ??
              (kit.TELEGRAM_WEBHOOK_SECRET as string | undefined);
            if (inbound?.telegramUpdate && !telegramSecret && !isLoopbackHost(listenHost)) {
              // `/telegram-webhook` mở ra ngoài mà không có secret_token = ai cũng giả được tin người báo.
              throw new Error(
                `webhook nghe ở ${listenHost} (ngoài loopback) và nhận tin Telegram mà chưa đặt TELEGRAM_WEBHOOK_SECRET: từ chối khởi động`,
              );
            }
            webhookServer = new ItsaplanWebhookServer({
              itsaplanSecrets: secrets,
              telegramSecret,
              listenHost,
            });
            if (engine) {
              const rules = engine;
              webhookServer.onEvent(async (envelope) => {
                await rules.handle(envelope);
              });
            }
            if (inbound && tracker) {
              const scoped = tracker;
              const inboundCtx: InboundContext<InferEnv<E>> = {
                bot: {
                  id: def.id,
                  project: def.tracker.project,
                  ref: scoped.ref,
                  agent: back?.agent,
                },
                config,
                logger,
                tracker: scoped,
                llm,
                clock,
                keys: keysProvider,
              };
              if (inbound.reporterOk) {
                const handle = inbound.reporterOk;
                webhookServer.onReporterOk((req) => Promise.resolve(handle(inboundCtx, req)));
              }
              if (inbound.reporterReply) {
                const handle = inbound.reporterReply;
                webhookServer.onReporterReply((req) => Promise.resolve(handle(inboundCtx, req)));
              }
              if (inbound.telegramUpdate) {
                const handle = inbound.telegramUpdate;
                webhookServer.onTelegramUpdate(async (update) => {
                  await handle(inboundCtx, update);
                });
              }
              if (inbound.forceNew) {
                const handle = inbound.forceNew;
                webhookServer.onForceNew((req) => Promise.resolve(handle(inboundCtx, req)));
              }
            }
            await webhookServer.start(webhookPort);
          }
        }

        if (autoRegister && engine && tracker && itsaplanClient) {
          await registerWebhook(engine, tracker, itsaplanClient);
        }

        worker?.start();
        scheduler?.start();
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
          closeStore();
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
