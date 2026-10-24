import http from "node:http";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  type ItsaplanClient,
  type ItsaplanWebhookEnvelope,
  isLoopback,
  safeEqualToken,
  verifyItsaplanSignature,
  webhookDedupeKey,
} from "@vuihoc/bot-core/itsaplan";
import { getLogger } from "@vuihoc/bot-core/core";
import type { ReporterOkResult, ReporterReplyResult } from "./ticket-closure";

export type WebhookEventHandler = (envelope: ItsaplanWebhookEnvelope) => Promise<void>;
export type TelegramUpdateHandler = (update: any) => Promise<void>;

export interface ItsaplanWebhookServerOptions {
  /** Giới hạn body mỗi request. Mặc định 1 MB — webhook thật chỉ vài KB. */
  maxBodyBytes?: number;
  /**
   * Secret ký webhook của Itsaplan (mỗi subscription một `whsec_…`, xem
   * `GET /projects/<key>/webhooks`). Có thì bắt buộc header
   * `X-Itsaplan-Signature` hợp lệ; rỗng thì nhận như cũ (kèm cảnh báo).
   * Nhiều giá trị vì webhook không lọc dự án — sự kiện có thể đến từ
   * subscription khác cùng trỏ về URL này.
   */
  itsaplanSecrets?: string[];
  /** `secret_token` đã khai khi setWebhook Telegram. Rỗng thì nhận như cũ (kèm cảnh báo). */
  telegramSecret?: string;
  /** Độ lệch tối đa của `t=` trong chữ ký so với đồng hồ máy. Mặc định 5 phút. */
  signatureToleranceSec?: number;
}

export type ReporterOkHandler = (request: {
  issueId: number;
  chatId: string;
  userName: string;
}) => Promise<ReporterOkResult>;

export type ReporterReplyHandler = (request: {
  chatId: string;
  messageId: string;
  text: string;
  userName: string;
}) => Promise<ReporterReplyResult>;

export type ForceNewHandler = (request: { chatId: string }) => Promise<void> | void;

export class ItsaplanWebhookServer {
  private server: http.Server | null = null;
  private handlers: WebhookEventHandler[] = [];
  private telegramHandlers: TelegramUpdateHandler[] = [];
  private reporterOkHandler: ReporterOkHandler | null = null;
  private reporterReplyHandler: ReporterReplyHandler | null = null;
  private forceNewHandler: ForceNewHandler | null = null;
  private seenWebhookKeys = new Set<string>();
  private readonly maxKeys = 5000;
  private readonly maxBodyBytes: number;
  private readonly itsaplanSecrets: string[];
  private readonly telegramSecret: string;
  private readonly signatureToleranceSec: number;

  constructor(options: ItsaplanWebhookServerOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.itsaplanSecrets = (options.itsaplanSecrets ?? []).map((x) => x.trim()).filter(Boolean);
    this.telegramSecret = (options.telegramSecret ?? "").trim();
    this.signatureToleranceSec = options.signatureToleranceSec ?? DEFAULT_SIGNATURE_TOLERANCE_SEC;
  }

  onEvent(handler: WebhookEventHandler): void {
    this.handlers.push(handler);
  }

  onTelegramUpdate(handler: TelegramUpdateHandler): void {
    this.telegramHandlers.push(handler);
  }

  /**
   * Bot chạy qua OpenClaw polling không nhận callback_query ở /telegram-webhook —
   * cú bấm "👍 Đã ổn" tới agent dưới dạng text. Plugin xac-nhan-xong bắt nó rồi
   * gọi POST /internal/reporter-ok (chỉ localhost). Chỉ ghi ý kiến người báo,
   * không đóng ticket (ADR-0006).
   */
  onReporterOk(handler: ReporterOkHandler): void {
    this.reporterOkHandler = handler;
  }

  /**
   * Bot polling cũng không có `update.message.reply_to_message` (webhook mode
   * mới có, xem telegram-handler.ts). Plugin xac-nhan-xong bắt `reply_to_id`
   * trong phong bì OpenClaw rồi gọi endpoint này để ghi phản hồi tự do của
   * người báo ("chưa ổn ạ...") thay vì để lọt vào agent như sự cố mới.
   */
  onReporterReply(handler: ReporterReplyHandler): void {
    this.reporterReplyHandler = handler;
  }

  /**
   * "/new" bị OpenClaw nuốt trước khi tới agent (coi là lệnh reset phiên) —
   * plugin xac-nhan-xong bắt nó ở `before_dispatch` rồi gọi endpoint này (chỉ
   * localhost) để đặt cờ "ép sự cố mới" cho chat (ADR-0008). Không trả kết quả
   * cho người dùng — tin vẫn đi tiếp vào agent như thường, pipeline tự đọc cờ.
   */
  onForceNew(handler: ForceNewHandler): void {
    this.forceNewHandler = handler;
  }

