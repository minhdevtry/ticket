import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import type { TicketClosure } from "./ticket-closure";
import { REPORTER_OK_CALLBACK } from "./notifier";
import type { TicketBindingRepository } from "../lib/storage/binding-repository";
import { getLogger } from "@vuihoc/bot-core/core";
import { markBotComment } from "@vuihoc/bot-core/core";
import { escapeItsaplanMarkdown } from "../lib/html-entities";
import { classifyColumn } from "@vuihoc/bot-core/itsaplan";
import {
  closedTicketRefusalMessage,
  resolveSupplementMentionTarget,
} from "../lib/itsaplan/supplement-notifier";
import { TelegramTransport } from "../lib/telegram/transport";
import { identifierInProject, projectOfIdentifier } from "@vuihoc/bot-core/itsaplan";
import { isTieuLinhProject } from "./project-lock";

export interface TelegramHandlerOptions {
  itsaplan: ItsaplanClient;
  /** Ghi "phản hồi đã ổn" khi người báo bấm nút (không đóng ticket — ADR-0006). */
  closure?: Pick<TicketClosure, "recordReporterOk">;
  bindings: TicketBindingRepository;
  botToken?: string;
  /**
   * Mã dự án worker phụ trách. Hai worker dùng chung DB binding/route, nên
   * reply trỏ vào ticket dự án khác thì bỏ qua — không ghi hộ bot kia.
   */
  projectKey?: string;
}

export class TelegramWebhookHandler {
  /** Chỉ có khi cấu hình được token — thiếu token thì mọi lời gọi ra Telegram bỏ qua. */
  private readonly transport?: TelegramTransport;

  constructor(private readonly options: TelegramHandlerOptions) {
    this.transport = options.botToken
      ? new TelegramTransport({ botToken: options.botToken, timeoutMs: 10_000 })
      : undefined;
  }

  /** Trả `result` của Telegram, hoặc `null` khi thiếu token / gọi hỏng. */
  private async callApi(method: string, payload: Record<string, unknown>): Promise<any> {
    if (!this.transport) return null;
    return this.transport.tryCall<any>(method, payload);
  }

