/**
 * `ItsaplanWebhookServer` — the hardened HTTP front door for Itsaplan webhooks.
 *
 * NGUỒN: intake `worker/webhook-server.ts` (a6275e7: 1 MB body cap, Itsaplan
 * signature, Telegram `secret_token`, event+issue dedupe). Behaviour ported
 * verbatim, with two deliberate library changes:
 *  - the in-RAM dedupe `Set` is replaced by an injected `WebhookDedupeStore`
 *    (default: bounded in-memory; a bot passes `SqliteWebhookDedupeStore` for
 *    the CM durable guard);
 *  - the loopback-only internal endpoints (`/internal/reporter-ok`,
 *    `/internal/reporter-reply`, `/internal/force-new`) call INJECTED handlers
 *    with plain typed payloads — no Telegram, no OpenClaw coupling.
 *
 * The server validates and dedupes; it does NOT know about channels or the
 * dispatcher. A caller registers `onEvent(...)` handlers (the notify dispatcher
 * is one). Project-lock filtering is the dispatcher's job (it needs the
 * binding/identifier), so the server does not filter by project.
 */
import http from "node:http";
import { getLogger } from "../../core/logger";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  parseWebhookEnvelope,
  safeEqualToken,
  verifyItsaplanSignature,
  webhookDedupeKey,
  type ItsaplanWebhookEnvelope,
} from "./events";
import { MemoryWebhookDedupeStore } from "./dedupe-store";
import type { WebhookDedupeStore } from "../../intake/ports";

export type WebhookEventHandler = (envelope: ItsaplanWebhookEnvelope) => Promise<void>;
export type TelegramUpdateHandler = (update: any) => Promise<void>;

export type ReporterOkHandler = (request: {
  issueId: number;
  chatId: string;
  userName: string;
}) => Promise<unknown>;
export type ReporterReplyHandler = (request: {
  chatId: string;
  messageId: string;
  text: string;
  userName: string;
}) => Promise<unknown>;
export type ForceNewHandler = (request: { chatId: string }) => Promise<void> | void;

export interface ItsaplanWebhookServerOptions {
  /** Giới hạn body mỗi request. Mặc định 1 MB. */
  maxBodyBytes?: number;
  /**
   * Secret ký webhook của Itsaplan (mỗi subscription một `whsec_…`). Có thì bắt
   * buộc header `X-Itsaplan-Signature` hợp lệ; rỗng thì nhận như cũ (cảnh báo).
   */
  itsaplanSecrets?: string[];
  /** `secret_token` đã khai khi setWebhook Telegram. Rỗng thì nhận như cũ. */
  telegramSecret?: string;
  /** Độ lệch tối đa của `t=` trong chữ ký. Mặc định 5 phút. */
  signatureToleranceSec?: number;
  /** Durable dedupe store. Mặc định in-memory bounded (một process). */
  dedupeStore?: WebhookDedupeStore;
  /**
   * Địa chỉ server BIND. Mặc định `"127.0.0.1"` (chỉ máy này — an toàn khi có reverse proxy cục bộ).
   * Itsaplan chạy ở máy khác trong LAN thì đặt `"0.0.0.0"` (hoặc IP LAN) để nhận thẳng, khỏi dựng proxy
   * chuyển tiếp. Mở ra ngoài loopback thì BẮT BUỘC đặt `itsaplanSecrets` (chữ ký) — server cảnh báo nếu
   * không có. Các endpoint `/internal/*` vẫn chỉ nhận từ loopback bất kể địa chỉ bind.
   */
  listenHost?: string;
}

/** Địa chỉ bind mặc định của server webhook. */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

