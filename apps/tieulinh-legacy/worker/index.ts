#!/usr/bin/env bun
/**
 * Hai việc nền mà MCP tool không làm thay được.
 *
 * 1. **Báo ngược.** Kỹ thuật viên bình luận hoặc đổi trạng thái trên Itsaplan
 *    thì người báo phải biết. Việc này xảy ra khi không có hội thoại nào đang
 *    mở, nên không có lượt nào để model gọi tool.
 * 2. **Nạp tri thức.** Ticket đóng thì rút kinh nghiệm vào Onyx. Cũng vậy:
 *    lúc đó cuộc trò chuyện đã kết thúc từ lâu.
 *
 * Worker chạy độc lập với agent. Agent nào cầm MCP cũng được, worker vẫn cứ
 * chạy nền — đó là ranh giới đúng.
 */
import { createItsaplanClient } from "../lib/itsaplan/client-factory";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { TicketBindingRepository } from "../lib/storage/binding-repository";
import { applySchema } from "../lib/storage/schema";
import { OnyxConnectorManager } from "../lib/onyx/connector-manager";
import { getLogger } from "@vuihoc/bot-core/core";
import { ItsaplanWebhookServer } from "./webhook-server";
import { NotificationDispatcher } from "./notification-dispatcher";
import { TicketLifecycleService } from "./lifecycle";
import { OnyxIngestService } from "./ingest.service";
import { isLlmConfigured, llmConfigFromEnv, parseApiStyle } from "./llm";
import { TelegramNotifier, type Notifier } from "./notifier";
import { normalizeProjectKey } from "@vuihoc/bot-core/itsaplan";
import { KgSyncRunner, resolveKgSyncGate, resolveOnyxSyncGate } from "./kg-sync-runner";
import { RelatedTicketsCurator } from "./related-curator";
import { RelatedRecheck } from "./related-recheck";
import { LlmSimilarTickets } from "../lib/kg/similar-ticket-source";
import type { JudgeMode } from "../lib/kg/similar-judge";
import { OnyxRestSearchClient } from "../lib/onyx/rest-search";
import { TicketClosure } from "./ticket-closure";
import { ProjectColumnStates } from "@vuihoc/bot-core/itsaplan";
import { KgSyncRepository } from "../lib/storage/kg-sync-repository";
import { DuplicateMerger } from "./duplicate-merger";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
  return value;
}

const dbPath = process.env.INTAKE_DB_PATH ?? "data/intake.db";
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath, { create: true });
applySchema(db, { wal: true });

const adminKey = required("ITSAPLAN_API_KEY");
const agentKey = process.env.ITSAPLAN_AGENT_KEY || adminKey;

// Client của bot (Tiểu Linh) dùng cho mọi trao đổi, comment, lifecycle, ingest
const itsaplan = createItsaplanClient(required("ITSAPLAN_BASE_URL"), agentKey);
// Client admin cho các tác vụ quản trị hạ tầng (như cấu hình webhook dự án)
const adminItsaplan = createItsaplanClient(required("ITSAPLAN_BASE_URL"), adminKey);
const bindings = new TicketBindingRepository(db);

// Mỗi dự án một worker. Webhook Itsaplan không lọc dự án và hai worker dùng
// chung DB — mọi đường xử lý khoá theo mã này.
const projectKey = normalizeProjectKey(process.env.ITSAPLAN_PROJECT_KEY);
if (!projectKey) {
  getLogger().warn(
    `[worker] Chưa cấu hình ITSAPLAN_PROJECT_KEY — worker KHÔNG khoá theo dự án, sẽ xử lý sự kiện của mọi dự án.`,
  );
}

const notifier: Notifier = new TelegramNotifier({
  botToken: required("TELEGRAM_BOT_TOKEN"),
  onCallChatId: process.env.ON_CALL_CHAT_ID,
  itsaplanLocalBaseUrl: process.env.ITSAPLAN_BASE_URL ?? "http://127.0.0.1:3100",
});
const notifiers = new Map<string, Notifier>([[notifier.channelType, notifier]]);