  async handleUpdate(update: any): Promise<void> {
    if (!update || typeof update !== "object") return;

    // 1. Nút "👍 Đã ổn" (reporter_ok:<id>; nút cũ confirm_done:<id> hiểu như nhau).
    // Chỉ ghi ý kiến người báo — ticket vẫn ở Resolved chờ chuyên viên.
    if (update.callback_query) {
      const cb = update.callback_query;
      const match = String(cb.data || "").match(REPORTER_OK_CALLBACK);

      if (match && this.options.closure) {
        const chatId = cb.message?.chat?.id;
        const userName = cb.from?.first_name || cb.from?.username || "Người báo";
        // Lỗi (vd addComment hỏng) vẫn phải trả lời — không thì nút quay mãi.
        const result = await this.options.closure
          .recordReporterOk({ issueId: Number(match[1]), chatId: chatId ?? "", userName })
          .catch((err: any) => {
            getLogger().error(
              `[TelegramWebhookHandler] Ghi phản hồi đã ổn #${match[1]} lỗi: ${err.message}`,
            );
            return {
              outcome: "error" as const,
              replyText: "Dạ em chưa ghi nhận được, anh/chị bấm lại giúp em sau ít phút nhé.",
            };
          });

        // Dừng vòng quay của nút; câu trả lời đi một lần, bằng tin nhắn.
        await this.callApi("answerCallbackQuery", { callback_query_id: cb.id });
        if (chatId) {
          if (
            (result.outcome === "recorded" || result.outcome === "already_recorded") &&
            cb.message?.message_id
          ) {
            await this.callApi("editMessageReplyMarkup", {
              chat_id: chatId,
              message_id: cb.message.message_id,
              reply_markup: { inline_keyboard: [] },
            });
          }
          await this.callApi("sendMessage", { chat_id: chatId, text: result.replyText });
        }
        return;
      }
    }

    // 2. Xử lý tin nhắn người dùng Reply vào thông báo của bot
    if (update.message?.reply_to_message) {
      const msg = update.message;
      const replyToId = msg.reply_to_message.message_id;
      let route = this.options.bindings.getMessageRoute(replyToId, "telegram", msg.chat?.id);
      if (route && !identifierInProject(route.identifier, this.options.projectKey)) {
        getLogger().info(
          `[TelegramWebhookHandler] Reply trỏ vào ${route.identifier} không thuộc dự án ${this.options.projectKey}, bỏ qua.`,
        );
        route = null;
      }

      if (route) {
        const isTieuLinh = isTieuLinhProject(route.identifier, this.options.projectKey);
        const targetProject =
          projectOfIdentifier(route.identifier) ?? this.options.projectKey ?? "TECH";

        // W29-NOTIFY (06/10/2026): Kiểm tra ticket đã đóng chưa (chỉ cho Tiểu Linh/TECH; Iris/PO giữ nguyên)
        if (isTieuLinh) {
          const issue =
            typeof this.options.itsaplan.getIssue === "function"
              ? await this.options.itsaplan.getIssue(route.issueId).catch(() => null)
              : null;
          if (issue) {
            const columns =
              typeof this.options.itsaplan.listProjectColumns === "function"
                ? await this.options.itsaplan.listProjectColumns(targetProject).catch(() => [])
                : [];
            const col = columns.find((c) => c.id === issue.columnId);
            const state = col
              ? classifyColumn(col)
              : issue.stateType === "completed"
                ? "done"
                : issue.stateType === "canceled"
                  ? "canceled"
                  : "open";
            if (state === "done" || state === "canceled") {
              if (msg.chat?.id) {
                await this.callApi("sendMessage", {
                  chat_id: msg.chat.id,
                  reply_to_message_id: msg.message_id,
                  text: closedTicketRefusalMessage(route.identifier),
                });
              }
              return;
            }
          }
        }

        const userName = msg.from?.first_name || msg.from?.username || "Người dùng Telegram";
        let mentionSuffix = "";
        if (isTieuLinh) {
          const issue =
            typeof this.options.itsaplan.getIssue === "function"
              ? await this.options.itsaplan.getIssue(route.issueId).catch(() => null)
              : null;
          if (issue) {
            try {
              const mention = await resolveSupplementMentionTarget({
                client: this.options.itsaplan,
                projectKey: targetProject,
                issue,
                reporterNames: [userName, msg.from?.username],
              });
              const cleanUser = mention?.username?.trim().replace(/^@+/, "");
              if (cleanUser) {
                mentionSuffix = ` (cc @${cleanUser})`;
              }
            } catch {}
          }
        }

        if (msg.text) {
          const header = mentionSuffix
            ? `**${userName} (Telegram)**${mentionSuffix}:`
            : `**${userName} (Telegram):**`;
          const commentBody = `${header}\n${escapeItsaplanMarkdown(msg.text)}`;
          await this.options.itsaplan
            .addComment(route.issueId, markBotComment(commentBody))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              getLogger().error(
                `[TelegramWebhookHandler] Lỗi addComment cho #${route.issueId}: ${message}`,
              );
            });

          if (msg.chat?.id) {
            await this.callApi("sendMessage", {
              chat_id: msg.chat.id,
              reply_to_message_id: msg.message_id,
              text: `Đã thêm trao đổi của anh/chị vào ticket **${route.identifier}** rồi nhé ạ.`,
              parse_mode: "Markdown",
            });
          }
          return;
        }

        const maxFileSize = 20 * 1024 * 1024; // 20MB limit của Telegram getFile
        let fileId: string | null = null;
        let mimeType: string = "application/octet-stream";
        let defaultExt = ".bin";
        let mediaType: "photo" | "video" | "document" = "document";
        let incomingFileSize: number | undefined;

        if (msg.photo && msg.photo.length > 0) {
          const largest = msg.photo[msg.photo.length - 1];
          fileId = largest.file_id;
          mimeType = "image/jpeg";
          defaultExt = ".jpg";
          mediaType = "photo";
          incomingFileSize = largest.file_size;
        } else if (msg.video) {
          fileId = msg.video.file_id;
          mimeType = msg.video.mime_type || "video/mp4";
          defaultExt = ".mp4";
          mediaType = "video";
          incomingFileSize = msg.video.file_size;
        } else if (msg.animation) {
          fileId = msg.animation.file_id;
          mimeType = msg.animation.mime_type || "video/mp4";
          defaultExt = ".mp4";
          mediaType = "video";
          incomingFileSize = msg.animation.file_size;
        } else if (msg.document) {
          fileId = msg.document.file_id;
          mimeType = msg.document.mime_type || "application/octet-stream";
          incomingFileSize = msg.document.file_size;
          if (mimeType.startsWith("video/")) {
            mediaType = "video";
            defaultExt = ".mp4";
          } else if (mimeType.startsWith("image/")) {
            mediaType = "photo";
            defaultExt = ".png";
          } else {
            mediaType = "document";
            defaultExt = msg.document.file_name ? "" : ".bin";
          }
        }

        if (fileId) {
          if (incomingFileSize && incomingFileSize > maxFileSize) {
            if (msg.chat?.id) {
              const sizeMb = (incomingFileSize / (1024 * 1024)).toFixed(1);
              await this.callApi("sendMessage", {
                chat_id: msg.chat.id,
                reply_to_message_id: msg.message_id,
                text: `Dung lượng tệp (${sizeMb}MB) vượt quá giới hạn 20MB của Telegram Bot. Anh/chị vui lòng tải file ngắn hơn hoặc nén lại giúp em nhé ạ.`,
                parse_mode: "Markdown",
              });
            }
            return;
          }

          try {
            const fileRes = await this.callApi("getFile", { file_id: fileId });
            const filePath = fileRes?.file_path;
            if (filePath && this.transport) {
              const buffer = await this.transport.downloadFile(filePath);
              const customName = msg.document?.file_name || `telegram_${Date.now()}${defaultExt}`;
              const uploadRes = await this.options.itsaplan.uploadAttachment(
                route.issueId,
                customName,
                buffer,
                mimeType,
              );
              const captionText = msg.caption ? `${msg.caption}\n\n` : "";

              let embedMarkdown = "";
              if (mediaType === "video") {
                embedMarkdown = `<video src="${uploadRes.url}" controls></video>`;
              } else if (mediaType === "photo") {
                embedMarkdown = `![${uploadRes.filename}](${uploadRes.url})`;
              } else {
                embedMarkdown = `[${uploadRes.filename}](${uploadRes.url})`;
              }

              const typeLabel =
                mediaType === "video" ? "video" : mediaType === "photo" ? "ảnh" : "tệp đính kèm";
              const header = mentionSuffix
                ? `**${userName} (Telegram đính kèm ${typeLabel})**${mentionSuffix}:`
                : `**${userName} (Telegram đính kèm ${typeLabel}):**`;
              const commentBody = `${header}\n${captionText}${embedMarkdown}`;

              await this.options.itsaplan
                .addComment(route.issueId, markBotComment(commentBody))
                .catch(() => {});

              if (msg.chat?.id) {
                await this.callApi("sendMessage", {
                  chat_id: msg.chat.id,
                  reply_to_message_id: msg.message_id,
                  text: `Đã đính kèm ${typeLabel} mới vào ticket **${route.identifier}** trên Itsaplan rồi nhé ạ.`,
                  parse_mode: "Markdown",
                });
              }
              return;
            }
          } catch (err: any) {
            getLogger().error(
              `[TelegramWebhookHandler] Lỗi upload ${mediaType} reply cho #${route.issueId}: ${err.message}`,
            );
            if (msg.chat?.id) {
              await this.callApi("sendMessage", {
                chat_id: msg.chat.id,
                reply_to_message_id: msg.message_id,
                text: `Không thể tải tệp lên Itsaplan (${err.message}). Anh/chị vui lòng kiểm tra lại tệp nhé ạ.`,
                parse_mode: "Markdown",
              });
            }
          }
        }
      }
    }
  }
}
