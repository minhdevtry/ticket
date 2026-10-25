/**
 * `TelegramNotifyChannel` — hiện thực `ChannelPort` của notify (ticket 14) cho
 * Telegram. Đây là mắt xích mà `NotificationDispatcher` cắm vào để đẩy comment /
 * đổi-trạng-thái về chat người báo, và là thứ mỗi bot TRƯỚC ĐÂY phải tự ghép tay
 * (đúng chỗ worker OP đã phải tự chế lớp nối notify ↔ Telegram, 16/10).
 *
 * `src/telegram/adapter.ts` đã có `TelegramChannelSender` cho ENGINE (gửi một
 * `ChannelMessage` khi hội thoại), nhưng engine-sender KHÁC notify-channel:
 *   - engine gửi text + nút chung chung;
 *   - notify cần hai hành vi riêng: `sendComment` (có kèm ảnh) và
 *     `sendStateChange` (có thể kèm nút "Đã ổn" khi resolved — ADR-0006), cộng
 *     `clearInteractiveButtons`.
 * Nên đây là một lớp riêng, không nhồi vào engine-sender.
 *
 * Channel-free / copy-free đúng tinh thần lib: text đã do dispatcher dựng sẵn
 * (`StateChangeCopyMap` cho state, comment là lời người xử lý). Nhãn nút "Đã ổn"
 * và payload callback do nơi gọi TIÊM vào — không literal tiếng Việt trong logic.
 */
import type { ChannelPort, NotifyBinding, TicketLifecycleState } from "../intake/ports";
import { getLogger } from "../core/logger";
import { sendMessage, type ParseMode, type TelegramButton } from "./send";
import type { TelegramTransport } from "./transport";

export interface ReporterOkButtonSpec {
  /** Nhãn hiển thị trên nút, vd "👍 Đã ổn". Nơi gọi truyền — không literal ở đây. */
  label: string;
  /**
   * Dựng `callback_data` cho nút từ issueId. Payload máy ("reporter_ok:481"),
   * do nơi gọi quy ước. Trả chuỗi rỗng ⇒ bỏ nút (an toàn khi vượt 64 byte sẽ bị
   * `sendMessage` tự lọc, nhưng cho nơi gọi tự quyết trước).
   */
  callbackData: (issueId: number) => string;
}

export interface TelegramNotifyChannelOptions {
  transport: TelegramTransport;
  /** Loại kênh — khớp `binding.channelType` dispatcher dùng để chọn port. Mặc định "telegram". */
  channelType?: string;
  /** Parse mode cho text gửi đi. Mặc định không đặt (text đã an toàn plain). */
  parseMode?: ParseMode;
  /** Forum/topic thread id, nếu chat dùng topic. */
  messageThreadId?: number;
  /**
   * Nút "Đã ổn" gắn kèm tin resolved (ADR-0006: nút chỉ GHI COMMENT, không đổi
   * trạng thái). Không truyền ⇒ tin resolved gửi không nút (vẫn báo, chỉ thiếu
   * nút bấm) và ghi một cảnh báo một lần, vì đây thường là cấu hình thiếu.
   */
  reporterOkButton?: ReporterOkButtonSpec;
  /** Báo khi một nút bị bỏ (route tới Alerter). */
  onButtonDrop?: (reason: string) => void;
  /**
   * Chat trực ca nhận `sendAlert` (vd SLA quá hạn). Không đặt thì `sendAlert` chỉ ghi cảnh báo
   * vào log (không ném: cảnh báo không được làm hỏng việc đang chạy).
   */
  alertChatId?: string | number;
}

/** Bóc chat id trần từ binding (cột có thể mang tiền tố "telegram:"). */
function rawChatId(binding: NotifyBinding): string {
  return String(binding.chatId)
    .replace(/^telegram:/i, "")
    .trim();
}

/**
 * `ChannelPort` cho Telegram. Trả `message_id` của tin cuối gửi đi (để
 * dispatcher ghi route cho reply), hoặc `null` khi không gửi được.
 */
export class TelegramNotifyChannel implements ChannelPort {
  readonly channelType: string;
  private readonly o: TelegramNotifyChannelOptions;
  private warnedMissingOkButton = false;