/** Endpoint nội bộ chỉ nhận từ chính máy này. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export class ItsaplanWebhookServer {
  private server: http.Server | null = null;
  private handlers: WebhookEventHandler[] = [];
  private telegramHandlers: TelegramUpdateHandler[] = [];
  private reporterOkHandler: ReporterOkHandler | null = null;
  private reporterReplyHandler: ReporterReplyHandler | null = null;
  private forceNewHandler: ForceNewHandler | null = null;
  private readonly maxBodyBytes: number;
  private readonly itsaplanSecrets: string[];
  private readonly telegramSecret: string;
  private readonly signatureToleranceSec: number;
  private readonly dedupe: WebhookDedupeStore;
  private readonly listenHost: string;

  constructor(options: ItsaplanWebhookServerOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.itsaplanSecrets = (options.itsaplanSecrets ?? []).map((x) => x.trim()).filter(Boolean);
    this.telegramSecret = (options.telegramSecret ?? "").trim();
    this.signatureToleranceSec = options.signatureToleranceSec ?? DEFAULT_SIGNATURE_TOLERANCE_SEC;
    this.dedupe = options.dedupeStore ?? new MemoryWebhookDedupeStore();
    this.listenHost = (options.listenHost ?? "").trim() || DEFAULT_LISTEN_HOST;
  }

  /** Địa chỉ đang bind (hữu ích cho test/log). `null` khi chưa start. */
  host(): string | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.address : null;
  }

  onEvent(handler: WebhookEventHandler): void {
    this.handlers.push(handler);
  }
  onTelegramUpdate(handler: TelegramUpdateHandler): void {
    this.telegramHandlers.push(handler);
  }
  onReporterOk(handler: ReporterOkHandler): void {
    this.reporterOkHandler = handler;
  }
  onReporterReply(handler: ReporterReplyHandler): void {
    this.reporterReplyHandler = handler;
  }
  onForceNew(handler: ForceNewHandler): void {
    this.forceNewHandler = handler;
  }

  /** Cổng thật đang nghe (hữu ích khi start(0) trong test). */
  port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  /**
   * Đọc body có giới hạn. Vượt giới hạn trả 413 ngay và bỏ phần còn lại — không
   * gom vô hạn vào RAM. Trả `null` khi đã tự trả lời lỗi.
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

  private async handleInternal(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    present: boolean,
    run: (payload: any) => Promise<void>,
  ): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress)) {
      req.resume();
      this.reply(res, 403, { error: "Forbidden" });
      return;
    }
    if (!present) {
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
    await run(payload);
  }

  async start(port: number): Promise<void> {
    if (this.server) return;
    if (this.listenHost !== DEFAULT_LISTEN_HOST && this.itsaplanSecrets.length === 0) {
      getLogger().warn(
        `[ItsaplanWebhookServer] Bind ${this.listenHost} (ngoài loopback) mà chưa có itsaplanSecrets — ai trong mạng cũng gửi được webhook giả.`,
      );
    }
    if (this.itsaplanSecrets.length === 0) {
      getLogger().warn(
        "[ItsaplanWebhookServer] Chưa cấu hình ITSAPLAN_WEBHOOK_SECRET — /webhook nhận request KHÔNG kiểm chữ ký.",
      );
    }
    if (!this.telegramSecret) {
      getLogger().warn(
        "[ItsaplanWebhookServer] Chưa cấu hình TELEGRAM_WEBHOOK_SECRET — /telegram-webhook nhận request KHÔNG kiểm secret_token.",
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

        if (pathname === "/internal/reporter-ok" || pathname === "/internal/confirm-done") {
          await this.handleInternal(req, res, !!this.reporterOkHandler, async (payload) => {
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
              this.reply(res, 200, await this.reporterOkHandler!({ issueId, chatId, userName }));
            } catch (err: any) {
              getLogger().error(
                `[ItsaplanWebhookServer] reporter-ok #${issueId} lỗi: ${err.message}`,
              );
              this.reply(res, 200, { outcome: "error" });
            }
          });
          return;
        }

        if (pathname === "/internal/reporter-reply") {
          await this.handleInternal(req, res, !!this.reporterReplyHandler, async (payload) => {
            const chatId =
              payload?.chatId === undefined || payload?.chatId === null
                ? ""
                : String(payload.chatId);
            const rawMessageId = payload?.replyToMessageId;
            const messageId =
              rawMessageId === undefined || rawMessageId === null
                ? ""
                : String(rawMessageId).trim();
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
                await this.reporterReplyHandler!({ chatId, messageId, text, userName }),
              );
            } catch (err: any) {
              getLogger().error(`[ItsaplanWebhookServer] reporter-reply lỗi: ${err.message}`);
              this.reply(res, 200, { handled: true });
            }
          });
          return;
        }

        if (pathname === "/internal/force-new") {
          await this.handleInternal(req, res, !!this.forceNewHandler, async (payload) => {
            const chatId =
              payload?.chatId === undefined || payload?.chatId === null
                ? ""
                : String(payload.chatId).trim();
            if (!chatId) {
              this.reply(res, 400, { error: "Thiếu chatId" });
              return;
            }
            try {
              await this.forceNewHandler!({ chatId });
              this.reply(res, 200, { ok: true });
            } catch (err: any) {
              getLogger().error(
                `[ItsaplanWebhookServer] force-new (${chatId}) lỗi: ${err.message}`,
              );
              this.reply(res, 200, { ok: false });
            }
          });
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
              "[ItsaplanWebhookServer] Từ chối /webhook: chữ ký X-Itsaplan-Signature thiếu hoặc sai.",
            );
            this.reply(res, 401, { error: "Invalid signature" });
            return;
          }
        }

        const parsed = parseWebhookEnvelope(body);
        if (!parsed.ok) {
          getLogger().error(
            `[ItsaplanWebhookServer] Failed to parse webhook body: ${parsed.error}`,
          );
          this.reply(res, 400, { error: "Invalid JSON" });
          return;
        }
        const envelope = parsed.envelope;

        const key = webhookDedupeKey(envelope);
        if (key && !this.dedupe.claim(key)) {
          this.reply(res, 200, { ok: true, duplicate: true });
          return;
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
      this.server.listen(port, this.listenHost, () => resolve());
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
      (this.server as any)?.closeAllConnections?.();
    });
  }
}