// Nạp Onyx là tuỳ chọn: thiếu cấu hình thì bot vẫn chạy, chỉ là không tích luỹ
// tri thức. Chết cả worker vì thiếu một khoá Onyx thì không đáng.
// Tương tự với Memgraph KG: ticket Done được chốt tri thức vào graph database
// (nguyên nhân gốc rễ + giải pháp + quan hệ) để truy vấn Cypher về sau.
const onyxBaseUrl = process.env.ONYX_BASE_URL;
let onyxRunner: KgSyncRunner | undefined;

const onyxGate = resolveOnyxSyncGate(process.env);
if (onyxGate.enabled && onyxBaseUrl) {
  getLogger().info(`[worker] Onyx: BẬT — ${onyxGate.reason}.`);
  const onyxConfig = {
    onyxBaseUrl,
    onyxApiKey: process.env.ONYX_API_KEY ?? "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    openaiApi: parseApiStyle(process.env.OPENAI_API_STYLE),
    itsaplanWebUrl: process.env.ITSAPLAN_WEB_URL ?? "",
    itsaplanProjectKey: required("ITSAPLAN_PROJECT_KEY"),
    docIdPrefix: process.env.ONYX_DOC_PREFIX ?? "ticket_",
  };
  const ingest = new OnyxIngestService(
    itsaplan,
    new OnyxConnectorManager(onyxConfig.onyxBaseUrl, onyxConfig.onyxApiKey),
    onyxConfig,
  );

  // Onyx lỗi → vào onyx_ingest_queue để thử lại (trước đây lỗi là mất việc).
  onyxRunner = new KgSyncRunner({
    label: "Onyx",
    repo: new KgSyncRepository(db, "onyx_ingest_queue"),
    projectKey: onyxConfig.itsaplanProjectKey,
    sync: async (issueId) => {
      const result = await ingest.ingestDoneTicket(issueId);
      return result.success
        ? { success: true, skipped: result.status === "skipped", reason: result.reason }
        : { success: false, error: result.error };
    },
  });
} else {
  getLogger().info(`[worker] Onyx: TẮT — ${onyxGate.reason}.`);
}

