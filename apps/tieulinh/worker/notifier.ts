/**
 * Cổng gửi tin ra kênh chat.
 *
 * Trước đây worker gọi thẳng vào adapter Telegram của framework agent, nên
 * muốn chạy nền là phải kéo cả cái bot theo. Cổng này chỉ khai đúng bốn việc
 * worker thật sự cần, và bản Telegram bên dưới gọi Bot API trần — không
 * framework, không thư viện.
 */
import type { TicketBinding } from "../lib/storage/binding-repository";
import { getLogger } from "../lib/logger";
import { TelegramTransport } from "../lib/telegram/transport";
import { stripBotMentions } from "../lib/formatting";
import type { TicketState } from "../lib/itsaplan/ticket-state";

/**
 * Tiền tố callback của nút "👍 Đã ổn". Nút cũ gửi trước 24/09 dùng `confirm_done:`
 * — vẫn phải hiểu là phản hồi đã ổn (spec Q13).
 */
export const REPORTER_OK_PREFIX = "reporter_ok:";
export const REPORTER_OK_CALLBACK = /^(?:reporter_ok|confirm_done):(\d+)$/;

/** Telegram báo không đọc được định dạng (Markdown dở dang) — gửi lại không định dạng thì được. */
export function isEntityParseError(err: unknown): boolean {
  return /can'?t parse entities/i.test(String((err as any)?.message ?? err));
}

/** Bỏ dấu in đậm `**` mình tự thêm; phần còn lại giữ nguyên chữ người viết. */
export function plainText(s: string): string {
  return s.replace(/\*\*/g, "");
}

export interface Notifier {
  readonly channelType: string;
  /** Chuyển bình luận của kỹ thuật viên về cho người báo. */
  notifyComment(
    binding: TicketBinding,
    authorName: string,
    text: string,
    images?: string[],
    videos?: string[],
  ): Promise<string | number | void>;
  /**
   * Báo người báo biết ticket đổi trạng thái. `label` là tên hiển thị của cột;
   * `state` quyết định câu chữ và nút: đã xử lý kèm nút "Đã ổn" (chỉ ghi ý kiến,
   * không đóng ticket — ADR-0006), hoàn tất thì không kèm nút.
   */
  notifyStateChange(
    binding: TicketBinding,
    label: string,
    state: TicketState,
    /** `true`: `label` đã là câu giải thích hoàn chỉnh của dự án (vd PO) — báo đúng "X chuyển sang: label", không dùng lời "đã hoàn tất"/"đã xử lý". */
    exact?: boolean,
  ): Promise<string | number | void>;
  /** Gỡ nút bấm khỏi một tin đã gửi. */
  clearInteractiveButtons?(binding: TicketBinding, messageId: string): Promise<void>;
  /** Phát cảnh báo tới kênh trực ca. */
  broadcastAlert(text: string): Promise<void>;
}

export interface TelegramNotifierOptions {
  botToken: string;
  /** Kênh nhận cảnh báo trực ca. */
  onCallChatId?: string;
  /** Base URL API nội bộ (ví dụ: http://127.0.0.1:3100) để tải file nhanh qua loopback */
  itsaplanLocalBaseUrl?: string;
}

export class TelegramNotifier implements Notifier {
  readonly channelType = "telegram";
  private readonly transport: TelegramTransport;

  constructor(private readonly options: TelegramNotifierOptions) {
    this.transport = new TelegramTransport({ botToken: options.botToken });
  }

