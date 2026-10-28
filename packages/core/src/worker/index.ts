/**
 * `@vuihoc/bot-core/worker` — lắp sẵn worker báo ngược cho một bot tiếp nhận.
 *
 * Đây là bản đúc kết các bước BẮT BUỘC mà mọi bot (Tiểu Linh, Iris, OP, …) đều
 * phải đi qua để bật luồng Itsaplan → chat, rút ra từ lần dựng worker OP:
 *
 *   1. Mở một HTTP server nghe webhook ở một cổng.
 *   2. Dùng CHÍNH cổng đó sinh URL webhook (không để URL lệch cổng — lỗi OP 16/10).
 *   3. Dọn webhook cũ cùng host nhưng lệch cổng (không để sự kiện bắn vào cổng chết).
 *   4. Đăng ký / kích hoạt webhook chuẩn trên Itsaplan.
 *   5. Nối sự kiện webhook vào dispatcher (đẩy comment/đổi trạng thái về chat).
 *   6. Nối reply (người báo trả lời tin thông báo) vào reply-router (ghi comment).
 *
 * Bot sau chỉ cần gọi `startIntakeWorker(config)` với client Itsaplan, một
 * `ChannelPort` (Telegram là một bản — xem `@vuihoc/bot-core/telegram`), các kho
 * SQLite (binding/route) và cấu hình cổng/host/project. SỬA MỘT NƠI: logic chung
 * nằm ở đây; đổi hành vi thì đổi ở đây, các bot import lại.
 */
import type { ItsaplanClient } from "../itsaplan/client";
import {
  ItsaplanWebhookServer,
  type ItsaplanWebhookServerOptions,
} from "../itsaplan/webhook/server";
import {
  deriveWebhookUrl,
  ensureItsaplanWebhook,
  pruneForeignWebhooks,
} from "../itsaplan/ensure-webhook";
import {
  NotificationDispatcher,
  type NotificationDispatcherOptions,
} from "../intake/notify/dispatcher";
import { ReplyRouter, type ReplyRouterOptions } from "../intake/notify/reply-router";
import { getLogger } from "../core/logger";
import { inspectBindingDb } from "../core/lazy-db";
export { ReplyRouter, type ReplyRouterOptions } from "../intake/notify/reply-router";
export {
  NotificationDispatcher,
  type NotificationDispatcherOptions,
} from "../intake/notify/dispatcher";

export interface IntakeWorkerConfig {
  /** Client Itsaplan đã cấu hình (admin/agent key). */
  itsaplan: ItsaplanClient;
  /** Dự án worker này phụ trách, vd "OP". Dùng để lọc sự kiện + đăng ký webhook. */
  projectKey: string;
  /** Cổng worker nghe. URL webhook ĐƯỢC SINH TỪ cổng này — không truyền URL rời. */
  port: number;
  /** Host Itsaplan gọi về được (IP LAN của máy chạy worker). */
  host: string;
  /** Mặc định "/webhook". */
  webhookPath?: string;
  /** Mặc định "http". */
  scheme?: "http" | "https";
  /** Tuỳ chọn server webhook (secret chữ ký, trần body…). */
  server?: ItsaplanWebhookServerOptions;
  /** Phụ thuộc dispatcher: ChannelPort, binding reader, route store, copy… */
  dispatcher: Omit<NotificationDispatcherOptions, "projectKey">;
  /** Phụ thuộc reply-router: route store, tracker.addComment, copy… */
  reply: Omit<ReplyRouterOptions, "projectKey">;
  /**
   * Có dọn webhook cùng host lệch cổng trước khi đăng ký không. Mặc định true —
   * đây chính là bước vá lỗi OP (webhook thừa trỏ cổng chết).
   */
  pruneStaleWebhooks?: boolean;
  /**
   * (Tùy chọn) Đường dẫn file SQLite worker ĐANG dùng cho binding. Truyền vào để
   * lib TỰ KIỂM lúc khởi động: resolve ra tuyệt đối (cảnh báo nếu tương đối),
   * log file thật đang mở, và ĐẾM số dòng `ticket_bindings`. Đây là chốt chặn
   * tận gốc lỗi OP 16/10 — worker trỏ nhầm `data/op.db` rỗng (path tương đối +
   * CWD khác) nên đọc một DB không có binding và nuốt mọi comment lặng lẽ. Chỉ
   * ĐỌC để chẩn đoán; không mở kết nối worker dùng (store vẫn do bot tiêm). Bỏ
   * trống thì bỏ qua bước kiểm (hành vi như cũ).
   */
  dbPath?: string;
}

export interface IntakeWorkerHandle {
  server: ItsaplanWebhookServer;
  dispatcher: NotificationDispatcher;
  replyRouter: ReplyRouter;
  /** URL webhook đã đăng ký (sinh từ cổng). */
  webhookUrl: string;
  /** Cổng thật đang nghe. */
  port: number;
  stop(): Promise<void>;
}

/**
 * Lắp và khởi động worker. Trả về handle để test/tắt. KHÔNG đọc `process.env` —
 * mọi thứ tiêm vào, nên test bơm cổng 0 + client giả được.
 */
export async function startIntakeWorker(config: IntakeWorkerConfig): Promise<IntakeWorkerHandle> {
  // Chốt chặn lỗi OP 16/10: nếu bot cho biết file DB binding, kiểm nó NGAY lúc
  // khởi động (resolve tuyệt đối, đếm binding, cảnh báo nếu rỗng/trỏ nhầm) để
  // một worker đọc nhầm DB rỗng không "webhook 200 mà chat im" trong câm lặng.
  if (config.dbPath) inspectBindingDb(config.dbPath);

  const dispatcher = new NotificationDispatcher({
    ...config.dispatcher,
    projectKey: config.projectKey,
  });
  const replyRouter = new ReplyRouter({ ...config.reply, projectKey: config.projectKey });

  const server = new ItsaplanWebhookServer(config.server ?? {});
  server.onEvent((envelope) => dispatcher.handleEvent(envelope));
  server.onReporterReply(async (req) => {
    return replyRouter.recordReporterReply({
      chatId: req.chatId,
      messageId: req.messageId,
      text: req.text,
      userName: req.userName,
    });
  });

  // 1. Nghe TRƯỚC, rồi lấy cổng thật để sinh URL — hỗ trợ port 0 trong test.
  await server.start(config.port);
  const listenPort = server.port() ?? config.port;
  const webhookUrl = deriveWebhookUrl({
    host: config.host,
    port: listenPort,
    path: config.webhookPath,
    scheme: config.scheme,
  });

  // 2. Dọn webhook cùng host lệch cổng (bước vá lỗi OP), rồi đăng ký webhook chuẩn.
  if (config.pruneStaleWebhooks ?? true) {
    await pruneForeignWebhooks(config.itsaplan, config.projectKey, webhookUrl);
  }
  const ensured = await ensureItsaplanWebhook(config.itsaplan, config.projectKey, webhookUrl);
  getLogger().info(
    `[worker] ${config.projectKey}: nghe cổng ${listenPort}, webhook ${webhookUrl} — ${ensured.message}`,
  );

  return {
    server,
    dispatcher,
    replyRouter,
    webhookUrl,
    port: listenPort,
    async stop() {
      await server.stop?.();
    },
  };
}