// Memgraph Knowledge Graph: chốt nguyên nhân gốc rễ + giải pháp vào graph
// khi ticket Done. Chỉ bật cho dự án được mời rõ ràng qua KG_SYNC_PROJECTS —
// có MEMGRAPH_URI trong apps/tieulinh-legacy/.env thôi chưa đủ (Iris/PO đọc chung file đó,
// mà quyết định nghiệp vụ là KG không dùng cho Iris). Lỗi KG không được làm
// rơi luồng chính: hỏng thì vào hàng đợi kg_sync_queue để thử lại.
let kgRunner: KgSyncRunner | undefined;
let closeMemgraph: (() => Promise<void>) | undefined;
// Chốt ticket tương tự lúc người ghim nguyên nhân (ADR-0007). RELATED_CURATOR:
// `dry` (mặc định) chỉ ghi log kế hoạch; `on` ghi Itsaplan; `off` tắt.
let curator: RelatedTicketsCurator | undefined;
let recheck: RelatedRecheck | undefined;
const kgGate = resolveKgSyncGate(process.env);
if (kgGate.enabled && kgGate.projectKey) {
  getLogger().info(`[worker] Knowledge Graph: BẬT — ${kgGate.reason}.`);
  const { MemgraphClient } = await import("../lib/kg/memgraph-client");
  const { syncDoneTicketToKnowledgeGraph } = await import("./kg-sync");
  const memgraph = new MemgraphClient();
  closeMemgraph = () => memgraph.close();
  await memgraph.ensureConstraints();
  // Idempotent: chạy mỗi lần worker khởi động để chắc chắn RootCause/Resolution
  // có index phục vụ truy vấn theo text nguyên nhân / giải pháp. CREATE INDEX
  // (không có ASSERT) trên Memgraph idempotent — đã có thì nuốt lỗi.
  await memgraph.ensureIndexes();
  const llmConfig = llmConfigFromEnv();
  const kgRepo = new KgSyncRepository(db);
  const kgProject = kgGate.projectKey;
  const curatorMode = (process.env.RELATED_CURATOR ?? "dry").trim().toLowerCase();
  if (curatorMode !== "off") {
    // Mode "suggested" (ticket chưa ghim) dùng cùng nguồn tra ticket tương tự mới
    // (KG + Onyx + BM25 + LLM xác minh từng cặp) như luồng tiếp nhận — chỉ bật
    // khi có cấu hình Onyx + LLM, không thì suggested không gợi ý gì (dọn theo
    // mã/link người đã gắn), pinned vẫn hoạt động bình thường.
    let similarSource: LlmSimilarTickets | undefined;
    if (onyxBaseUrl && process.env.ONYX_API_KEY && isLlmConfigured(llmConfig)) {
      const onyx = new OnyxRestSearchClient(
        { baseUrl: onyxBaseUrl, apiKey: process.env.ONYX_API_KEY },
        itsaplan,
      );
      similarSource = new LlmSimilarTickets({
        memgraph,
        onyx,
        llm: llmConfig,
        projectKey: kgProject,
        maxCandidates: Number(process.env.SIMILAR_MAX_CANDIDATES ?? 14),
        llmConcurrency: Number(process.env.SIMILAR_LLM_CONCURRENCY ?? 5),
        timeoutMs: Number(process.env.SIMILAR_TIMEOUT_MS ?? 60_000),
        judgeMode: (process.env.SIMILAR_JUDGE_MODE as JudgeMode | undefined) ?? "mechanism",
      });
    }
    curator = new RelatedTicketsCurator({
      itsaplan,
      corpus: memgraph,
      similarSource,
      projectKey: kgProject,
      dryRun: curatorMode !== "on",
      delayMs: Number(process.env.RELATED_CURATOR_DELAY_MS ?? 90_000),
    });
    getLogger().info(
      `[worker] Chốt ticket tương tự lúc ghim nguyên nhân: ${curatorMode === "on" ? "BẬT (ghi Itsaplan)" : "CHẠY THỬ (chỉ log)"}.`,
    );
    // Kho cụm nguyên nhân lớn dần theo mỗi lần tech lead ghim → tra lại ticket đang mở
    // chưa ghim (worker/related-recheck.ts). RELATED_RECHECK=off để tắt.
    if (similarSource && process.env.RELATED_RECHECK !== "off") {
      recheck = new RelatedRecheck({
        itsaplan,
        corpus: memgraph,
        curator,
        projectKey: kgProject,
        windowDays: Number(process.env.RELATED_RECHECK_DAYS ?? 14),
        intervalMs: Number(process.env.RELATED_RECHECK_INTERVAL_MS ?? 6 * 3600 * 1000),
        debounceMs: Number(process.env.RELATED_RECHECK_DEBOUNCE_MS ?? 30 * 60 * 1000),
      });
      recheck.start();
      getLogger().info(`[worker] Tra lại ticket tương tự cho ticket đang mở khi kho đổi: BẬT.`);
    }
  }
  kgRunner = new KgSyncRunner({
    repo: kgRepo,
    projectKey: kgProject,
    maxAttempts: Number(process.env.KG_SYNC_MAX_ATTEMPTS ?? 6),
    sync: (issueId) =>
      syncDoneTicketToKnowledgeGraph(itsaplan, memgraph, issueId, llmConfig, {
        projectKey: kgProject,
        ledger: kgRepo.ledger(),
      }),
  });
} else {
  getLogger().info(`[worker] Knowledge Graph: TẮT — ${kgGate.reason}.`);
}

const lifecycle = new TicketLifecycleService(db, itsaplan, {
  botAdapters: notifiers,
  itsaplanWebUrl: process.env.ITSAPLAN_WEB_URL,
  projectKey: projectKey ?? undefined,
});

