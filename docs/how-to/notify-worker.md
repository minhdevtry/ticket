# Dựng worker báo ngược

Worker báo ngược là luồng ngược của bot tiếp nhận: itsaplan có thay đổi (comment mới, đổi cột hay trạng thái, đóng) thì webhook bắn về worker, worker đẩy về đúng chat; người báo reply vào tin thông báo thì worker ghi thành comment trên ticket. `startIntakeWorker` (trong `@vuihoc/bot-core/worker`) gói các bước bắt buộc để bot sau chỉ cần gọi một hàm. Phần mô tả khái niệm ở [Kiến trúc](/explanation/architecture).

## Các bước thư viện tự lo

1. Mở HTTP server nghe webhook ở `config.port`.
2. **Sinh URL webhook từ chính cổng đang nghe** (`deriveWebhookUrl`), không nhận URL rời. Đây là chỗ chống lỗi "URL lệch cổng".
3. Dọn webhook cùng host nhưng lệch cổng (`pruneForeignWebhooks`), để sự kiện không bắn vào cổng không ai nghe.
4. Đăng ký hoặc kích hoạt webhook chuẩn (`ensureItsaplanWebhook`).
5. Nối sự kiện vào `NotificationDispatcher`, đẩy comment và đổi trạng thái về chat qua `ChannelPort`.
6. Nối reply của người báo vào `ReplyRouter`, ghi comment, không đổi trạng thái.

## Lỗi gốc đã vá

Khi dựng worker cho bot OP (16/10/2026), env sao chép từ Tiểu Linh có `WEBHOOK_URL` trỏ một cổng, còn worker lại nghe ở cổng khác. Hai biến rời nhau nên lệch: itsaplan đăng ký webhook về cổng không ai nghe và còn sót một webhook thừa phải xoá tay.

Nguyên nhân gốc: URL webhook và cổng nghe là **hai biến phải khớp bằng tay**. Bản vá là loại bỏ khả năng lệch: `startIntakeWorker` chỉ nhận cổng và host, rồi tự sinh URL từ cổng thật. Lưu ý trung thực: hàm `ensureItsaplanWebhook` không sai, nó đăng ký đúng URL được đưa; lỗi là người vận hành đưa URL lệch cổng.

Một lỗi cùng đợt: worker trỏ nhầm file SQLite rỗng (đường dẫn tương đối cộng thư mục chạy khác) nên đọc một DB không có binding và nuốt mọi comment trong im lặng. Truyền `dbPath` để thư viện tự kiểm lúc khởi động (xem bên dưới).

## Ghép một worker