  constructor(options: TelegramNotifyChannelOptions) {
    this.o = options;
    this.channelType = options.channelType ?? "telegram";
  }

  async sendComment(input: {
    binding: NotifyBinding;
    authorName: string;
    text: string;
    images?: string[];
    videos?: string[];
  }): Promise<string | number | null> {
    const chatId = rawChatId(input.binding);
    if (!chatId) return null;
    // Text đã do dispatcher dựng (lời người xử lý, đã strip HTML/mention). Ảnh
    // kèm theo được nối thành markdown ở cuối để sendMessage không phải biết
    // chuyện media — giữ lớp này mỏng; bot cần gửi ảnh thật thì chèn một
    // ChannelPort riêng. (Giữ nguyên hành vi: notify của bot thật gửi text +
    // link ảnh trong text, không upload lại.)
    const body = this.composeCommentBody(input.text, input.images ?? [], input.videos ?? []);
    if (!body.trim()) return null;
    const sent = await sendMessage(this.o.transport, {
      chatId,
      text: body,
      parseMode: this.o.parseMode,
      messageThreadId: this.o.messageThreadId,
      onButtonDrop: this.o.onButtonDrop,
    });
    return lastMessageId(sent);
  }

  async sendStateChange(input: {
    binding: NotifyBinding;
    message: string;
    state: TicketLifecycleState;
    withReporterOkButton: boolean;
  }): Promise<string | number | null> {
    const chatId = rawChatId(input.binding);
    if (!chatId || !input.message.trim()) return null;

    let buttons: TelegramButton[][] | undefined;
    if (input.withReporterOkButton) {
      if (this.o.reporterOkButton) {
        const data = this.o.reporterOkButton.callbackData(input.binding.issueId);
        if (data) buttons = [[{ text: this.o.reporterOkButton.label, callback_data: data }]];
      } else if (!this.warnedMissingOkButton) {
        this.warnedMissingOkButton = true;
        getLogger().warn(
          "[TelegramNotifyChannel] tin resolved cần nút 'Đã ổn' nhưng chưa cấu hình reporterOkButton — gửi không nút.",
        );
      }
    }

    const sent = await sendMessage(this.o.transport, {
      chatId,
      text: input.message,
      buttons,
      parseMode: this.o.parseMode,
      messageThreadId: this.o.messageThreadId,
      onButtonDrop: this.o.onButtonDrop,
    });
    return lastMessageId(sent);
  }

  /** Báo động tới chat trực ca (`alertChatId`). Thiếu chat thì chỉ log. NGUỒN: intake `broadcastAlert`. */
  async sendAlert(text: string): Promise<boolean> {
    if (this.o.alertChatId === undefined || String(this.o.alertChatId).trim() === "") {
      getLogger().warn(
        "[TelegramNotifyChannel] chưa cấu hình alertChatId: bỏ qua cảnh báo trực ca.",
      );
      return false;
    }
    await sendMessage(this.o.transport, {
      chatId: String(this.o.alertChatId),
      text,
      parseMode: this.o.parseMode,
      onButtonDrop: this.o.onButtonDrop,
    });
    return true;
  }

  /** Gỡ nút khỏi một tin đã gửi — side job, lỗi nuốt (tryCall). */
  async clearInteractiveButtons(binding: NotifyBinding, messageId: string): Promise<void> {
    const chatId = rawChatId(binding);
    if (!chatId || !messageId) return;
    await this.o.transport.tryCall("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] },
    });
  }

  /**
   * Nối ảnh (markdown `![](url)`) và video (link trần: markdown không có cú pháp video) vào cuối
   * comment, giữ lớp mỏng. Gửi media thật qua Bot API là việc của một `ChannelPort` riêng.
   */
  private composeCommentBody(text: string, images: string[], videos: string[]): string {
    const media = [...images.filter(Boolean).map((u) => `![](${u})`), ...videos.filter(Boolean)];
    if (media.length === 0) return text;
    const links = media.join("\n");
    return text ? `${text}\n${links}` : links;
  }
}

function lastMessageId(sent: Array<{ message_id: number }>): number | null {
  const last = sent[sent.length - 1];
  return last ? last.message_id : null;
}
