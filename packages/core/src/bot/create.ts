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
 * | `BOT_HEALTH_PORT`, `BOT_HEALTH_HOST` | bật `/healthz` |
 * | `BOT_WEBHOOK_PORT`, `BOT_WEBHOOK_HOST`, `ITSAPLAN_WEBHOOK_SECRET` | nhận webhook cho `rules` |
 */
import { z } from "zod";
import {
  type EnvShape,
  type InferEnv,
  type LoadedConfig,
  defineEnv,
  loadConfig,
  mergeEnv,
  secret,
} from "../core/config";
import { type IntakeLogger, getLogger } from "../core/logger";
import { type Clock, systemClock } from "../intake/ports";
import {
  type ItsaplanWebhookEnvelope,
  ItsaplanClient,
  ItsaplanWebhookServer,
  AgentRunsClient,
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
    Pick<AgentRunWorkerOptions, "drainTimeoutMs" | "errorBackoff" | "minPollIntervalMs" | "trace">
  > & { ledger?: RunLedger };
  /** Client itsaplan dựng sẵn (test). Mặc định dựng từ env, tắt retry cho lệnh ghi. */
  itsaplanClient?: ItsaplanClient;
}

/** Bot đang chạy được. */
export interface Bot {
  readonly id: string;
  readonly state: BotState;
  /** Bắt đầu chạy. Ném (sau khi dọn) nếu kiểm tra kết nối hoặc bind cổng thất bại. */
  start(): Promise<void>;
  /** Dừng êm (chờ run đang chạy tới hạn drain). Gọi lại là an toàn. */
  stop(): Promise<void>;
  health(): BotHealth;
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
  });
}

const DEGRADED_ERRORS = 3;
const STALE_FLOOR_MS = 30_000;

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
  const logger = botLogger(def.id, options.logger ?? getLogger());
  const back = def.backoffice;

  const userEnv = def.env ?? (defineEnv({}) as unknown as NonNullable<typeof def.env>);
  const loaded = loadConfig(mergeEnv(kitEnv(!!back), userEnv), {
    env: options.env,
    envFile: options.envFile,
    context: `bot ${def.id}`,
  });
  const kit = loaded.values as Record<string, any>;
  // Chỉ phần của bot (không kèm biến kit) tới tay handler.
  const userKeys = Object.keys(userEnv.shape);
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

  if (back) {
    const baseUrl = kit.ITSAPLAN_BASE_URL as string;
    const apiKey = kit.ITSAPLAN_AGENT_KEY as string;
    const client =
      options.itsaplanClient ??
      // Tắt retry: lệnh ghi (comment, tạo ticket) retry theo 5xx có thể ghi trùng.
      new ItsaplanClient(baseUrl, apiKey, { retryOptions: { maxRetries: 0 } });
    tracker = createScopedTracker(client, def.tracker.project, { clock });
    const handler = createRunDispatcher(back, {
      botId: def.id,
      projectKey: def.tracker.project,
      tracker,
      config,
      logger,
      clock,
    });
    const runs = back.runs ?? {};
    pollIntervalMs = kit.BOT_POLL_INTERVAL_MS ?? runs.pollIntervalMs ?? 3000;
    worker = new AgentRunWorker({
      client: new AgentRunsClient({ baseUrl, apiKey, fetch: options.fetch }),
      handler,
      concurrency: kit.BOT_RUN_CONCURRENCY ?? runs.concurrency ?? 1,
      pollIntervalMs,
      heartbeatIntervalMs: runs.heartbeatIntervalMs,
      runTimeoutMs: runs.runTimeoutMs,
      logger,
      now: () => clock.now(),
      onFatal: (err) => {
        state = "failed";
        logger.error(`dừng vì lỗi không thể tự hồi phục: ${err.message}`);
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
          lastPollAt: w.lastPollAt === null ? null : new Date(w.lastPollAt).toISOString(),
          lastClaimAt: w.lastClaimAt === null ? null : new Date(w.lastClaimAt).toISOString(),
        },
        rules: back?.rules?.length ?? 0,
      };
      if (state === "running") {
        if (w.state === "failed") reasons.push("worker run đã dừng vì lỗi chết");
        if (w.consecutiveErrors >= DEGRADED_ERRORS) {
          reasons.push(`claim lỗi ${w.consecutiveErrors} lần liên tiếp: ${w.lastError ?? ""}`);
        }
        const stale = Math.max(STALE_FLOOR_MS, pollIntervalMs * 5 + STALE_FLOOR_MS);
        const since = w.lastPollAt ?? startedAt ?? now;
        if (w.state === "running" && now - since > stale) {
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
      reasons: reasons.map((r) => String(r)),
    };
  }

  async function teardown(): Promise<void> {
    await Promise.allSettled([worker?.stop(), webhookServer?.stop?.(), healthHandle?.stop()]);
  }

  const bot: Bot = {
    id: def.id,
    get state() {
      return state;
    },

    async start() {
      if (state === "running" || state === "starting") return;
      if (state !== "created") throw new Error(`Bot ${def.id} đã ${state}, hãy createBot lại`);
      state = "starting";
      try {
        logger.info("khởi động", loaded.redacted);

        if (tracker && (options.preflight ?? true)) {
          // Fail-fast: key sai hoặc dự án không tồn tại thì dừng ở đây, không chờ poll đầu.
          await tracker.columns().catch((err: unknown) => {
            throw new Error(
              `Không truy cập được dự án ${def.tracker.project} trên itsaplan: ${err instanceof Error ? err.message : String(err)}`,
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
            webhookServer = new ItsaplanWebhookServer({
              itsaplanSecrets: secrets,
              listenHost: (webhookOpt ? webhookOpt.host : undefined) ?? kit.BOT_WEBHOOK_HOST,
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

export type { LoadedConfig };