// Vòng đời đã xử lý → hoàn tất (ADR-0006). Hoàn tất phát đúng một lần và đưa
// ticket vào từng sink tri thức; mỗi sink có hàng đợi thử lại của riêng nó.
const knowledgeSinks = [kgRunner, onyxRunner].filter((r): r is KgSyncRunner => !!r);
const closure = new TicketClosure({
  db,
  columns: new ProjectColumnStates(itsaplan),
  bindings,
  notifiers,
  itsaplan,
  projectKey: projectKey ?? undefined,
  onTicketDone: async (issueId, identifier) => {
    await Promise.allSettled(knowledgeSinks.map((sink) => sink.handle(issueId, identifier)));
  },
});

// Kỹ thuật tuyên bố ticket trùng bằng bình luận (ADR-0008 quyết định 7 ý 2) →
// bot tự gộp mô tả + huỷ ticket trùng (worker/duplicate-merger.ts). Mặc định
// bật khi có LLM; DUPLICATE_MERGE=off tắt hẳn (không đoán khi không có LLM).
let duplicateMerger: DuplicateMerger | undefined;
const duplicateMergeMode = (process.env.DUPLICATE_MERGE ?? "on").trim().toLowerCase();
const duplicateLlmConfig = llmConfigFromEnv();
if (duplicateMergeMode !== "off" && isLlmConfigured(duplicateLlmConfig)) {
  duplicateMerger = new DuplicateMerger({
    itsaplan,
    llm: duplicateLlmConfig,
    projectKey: projectKey ?? undefined,
    bindings,
  });
  getLogger().info(`[worker] Gộp ticket trùng theo tuyên bố kỹ thuật (ADR-0008): BẬT.`);
} else {
  getLogger().info(
    `[worker] Gộp ticket trùng theo tuyên bố kỹ thuật (ADR-0008): TẮT (${
      duplicateMergeMode === "off" ? "DUPLICATE_MERGE=off" : "chưa cấu hình LLM"
    }).`,
  );
}

const dispatcher = new NotificationDispatcher(
  bindings,
  {
    agentHandles: (process.env.AGENT_HANDLES || "iris,vhiris_bot,iris-bot,intake,intake-bot")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    itsaplanBaseUrl: required("ITSAPLAN_BASE_URL"),
    itsaplanWebUrl: process.env.ITSAPLAN_WEB_URL,
    closure,
    lifecycle,
    itsaplanClient: itsaplan,
    onTicketKnowledgeMaybeChanged: (issueId) => {
      curator?.schedule(issueId);
      recheck?.scheduleSoon();
    },
    duplicateMerger,
    // Mặc định đẩy mọi comment của người về người báo. Đặt `mention` để quay
    // lại cổng cũ (chỉ comment có tag @<bot>).
    commentForwardPolicy: process.env.COMMENT_FORWARD_POLICY === "mention" ? "mention" : "all",
    // Itsaplan bắn sự kiện của dự án khác sang webhook này (đo 17/09/2026), mà
    // hai worker dùng chung file binding — không khoá thì bot này trả lời hộ bot kia.
    projectKey: projectKey ?? undefined,
  },
  notifiers,
);

import { TelegramWebhookHandler } from "./telegram-handler";
import { AgentRunnerService } from "./agent-runner";

