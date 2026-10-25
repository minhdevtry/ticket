/**
 * `LogChannel` — `ChannelPort` KHÔNG gửi gì ra ngoài: ghi lại "sẽ gửi gì, cho ai" thành một dòng
 * JSON (JSONL) trong file. Dùng cho chế độ bóng (shadow): bot mới chạy thật trên itsaplan nhưng
 * chưa có token chat, hoặc chưa được phép nhắn người thật; người vận hành đọc file để so với bản
 * đang chạy.
 *
 * - Trả về một id tin giả (`log-<mốc>-<số thứ tự>`), nên route trả lời và dấu "tin đang mang nút
 *   Đã ổn" của người gọi vẫn được ghi như khi gửi thật: luồng phía trên không phân biệt được.
 * - File tạo mode 0600, thư mục mode 0700 nếu do kênh tạo (nội dung là lời gửi người báo).
 * - Ghi lỗi (đĩa đầy, hết quyền) ném ra như một lần gửi thất bại, để người gọi xử lý như mọi kênh.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelPort, Clock, NotifyBinding, TicketLifecycleState } from "../ports";
import { systemClock } from "../ports";

/** Một dòng của file nhật ký kênh. */
export interface ChannelLogRecord {
  /** ISO. */
  at: string;
  /** `channelType` của kênh ghi (mặc định `log`). */
  channel: string;
  kind: "comment" | "state" | "clear" | "alert";
  /** Id tin giả đã trả cho người gọi (không có ở `clear` và `alert`). */
  messageId?: string;
  issueId?: number;
  identifier?: string;
  chatId?: string;
  text?: string;
  authorName?: string;
  state?: TicketLifecycleState;
  withReporterOkButton?: boolean;
  images?: string[];
  videos?: string[];
  /** `clear`: id tin bị gỡ nút. */
  targetMessageId?: string;
}

export interface LogChannelOptions {
  /** File JSONL. Nên là đường dẫn tuyệt đối. */
  file: string;
  /** Giá trị `channelType` (khớp `binding.channelType`). Mặc định `log`. */
  channelType?: string;
  clock?: Clock;
}

export class LogChannel implements ChannelPort {
  readonly channelType: string;
  private readonly file: string;
  private readonly clock: Clock;
  private seq = 0;

  constructor(options: LogChannelOptions) {
    this.file = options.file;
    this.channelType = options.channelType ?? "log";
    this.clock = options.clock ?? systemClock;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
  }

  private write(record: Omit<ChannelLogRecord, "at" | "channel">): void {
    const line = `${JSON.stringify({ at: new Date(this.clock.now()).toISOString(), channel: this.channelType, ...record })}\n`;
    const fresh = !existsSync(this.file);
    appendFileSync(this.file, line, { mode: 0o600 });
    if (fresh) chmodSync(this.file, 0o600); // `mode` của appendFile chịu ảnh hưởng umask
  }

  private nextId(): string {
    return `log-${this.clock.now()}-${++this.seq}`;
  }

  private who(binding: NotifyBinding) {
    return { issueId: binding.issueId, identifier: binding.identifier, chatId: binding.chatId };
  }

  async sendComment(input: {
    binding: NotifyBinding;
    authorName: string;
    text: string;
    images?: string[];
    videos?: string[];
  }): Promise<string> {
    const messageId = this.nextId();
    this.write({
      kind: "comment",
      messageId,
      ...this.who(input.binding),
      authorName: input.authorName,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.videos?.length ? { videos: input.videos } : {}),
    });
    return messageId;
  }

  async sendStateChange(input: {
    binding: NotifyBinding;
    message: string;
    state: TicketLifecycleState;
    withReporterOkButton: boolean;
  }): Promise<string> {
    const messageId = this.nextId();
    this.write({
      kind: "state",
      messageId,
      ...this.who(input.binding),
      text: input.message,
      state: input.state,
      withReporterOkButton: input.withReporterOkButton,
    });
    return messageId;
  }

  async clearInteractiveButtons(binding: NotifyBinding, messageId: string): Promise<void> {
    this.write({ kind: "clear", ...this.who(binding), targetMessageId: messageId });
  }

  async sendAlert(text: string): Promise<void> {
    this.write({ kind: "alert", text });
  }
}

/** Đọc lại nhật ký của {@link LogChannel}. Dòng hỏng bị bỏ qua; file chưa có thì mảng rỗng. */
export function readChannelLog(file: string): ChannelLogRecord[] {
  if (!existsSync(file)) return [];
  const out: ChannelLogRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChannelLogRecord);
    } catch {
      // dòng ghi dở khi sập: bỏ qua
    }
  }
  return out;
}