  /**
   * Gọi Bot API. Tin để Markdown mà Telegram không đọc nổi (tên như `PO_UserA`, `@PRO_UserB` có
   * dấu `_` thành chữ nghiêng dở dang) thì gửi lại dạng văn bản thuần thay vì mất tin — 30/09–01/10
   * mấy tin kỹ thuật trao đổi không tới người báo vì lỗi này.
   */
  private async api(method: string, payload: Record<string, unknown>): Promise<any> {
    try {
      return await this.transport.call<any>(method, payload);
    } catch (err: any) {
      if (!payload.parse_mode || !isEntityParseError(err)) throw err;
      getLogger().warn(
        `[notifier] ${method}: Telegram không đọc được định dạng Markdown, gửi lại dạng văn bản thuần.`,
      );
      const { parse_mode: _drop, ...rest } = payload;
      for (const key of ["text", "caption"] as const) {
        if (typeof rest[key] === "string") rest[key] = plainText(rest[key] as string);
      }
      return this.transport.call<any>(method, rest);
    }
  }

  private async fetchMediaBuffer(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
    try {
      let targetUrl = url;
      if (this.options.itsaplanLocalBaseUrl && targetUrl.includes("/attachments/")) {
        const pathPart = targetUrl.substring(targetUrl.indexOf("/attachments/"));
        targetUrl = `${this.options.itsaplanLocalBaseUrl.replace(/\/+$/, "")}${pathPart}`;
      }
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const buffer = Buffer.from(await res.arrayBuffer());
      const filename = url.split("/").pop()?.split("?")[0] || "media";
      return { buffer, contentType, filename };
    } catch (err: any) {
      getLogger().warn(`[notifier] Không thể tải buffer media từ ${url}: ${err.message}`);
      return null;
    }
  }

