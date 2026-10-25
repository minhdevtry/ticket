/**
 * Tin của NGƯỜI BÁO từ Telegram tới bot hậu cần: nút "👍 Đã ổn" và trả lời tự do vào tin thông báo.
 * Cắm vào `defineBot({ backoffice: { inbound } })`, cùng server webhook của bot kit:
 *
 *  - `reporterOk` / `reporterReply`: hai đường `/internal/*` (chỉ loopback) mà plugin trên cùng máy
 *    gọi (bot chạy qua OpenClaw polling không nhận `callback_query`), như bản legacy;
 *  - `telegramUpdate`: `update` thô của Bot API ở `/telegram-webhook` (chế độ webhook): bấm nút
 *    (`callback_query`) hoặc trả lời một tin (`reply_to_message`); bot tự nói lại với người báo.
 *
 * Luật (ADR-0006): cả hai chỉ GHI COMMENT cho người xử lý; không đổi cột, không đóng, không mở lại.
 * Lỗi khi ghi vẫn được trả lời (nút không quay mãi). Chữ nghĩa tiêm qua `TicketClosure` và `errorCopy`.
 *
 * NGUỒN: intake `worker/telegram-handler.ts` + `worker/webhook-server.ts` (reporter-ok/-reply).
 */
import type {
  InboundContext,
  ReporterOkRequest,
  ReporterOkResult,
  ReporterReplyRequest,
  ReporterReplyResult,
  TicketClosure,
} from "../backoffice";
import type { TelegramTransport } from "./transport";

/** Nút "Đã ổn" cũ (`confirm_done:`) gửi trước 24/09 của bản legacy hiểu như nhau. */
export const DEFAULT_REPORTER_OK_PREFIXES = ["reporter_ok:", "confirm_done:"] as const;

export interface ReporterInboundOptions {
  closure: Pick<TicketClosure, "recordReporterOk" | "recordReporterReply">;
  /** Để bot nói lại với người báo ở chế độ webhook. Không có thì chỉ ghi comment, không nói lại. */
  transport?: Pick<TelegramTransport, "tryCall">;
  /** Tiền tố `callback_data` của nút "Đã ổn". */
  callbackPrefixes?: readonly string[];
  /** Câu nói khi ghi comment thất bại (nút vẫn phải được trả lời). */
  errorCopy: { ok: string; reply: string };
}

/** Phần của `InboundContext` mà các handler vào cần. */
export type ReporterInboundContext = Pick<InboundContext, "tracker" | "logger">;
/** Kết quả khi ghi "Đã ổn" thất bại: vẫn có câu để trả lời người bấm. */
export type ReporterOkError = { outcome: "error"; replyText: string };

const obj = (v: unknown): Record<string, any> =>
  v && typeof v === "object" ? (v as Record<string, any>) : {};

const displayName = (from: Record<string, any>): string =>
  String(from.first_name || from.username || "").trim() || "Người báo";

export function createReporterInbound(options: ReporterInboundOptions) {
  const prefixes = options.callbackPrefixes ?? DEFAULT_REPORTER_OK_PREFIXES;

  async function reporterOk(
    ctx: ReporterInboundContext,
    req: ReporterOkRequest,
  ): Promise<ReporterOkResult | ReporterOkError> {
    try {
      return await options.closure.recordReporterOk(ctx.tracker, req);
    } catch (err) {
      ctx.logger.error(
        `[reporter-inbound] ghi "Đã ổn" #${req.issueId} lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { outcome: "error", replyText: options.errorCopy.ok };
    }
  }

  async function reporterReply(
    ctx: ReporterInboundContext,
    req: ReporterReplyRequest,
  ): Promise<ReporterReplyResult> {
    try {
      return await options.closure.recordReporterReply(ctx.tracker, req);
    } catch (err) {
      ctx.logger.error(
        `[reporter-inbound] ghi trả lời của người báo lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { handled: true, outcome: "error", replyText: options.errorCopy.reply };
    }
  }

  async function telegramUpdate(ctx: ReporterInboundContext, update: unknown): Promise<void> {
    const tg = options.transport;
    const u = obj(update);

    // 1) nút "Đã ổn"
    const cb = obj(u.callback_query);
    const data = typeof cb.data === "string" ? cb.data : "";
    const prefix = prefixes.find((p) => data.startsWith(p));
    if (prefix) {
      const issueId = Number(data.slice(prefix.length));
      const chatId = cb.message?.chat?.id;
      if (!Number.isInteger(issueId) || issueId <= 0 || chatId === undefined || chatId === null) {
        await tg?.tryCall("answerCallbackQuery", { callback_query_id: cb.id });
        return;
      }
      const result = await reporterOk(ctx, {
        issueId,
        chatId: String(chatId),
        userName: displayName(obj(cb.from)),
      });
      // Dừng vòng quay của nút; câu trả lời đi một lần, bằng tin nhắn.
      await tg?.tryCall("answerCallbackQuery", { callback_query_id: cb.id });
      const answered = result.outcome === "recorded" || result.outcome === "already_recorded";
      if (answered && cb.message?.message_id) {
        await tg?.tryCall("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      }
      await tg?.tryCall("sendMessage", { chat_id: chatId, text: result.replyText });
      return;
    }

    // 2) trả lời tự do vào tin thông báo
    const msg = obj(u.message);
    const repliedTo = obj(msg.reply_to_message).message_id;
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    const chatId = obj(msg.chat).id;
    if (repliedTo === undefined || !text || text.startsWith("/") || chatId === undefined) return;
    if (obj(msg.from).is_bot) return;
    const result = await reporterReply(ctx, {
      chatId: String(chatId),
      messageId: String(repliedTo),
      text,
      userName: displayName(obj(msg.from)),
    });
    if (result.handled) {
      await tg?.tryCall("sendMessage", {
        chat_id: chatId,
        text: result.replyText,
        reply_to_message_id: msg.message_id,
      });
    }
  }

  return { reporterOk, reporterReply, telegramUpdate };
}