  /** Cổng thật đang nghe (hữu ích khi start(0) trong test). */
  port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  /**
   * Đọc body có giới hạn. Vượt giới hạn thì trả 413 ngay và bỏ phần còn lại —
   * không gom vô hạn vào RAM. Trả `null` khi đã tự trả lời lỗi.
   */
  private readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
    return new Promise((resolve) => {
      const declared = Number(req.headers["content-length"] ?? 0);
      const tooLarge = () => {
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "Payload too large" }));
        }
        req.resume();
        resolve(null);
      };
      if (declared > this.maxBodyBytes) return tooLarge();

      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          aborted = true;
          chunks.length = 0;
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", () => {
        if (!aborted) resolve(null);
      });
    });
  }

  private reply(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async start(port: number): Promise<void> {
    if (this.server) return;

    if (this.itsaplanSecrets.length === 0) {
      getLogger().warn(
        `[ItsaplanWebhookServer] Chưa cấu hình ITSAPLAN_WEBHOOK_SECRET — /webhook nhận request KHÔNG kiểm chữ ký. ` +
          `Lấy trường "secret" của subscription (GET /projects/<key>/webhooks) và đặt vào env.`,
      );
    }
    if (!this.telegramSecret) {
      getLogger().warn(
        `[ItsaplanWebhookServer] Chưa cấu hình TELEGRAM_WEBHOOK_SECRET — /telegram-webhook nhận request KHÔNG kiểm secret_token.`,
      );
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

        if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
          this.reply(res, 200, { status: "ok" });
          return;
        }

        if (req.method !== "POST") {
          this.reply(res, 405, { error: "Method not allowed" });
          return;
        }

        // /internal/confirm-done: tên cũ, plugin bản trước 24/09 còn gọi.
        if (pathname === "/internal/reporter-ok" || pathname === "/internal/confirm-done") {
          if (!isLoopback(req.socket.remoteAddress)) {
            req.resume();
            this.reply(res, 403, { error: "Forbidden" });
            return;
          }
          if (!this.reporterOkHandler) {
            req.resume();
            this.reply(res, 404, { error: "Not found" });
            return;
          }
          const body = await this.readBody(req, res);
          if (body === null) return;
          let payload: any;
          try {
            payload = JSON.parse(body);
          } catch {
            payload = null;
          }
          const issueId = Number(payload?.issueId);
          if (!Number.isInteger(issueId) || issueId <= 0) {
            this.reply(res, 400, { error: "issueId không hợp lệ" });
            return;
          }
          const userName =
            typeof payload.userName === "string" && payload.userName.trim()
              ? payload.userName.trim()
              : "Người báo";
          const chatId =
            payload.chatId === undefined || payload.chatId === null ? "" : String(payload.chatId);
          try {
            this.reply(res, 200, await this.reporterOkHandler({ issueId, chatId, userName }));
          } catch (err: any) {
            getLogger().error(
              `[ItsaplanWebhookServer] reporter-ok #${issueId} lỗi: ${err.message}`,
            );
            this.reply(res, 200, {
              outcome: "error",
              replyText: "Dạ em chưa ghi nhận được, anh/chị bấm lại giúp em sau ít phút nhé.",
            });
          }
          return;
        }

        if (pathname === "/internal/reporter-reply") {
          if (!isLoopback(req.socket.remoteAddress)) {
            req.resume();
            this.reply(res, 403, { error: "Forbidden" });
            return;
          }
          if (!this.reporterReplyHandler) {
            req.resume();
            this.reply(res, 404, { error: "Not found" });
            return;
          }
          const body = await this.readBody(req, res);
          if (body === null) return;
          let payload: any;
          try {
            payload = JSON.parse(body);
          } catch {
            payload = null;
          }
          const chatId =
            payload?.chatId === undefined || payload?.chatId === null ? "" : String(payload.chatId);
          const rawMessageId = payload?.replyToMessageId;
          const messageId =
            rawMessageId === undefined || rawMessageId === null ? "" : String(rawMessageId).trim();
          const text = typeof payload?.text === "string" ? payload.text.trim() : "";
          if (!chatId || !messageId || !text) {
            this.reply(res, 400, { error: "Thiếu chatId/replyToMessageId/text" });
            return;
          }
          const userName =
            typeof payload.senderName === "string" && payload.senderName.trim()
              ? payload.senderName.trim()
              : "Người báo";
          try {
            this.reply(
              res,
              200,
              await this.reporterReplyHandler({ chatId, messageId, text, userName }),
            );
          } catch (err: any) {
            getLogger().error(`[ItsaplanWebhookServer] reporter-reply lỗi: ${err.message}`);
            this.reply(res, 200, {
              handled: true,
              replyText: "Dạ em chưa ghi nhận được, anh/chị nhắn lại giúp em sau ít phút nhé.",
            });
          }
          return;
        }

        if (pathname === "/internal/force-new") {
          if (!isLoopback(req.socket.remoteAddress)) {
            req.resume();
            this.reply(res, 403, { error: "Forbidden" });
            return;
          }
          if (!this.forceNewHandler) {
            req.resume();
            this.reply(res, 404, { error: "Not found" });
            return;
          }
          const body = await this.readBody(req, res);
          if (body === null) return;
          let payload: any;
          try {
            payload = JSON.parse(body);
          } catch {
            payload = null;
          }
          const chatId =
            payload?.chatId === undefined || payload?.chatId === null
              ? ""
              : String(payload.chatId).trim();
          if (!chatId) {
            this.reply(res, 400, { error: "Thiếu chatId" });
            return;
          }
          try {
            await this.forceNewHandler({ chatId });
            this.reply(res, 200, { ok: true });
          } catch (err: any) {
            getLogger().error(`[ItsaplanWebhookServer] force-new (${chatId}) lỗi: ${err.message}`);
            this.reply(res, 200, { ok: false });
          }
          return;
        }

        if (pathname === "/telegram-webhook") {
          if (this.telegramSecret) {
            const token = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
            if (!safeEqualToken(token, this.telegramSecret)) {
              req.resume();
              this.reply(res, 401, { error: "Unauthorized" });
              return;
            }
          }
          const body = await this.readBody(req, res);
          if (body === null) return;
          let update: any;
          try {
            update = JSON.parse(body);
          } catch (err: any) {
            getLogger().error(
              `[ItsaplanWebhookServer] Failed to parse Telegram webhook body: ${err.message}`,
            );
            this.reply(res, 400, { error: "Invalid JSON" });
            return;
          }
          this.reply(res, 200, { ok: true });

          for (const handler of this.telegramHandlers) {
            try {
              await handler(update);
            } catch (err: any) {
              getLogger().error(
                `[ItsaplanWebhookServer] Error in Telegram handler: ${err.message}`,
              );
            }
          }
          return;
        }

        if (pathname !== "/webhook") {
          this.reply(res, 404, { error: "Not found" });
          return;
        }

        const body = await this.readBody(req, res);
        if (body === null) return;

        if (this.itsaplanSecrets.length > 0) {
          const header = req.headers["x-itsaplan-signature"];
          const ok = verifyItsaplanSignature(
            Array.isArray(header) ? header[0] : header,
            body,
            this.itsaplanSecrets,
            Math.floor(Date.now() / 1000),
            this.signatureToleranceSec,
          );
          if (!ok) {
            getLogger().warn(
              `[ItsaplanWebhookServer] Từ chối /webhook: chữ ký X-Itsaplan-Signature thiếu hoặc sai.`,
            );
            this.reply(res, 401, { error: "Invalid signature" });
            return;
          }
        }

        let envelope: ItsaplanWebhookEnvelope;
        try {
          envelope = JSON.parse(body) as ItsaplanWebhookEnvelope;
        } catch (err: any) {
          getLogger().error(`[ItsaplanWebhookServer] Failed to parse webhook body: ${err.message}`);
          this.reply(res, 400, { error: "Invalid JSON" });
          return;
        }

        const key = webhookDedupeKey(envelope);
        if (key) {
          if (this.seenWebhookKeys.has(key)) {
            this.reply(res, 200, { ok: true, duplicate: true });
            return;
          }
          this.seenWebhookKeys.add(key);
          if (this.seenWebhookKeys.size > this.maxKeys) {
            const oldest = this.seenWebhookKeys.values().next().value;
            if (oldest !== undefined) this.seenWebhookKeys.delete(oldest);
          }
        }

        this.reply(res, 200, { ok: true });

        for (const handler of this.handlers) {
          try {
            await handler(envelope);
          } catch (err: any) {
            getLogger().error(`[ItsaplanWebhookServer] Error in webhook handler: ${err.message}`);
          }
        }
      });

      this.server.on("error", reject);
      this.server.listen(port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server?.close((err) => {
        if (err) reject(err);
        else {
          this.server = null;
          resolve();
        }
      });
      // Không để keep-alive giữ process khi tắt.
      (this.server as any)?.closeAllConnections?.();
    });
  }

  /**
   * Registers this webhook server with Itsaplan for the given project, if
   * configured. Skipped when the url is unset (e.g. running behind a proxy or in dev).
   */
  async registerWithItsaplan(
    client: ItsaplanClient,
    projectKey: string,
    webhookUrl: string,
  ): Promise<void> {
    try {
      const existing = await client.listWebhooks(projectKey);
      const matched = existing.find((w) => w.url === webhookUrl);
      if (!matched) {
        await client.createWebhook(projectKey, {
          url: webhookUrl,
          events: [
            "issue.created",
            "issue.updated",
            "issue.state_changed",
            "issue.column_changed",
            "comment.created",
          ],
        });
      }
      getLogger().info(
        `[ItsaplanWebhookServer] Registered webhook with Itsaplan for project ${projectKey} -> ${webhookUrl}`,
      );
    } catch (err: any) {
      getLogger().warn(
        `[ItsaplanWebhookServer] Failed registering webhook with Itsaplan: ${err.message}`,
      );
    }
  }
}