  private async sendMedia(
    chatId: string,
    type: "photo" | "video",
    url: string,
    caption?: string,
  ): Promise<any> {
    // 1. Thử tải buffer cục bộ để gửi multipart (hỗ trợ tối đa 50MB, không phụ thuộc URL public)
    const mediaData = await this.fetchMediaBuffer(url);
    if (mediaData) {
      const fd = new FormData();
      fd.append("chat_id", chatId);
      const ext = type === "photo" ? ".jpg" : ".mp4";
      const blob = new Blob([mediaData.buffer], { type: mediaData.contentType });
      fd.append(type, blob, `attachment${ext}`);
      if (caption) {
        fd.append("caption", caption);
        fd.append("parse_mode", "Markdown");
      }
      try {
        return await this.transport.sendFormData(type === "photo" ? "sendPhoto" : "sendVideo", fd);
      } catch (err: any) {
        if (caption && isEntityParseError(err)) {
          // Chú thích Markdown hỏng: gửi lại chính tệp đó với chú thích văn bản thuần.
          const plain = new FormData();
          plain.append("chat_id", chatId);
          plain.append(type, blob, `attachment${ext}`);
          plain.append("caption", plainText(caption));
          try {
            return await this.transport.sendFormData(
              type === "photo" ? "sendPhoto" : "sendVideo",
              plain,
            );
          } catch (err2: any) {
            err = err2;
          }
        }
        getLogger().warn(
          `[notifier] Gửi multipart ${type} thất bại: ${err.message}, thử gửi theo URL...`,
        );
      }
    }

    // 2. Fallback gửi theo URL nếu không phải localhost
    if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        [type]: url,
      };
      if (caption) {
        payload.caption = caption;
        payload.parse_mode = "Markdown";
      }
      return await this.api(type === "photo" ? "sendPhoto" : "sendVideo", payload);
    }

    throw new Error(`Không thể gửi ${type} vì không thể lấy dữ liệu tệp từ ${url}`);
  }

  async notifyComment(
    binding: TicketBinding,
    authorName: string,
    text: string,
    images: string[] = [],
    videos: string[] = [],
  ): Promise<string | number | void> {
    const rawChatId = String(binding.chatId).replace(/^telegram:/i, "");
    const cleanText = stripBotMentions(text);
    const totalMedia = images.length + videos.length;

    if (!cleanText && totalMedia === 0) {
      return;
    }

    // Trường hợp 1: Có đúng 1 media (1 ảnh hoặc 1 video) ➔ gom caption gửi 1 tin duy nhất
    if (totalMedia === 1) {
      const captionHead = cleanText
        ? `**${authorName}** vừa trao đổi về ${binding.identifier}:\n${cleanText}`
        : `**${authorName}** vừa đính kèm tệp vào ${binding.identifier}`;

      if (images.length === 1) {
        try {
          const res = await this.sendMedia(rawChatId, "photo", images[0], captionHead);
          return res?.message_id;
        } catch (err: any) {
          getLogger().warn(
            `[notifier] Gửi ảnh kèm caption thất bại: ${err?.message}, thử gửi text trước...`,
          );
        }
      } else if (videos.length === 1) {
        try {
          const res = await this.sendMedia(rawChatId, "video", videos[0], captionHead);
          return res?.message_id;
        } catch (err: any) {
          getLogger().warn(
            `[notifier] Gửi video kèm caption thất bại: ${err?.message}, thử gửi text trước...`,
          );
        }
      }
    }

    // Trường hợp 2: Có nhiều media hoặc gửi đơn thất bại ➔ gửi tin text trước
    let firstMessageId: string | number | undefined;
    const head = cleanText
      ? `**${authorName}** vừa trao đổi về ${binding.identifier}:\n${cleanText}`
      : `**${authorName}** vừa đính kèm tệp vào ${binding.identifier}`;

    const sent = await this.api("sendMessage", {
      chat_id: rawChatId,
      text: head,
      parse_mode: "Markdown",
    }).catch((err) => {
      getLogger().warn(`[notifier] Không gửi được sendMessage:`, err);
      return null;
    });

    if (sent?.message_id) {
      firstMessageId = sent.message_id;
    }

    for (const url of images) {
      await this.sendMedia(rawChatId, "photo", url).catch((err) =>
        getLogger().warn(`[notifier] Không gửi được ảnh:`, err),
      );
    }
    for (const url of videos) {
      await this.sendMedia(rawChatId, "video", url).catch((err) =>
        getLogger().warn(`[notifier] Không gửi được video:`, err),
      );
    }
    return firstMessageId;
  }

  async notifyStateChange(
    binding: TicketBinding,
    label: string,
    state: TicketState,
    exact = false,
  ): Promise<string | number | void> {
    const rawChatId = String(binding.chatId).replace(/^telegram:/i, "");
    const text = exact
      ? `${binding.identifier} chuyển sang: **${label}**`
      : state === "resolved"
        ? `Ticket ${binding.identifier} đã được xử lý. Anh/chị kiểm tra giúp em; nếu ổn thì bấm nút dưới đây, còn chưa ổn thì cứ nhắn lại vào tin này ạ.`
        : state === "done"
          ? `Ticket ${binding.identifier} đã hoàn tất.`
          : `${binding.identifier} chuyển sang: **${label}**`;

    // Nút là JSON trong lời gọi API, không cần thư viện nào.
    const sent = await this.api("sendMessage", {
      chat_id: rawChatId,
      text,
      parse_mode: "Markdown",
      ...(state === "resolved"
        ? {
            reply_markup: {
              inline_keyboard: [
                [{ text: "👍 Đã ổn", callback_data: `${REPORTER_OK_PREFIX}${binding.issueId}` }],
              ],
            },
          }
        : {}),
    });
    return sent?.message_id;
  }

  async clearInteractiveButtons(binding: TicketBinding, messageId: string): Promise<void> {
    const rawChatId = String(binding.chatId).replace(/^telegram:/i, "");
    await this.api("editMessageReplyMarkup", {
      chat_id: rawChatId,
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  async broadcastAlert(text: string): Promise<void> {
    if (!this.options.onCallChatId) {
      getLogger().warn(`[notifier] Chưa cấu hình kênh trực ca, bỏ qua cảnh báo.`);
      return;
    }
    await this.api("sendMessage", {
      chat_id: this.options.onCallChatId,
      text,
      parse_mode: "Markdown",
    });
  }
}