```ts check
import { makeOpenLazyDb } from "@vuihoc/bot-core/core";
import {
  intakeApplySchema,
  itsaplanTrackerPort,
  notifyApplySchema,
  SqliteMessageRouteStore,
  SqliteNotifyBindingReader,
} from "@vuihoc/bot-core/intake";
import { ItsaplanClient, ProjectColumnStates } from "@vuihoc/bot-core/itsaplan";
import { TelegramNotifyChannel, TelegramTransport } from "@vuihoc/bot-core/telegram";
import { startIntakeWorker } from "@vuihoc/bot-core/worker";

// Lấy từ biến môi trường của bot (tên biến do bot đặt; thư viện không đọc env).
declare const ITSAPLAN_BASE_URL: string;
declare const ITSAPLAN_API_KEY: string;
declare const BOT_TOKEN: string;
declare const WEBHOOK_SECRET: string;
declare const DB_PATH: string;

const db = makeOpenLazyDb({
  applySchema: (d, opts) => {
    intakeApplySchema(d, opts);
    notifyApplySchema(d, opts);
  },
})(DB_PATH);

// Chữ ký: (baseUrl, apiKey, opts).
const itsaplan = new ItsaplanClient(ITSAPLAN_BASE_URL, ITSAPLAN_API_KEY);
// Tham số tên là botToken, không phải token.
const transport = new TelegramTransport({ botToken: BOT_TOKEN, timeoutMs: 5000 });
const channel = new TelegramNotifyChannel({
  transport,
  // Nhãn nút và payload do bot tiêm: thư viện không chứa chuỗi tiếng Việt.
  reporterOkButton: { label: "Đã ổn", callbackData: (id) => `reporter_ok:${id}` },
});

// Webhook chỉ mang columnId; bot nối bảng cột của dự án sang trạng thái vòng đời.
const states = new ProjectColumnStates(itsaplan);

export const worker = await startIntakeWorker({
  itsaplan,
  projectKey: "OP", // worker chỉ phục vụ dự án này
  host: "10.0.0.5", // host mà itsaplan gọi về được
  port: 3104, // URL webhook được sinh từ cổng này
  server: { itsaplanSecrets: [WEBHOOK_SECRET] }, // whsec_... của subscription
  dbPath: DB_PATH, // tự kiểm DB lúc khởi động
  dispatcher: {
    bindings: new SqliteNotifyBindingReader(db),
    routes: new SqliteMessageRouteStore(db),
    channel,
    columns: {
      async stateOf({ project, columnId }) {
        const r = await states.stateOf(project, columnId);
        return r ? { state: r.state, columnName: r.column.name } : null;
      },
    },
    copy: {
      // Chuỗi tiếng Việt riêng dự án ở bot, không ở thư viện. Trả null = không báo gì.
      describe: ({ identifier, columnName }) => `${identifier} chuyển sang "${columnName}".`,
    },
  },
  reply: {
    routes: new SqliteMessageRouteStore(db),
    // addComment của ItsaplanClient trả object, còn ReplyRouter cần TrackerPort: dùng adapter.
    tracker: itsaplanTrackerPort({ client: itsaplan, projectKey: "OP", baseUrl: ITSAPLAN_BASE_URL }),
    copy: {
      comment: ({ who, text, time }) => `${who} (${time}): ${text}`,
      ack: ({ identifier }) => `Đã ghi nhận vào ${identifier}.`,
    },
  },
});
```

Điểm cần nhớ:

- `startIntakeWorker` **không đọc `process.env`**: mọi thứ tiêm vào, nên test bơm cổng 0 và client giả được.
- Dispatcher dùng `ChannelPort` (`TelegramNotifyChannel`), khác `TelegramChannelSender` dành cho engine hội thoại.
- `server.listenHost` mặc định `127.0.0.1`. itsaplan ở máy khác trong LAN thì đặt `"0.0.0.0"` (hoặc IP LAN) để nhận thẳng, và **bắt buộc** đặt `itsaplanSecrets`. Các endpoint `/internal/*` luôn chỉ nhận từ loopback.
- Mỗi worker một dự án. Nhiều worker dùng chung một DB phải khác `projectKey` để lọc sự kiện.
- Máy chạy worker phải là máy itsaplan gọi về được (cùng LAN hoặc có route). Kiểm bằng `GET /projects/<KEY>/webhooks` xem webhook có `isActive`.

## Thử dispatcher không cần mạng

Mẫu sau chạy thật trong CI: dựng dispatcher với SQLite trong RAM và một kênh giả, đưa vào một sự kiện `comment.created`, và khẳng định tin được đẩy đúng chat, đồng thời có route để reply.

```ts run
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import {
  type ChannelPort,
  intakeApplySchema,
  NotificationDispatcher,
  notifyApplySchema,
  SqliteChannelBindingStore,
  SqliteMessageRouteStore,
  SqliteNotifyBindingReader,
} from "@vuihoc/bot-core/intake";
import type { ItsaplanWebhookEnvelope } from "@vuihoc/bot-core/itsaplan";

const db = new Database(":memory:");
intakeApplySchema(db);
notifyApplySchema(db);

new SqliteChannelBindingStore(db).saveBinding({
  issueId: 42,
  chatId: "-1000000000001",
  identifier: "OP-7",
  title: "Không vào được lớp",
});

const sent: string[] = [];
const channel: ChannelPort = {
  channelType: "telegram",
  async sendComment({ binding, text }) {
    sent.push(`${binding.chatId}: ${text}`);
    return "m-1";
  },
  async sendStateChange() {
    return null;
  },
};

const routes = new SqliteMessageRouteStore(db);
const dispatcher = new NotificationDispatcher({
  bindings: new SqliteNotifyBindingReader(db),
  routes,
  channel,
  copy: { describe: () => null },
  projectKey: "OP",
});

const event: ItsaplanWebhookEnvelope = {
  action: "create",
  type: "Comment",
  event: "comment.created",
  data: { id: 1, issueId: 42, body: "Đã kiểm tra, đang xử lý." },
  actor: { type: "human", name: "Nhân sự A" },
  createdAt: "2026-10-25T09:00:00.000Z",
};
await dispatcher.handleEvent(event);

assert.deepEqual(sent, ["-1000000000001: Đã kiểm tra, đang xử lý."]);
assert.equal(routes.getMessageRoute("m-1", "telegram", "-1000000000001")?.identifier, "OP-7");
```