const webhook = new ItsaplanWebhookServer({
  // Secret `whsec_…` của subscription Itsaplan (GET /projects/<key>/webhooks).
  // Chưa đặt thì nhận như cũ + cảnh báo — không làm gãy worker đang chạy.
  itsaplanSecrets: (process.env.ITSAPLAN_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  // Phải trùng `secret_token` khai khi gọi setWebhook của Telegram.
  telegramSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  maxBodyBytes: Number(process.env.WEBHOOK_MAX_BODY_BYTES ?? 1024 * 1024),
});
webhook.onEvent((envelope) => dispatcher.handleWebhook(envelope));

const telegramHandler = new TelegramWebhookHandler({
  itsaplan,
  closure,
  bindings,
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  projectKey: projectKey ?? undefined,
});
webhook.onTelegramUpdate((update) => telegramHandler.handleUpdate(update));
// Nút "👍 Đã ổn" từ bot chạy qua OpenClaw polling (plugin xac-nhan-xong).
webhook.onReporterOk((request) => closure.recordReporterOk(request));
// Phản hồi tự do ("chưa ổn ạ...") reply vào tin thông báo, cũng qua polling — cùng plugin.
webhook.onReporterReply((request) =>
  closure.recordReporterReply({
    chatId: request.chatId,
    messageId: request.messageId,
    text: request.text,
    userName: request.userName,
  }),
);
// "/new" bị OpenClaw nuốt trước khi tới agent — plugin xac-nhan-xong báo tới đây
// (ADR-0008), chỉ cần đặt cờ; pipeline tự đọc cờ này ở lượt kế tiếp.
webhook.onForceNew(({ chatId }) => {
  bindings.setChatFlag(chatId, "force_new");
});

const port = Number(process.env.WEBHOOK_PORT ?? 3102);
await webhook.start(port);
lifecycle.start(Number(process.env.LIFECYCLE_INTERVAL_MS ?? 60_000));
// Mục tồn từ lần chạy trước được xử lý ngay khi khởi động, sau đó theo chu kỳ.
for (const sink of knowledgeSinks)
  sink.start(Number(process.env.KG_SYNC_RETRY_INTERVAL_MS ?? 60_000));

let runner: AgentRunnerService | null = null;
const agentApiKey = process.env.ITSAPLAN_AGENT_KEY;
if (agentApiKey) {
  runner = new AgentRunnerService({
    itsaplanBaseUrl: required("ITSAPLAN_BASE_URL"),
    agentApiKey,
    bindingRepo: bindings,
    botAdapters: notifiers,
    agentHandles: (process.env.AGENT_HANDLES || "tieulinh,vhticket_bot,intake")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    itsaplanWebUrl: process.env.ITSAPLAN_WEB_URL,
    pollIntervalMs: Number(process.env.RUNNER_POLL_INTERVAL_MS ?? 3000),
    projectKey: projectKey ?? undefined,
  });
  runner.start();
} else {
  getLogger().warn(`[worker] Chưa cấu hình ITSAPLAN_AGENT_KEY — runner tạm thời chưa chạy.`);
}

// Tự động kiểm tra và kích hoạt Webhook trên Itsaplan nếu có cấu hình WEBHOOK_URL
const webhookUrl = process.env.WEBHOOK_URL;
if (webhookUrl && !projectKey) {
  getLogger().warn(
    `[worker] Có WEBHOOK_URL nhưng thiếu ITSAPLAN_PROJECT_KEY — không đăng ký webhook (không đoán "TECH").`,
  );
} else if (webhookUrl && projectKey) {
  import("../lib/itsaplan/ensure-webhook").then(({ ensureTieuLinhWebhook }) => {
    ensureTieuLinhWebhook(adminItsaplan, projectKey, webhookUrl).catch((err) => {
      getLogger().warn(`[worker] Không thể tự động đảm bảo webhook: ${err.message}`);
    });
  });
}

getLogger().info(`[worker] Webhook nghe ở cổng ${port}, lifecycle và agent runner đang chạy.`);

// Một đường tắt duy nhất cho SIGINT/SIGTERM: dừng nhận việc mới, chờ lượt nạp
// KG đang chạy xong, đóng Memgraph + DB rồi mới exit. Trước đây có hai handler
// SIGINT riêng — process.exit ở handler này có thể chạy trước memgraph.close.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  getLogger().info(`[worker] Nhận ${signal}, đang dừng...`);
  // Lưới an toàn: kẹt ở đâu đó quá 10s thì vẫn thoát.
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref?.();
  try {
    if (runner) runner.stop();
    lifecycle.stop();
    curator?.stop();
    await webhook
      .stop()
      .catch((err) => getLogger().warn(`[worker] Lỗi dừng webhook: ${err.message}`));
    await Promise.allSettled(knowledgeSinks.map((sink) => sink.stop()));
    await closeMemgraph?.().catch((err) =>
      getLogger().warn(`[worker] Lỗi đóng Memgraph: ${err.message}`),
    );
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
