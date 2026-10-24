# Thêm kênh chat

Thư viện không biết kênh nào cả. Telegram là một cài đặt (`@vuihoc/bot-core/telegram`); thêm Zalo, Slack hay web chat là viết thêm một cài đặt, không đụng engine. Kênh xuất hiện ở hai chỗ.

| Hướng | Việc | Giao diện |
|---|---|---|
| Vào, trong hội thoại | Nhận tin của người báo, đưa cho engine, gửi lại các `ChannelMessage` engine trả về | Bot tự viết vòng này: gọi `step` rồi gửi |
| Ra, báo ngược | Đẩy comment và đổi trạng thái của ticket về đúng chat | `ChannelPort` (tiêm vào `NotificationDispatcher`) |

## Hướng vào: một kênh gọi engine

Engine nhận `StepInput` (id chat, văn bản thô, đường dẫn media, người báo) và trả `StepOutput` gồm danh sách `ChannelMessage` kèm nút. Engine không quan tâm kênh gửi bằng cách nào. Với Telegram, `TelegramChannelSender.send(chatId, message)` đổi nút của engine sang nút Telegram. Kênh mới viết một hàm tương đương:

```ts check
import type { ChannelMessage } from "@vuihoc/bot-core/intake";

/** Đổi một tin của engine sang định dạng của kênh mới (ở đây: chuỗi thuần). */
export function renderForConsole(message: ChannelMessage): string {
  const buttons = (message.buttons ?? [])
    .map((row) => row.map((b) => `[${b.text}]`).join(" "))
    .join("\n");
  return buttons ? `${message.text}\n${buttons}` : message.text;
}
```

Điều kênh phải giữ: một nút bấm trả về `callbackData` thì kênh đưa chuỗi đó nguyên vẹn vào tin kế tiếp (engine nhận diện nút qua khớp chính xác); và `forceNew` ở `StepInput` là cờ kênh đặt khi người báo gõ lệnh mở sự cố mới.

## Hướng ra: cài `ChannelPort`

`ChannelPort` có một khoá `channelType` và hai việc bắt buộc: gửi comment, gửi đổi trạng thái. Một cài đặt tối thiểu:

```ts check
import type { ChannelPort, NotifyBinding, TicketLifecycleState } from "@vuihoc/bot-core/intake";

export class ConsoleChannel implements ChannelPort {
  /** Khớp `binding.channelType`: dispatcher dùng nó để chọn port. */
  readonly channelType = "console";

  async sendComment(input: {
    binding: NotifyBinding;
    authorName: string;
    text: string;
    images?: string[];
  }): Promise<string> {
    console.log(`[${input.binding.chatId}] ${input.binding.identifier} - ${input.authorName}: ${input.text}`);
    // Trả id tin đã gửi để dispatcher ghi "route", nhờ đó người báo reply vào tin này
    // sẽ thành comment trên ticket.
    return `msg-${Date.now()}`;
  }

  async sendStateChange(input: {
    binding: NotifyBinding;
    message: string;
    state: TicketLifecycleState;
    withReporterOkButton: boolean;
  }): Promise<string> {
    // withReporterOkButton chỉ true khi ticket sang "đã xử lý": hiện nút "Đã ổn".
    console.log(`[${input.binding.chatId}] ${input.message}${input.withReporterOkButton ? " [Đã ổn]" : ""}`);
    return `msg-${Date.now()}`;
  }
}
```

Quy tắc cần tuân:

- **Trả id tin đã gửi** (hoặc `null` nếu kênh không biết). Có id thì dispatcher ghi một route (tin, kênh, chat, ticket); người báo reply vào tin đó mới thành comment đúng ticket.
- **Không đặt chuỗi tiếng Việt cố định trong port.** Nhãn nút "Đã ổn" và payload callback do bot tiêm (xem `reporterOkButton` của `TelegramNotifyChannel`).
- **Gửi lỗi thì ném**: dispatcher bắt và log, không làm chết worker. Cần đảm bảo không mất tin thì bọc port bằng `OutboxChannelPort` (xem [Dựng worker báo ngược](/how-to/notify-worker)).
- `channelType` phải khớp cột `channel_type` của binding. Binding cũ không có cột đó được coi là `telegram`.

## Nối vào worker

Đưa port vào `dispatcher.channel` khi dựng worker. Bot nhiều kênh dựng một worker cho mỗi kênh, hoặc một `ChannelPort` định tuyến theo `binding.channelType`.