## Tốc độ và độ tin cậy

Các điểm tốc độ không hardcode, đều tiêm được:

| Điều chỉnh | Ở đâu | Ghi chú |
|---|---|---|
| Ack webhook | `ItsaplanWebhookServer` | Trả `200` cho itsaplan **trước** khi chạy handler nên itsaplan không chờ. Không cần chỉnh. |
| Timeout gửi Telegram | `TelegramTransport({ timeoutMs })` | Mặc định 15 giây. Đặt ngắn (vài giây) để một chat kẹt không giữ cả luồng. |
| Số lần thử lại khi 429 | `TelegramTransport({ maxRetries })` | Mặc định 1. Giữ thấp cho realtime. |
| Trễ xác nhận tạo ticket | `deps.confirm.minConfirmDelayMs` của `createTicket` | Mặc định 5 giây, chống model tự "bấm". |

Điểm nghẽn tốc độ tạo ticket thường nằm ở model (hàng chục giây một lượt), ngoài phạm vi thư viện: chỉnh ở cấu hình gateway.

**Đảm bảo không mất tin (tuỳ chọn, mặc định tắt).** Mặc định thư viện gửi thẳng: nhanh, nhưng một lỗi tức thời làm mất tin đó. Bot cần chắc chắn thì bọc `ChannelPort` bằng `OutboxChannelPort`:

```ts check
import { Database } from "bun:sqlite";
import {
  type ChannelPort,
  OutboxChannelPort,
  outboxApplySchema,
  SqliteOutboxStore,
} from "@vuihoc/bot-core/intake";

declare const telegramChannel: ChannelPort;

const db = new Database(":memory:");
outboxApplySchema(db);
const outbox = new SqliteOutboxStore(db);
// Dùng làm dispatcher.channel: gửi thẳng ổn thì không ghi DB; lỗi thì xếp hàng.
export const channel = new OutboxChannelPort(telegramChannel, outbox);

// Định kỳ (cron hoặc nhịp worker) gửi lại việc tồn.
await outbox.drain(telegramChannel);
```

Gửi lại tối đa `maxAttempts` lần với backoff, hết lượt thì đánh dấu `failed` và ghi log.

## Lưu người báo theo user id

Binding mang thêm `reporterUserId` (user id của kênh, Telegram là `from.id`), bền hơn username hay tên hiển thị vì không đổi được. Truyền khi lưu binding; có thể tra ticket theo người độc lập với chat bằng `getLatestBindingByUserId`. Cột này nullable và DB cũ được thêm cột tự động khi áp schema, không cần migration tay.

Khi người dùng đổi tài khoản Telegram, `relinkIdentityAndBindings` (trong `@vuihoc/bot-core/identity`) đổi định danh sang id mới (có chặn chiếm danh) và chuyển các binding cũ sang id mới trong một thao tác, nên lịch sử ticket đi theo người.

## Dùng chung file với Tiểu Linh 1

`SqliteChannelBindingStore`, `SqliteNotifyBindingReader` và `SqliteMessageRouteStore` cũng đọc/ghi được file SQLite dạng legacy của Tiểu Linh 1 (có `channel_type` và `message_id` bắt buộc), nhưng file đó không được áp `intakeApplySchema` hay `notifyApplySchema`: xem [Dùng chung binding với Tiểu Linh 1](/how-to/share-bindings-with-tl1).
