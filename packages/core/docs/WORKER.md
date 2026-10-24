# Worker báo ngược — `@vuihoc/bot-core/worker`

Luồng báo ngược của một bot tiếp nhận: Itsaplan có thay đổi (comment mới, đổi
cột/trạng thái, đóng) → webhook bắn về worker → worker đẩy về đúng chat; và người
báo reply tin thông báo → worker ghi thành comment trên ticket (ADR-0006).

Module này đúc kết các bước BẮT BUỘC rút ra từ lần dựng worker OP, để bot sau chỉ
gọi **một hàm** `startIntakeWorker(config)`.

## Các bước module tự lo

1. Mở HTTP server nghe webhook ở `config.port`.
2. **Sinh URL webhook TỪ CHÍNH cổng đang nghe** (`deriveWebhookUrl`) — không truyền
   URL rời. Đây là chỗ chống lỗi "URL lệch cổng" (xem §Lỗi gốc).
3. Dọn webhook cùng host nhưng lệch cổng (`pruneForeignWebhooks`) — không để sự kiện
   bắn vào một cổng không ai nghe.
4. Đăng ký / kích hoạt webhook chuẩn (`ensureItsaplanWebhook`).
5. Nối sự kiện → `NotificationDispatcher` (đẩy comment/đổi trạng thái về chat qua `ChannelPort`).
6. Nối reply → `ReplyRouter` (ghi comment, không đổi trạng thái).

## Lỗi gốc đã vá (sự cố OP, 16/10/2026)

Khi dựng worker OP, env sao chép từ Tiểu Linh có `WEBHOOK_URL` trỏ cổng **3102**,
còn worker lại nghe `WEBHOOK_PORT=**3104**`. Hai biến rời nhau nên lệch: Itsaplan
đăng ký webhook về 3102 — không ai nghe — và còn sót một webhook thừa phải xoá tay.

**Nguyên nhân gốc:** URL webhook và cổng nghe là HAI biến phải khớp bằng tay. Bản
intake nhận cả hai từ env riêng (`WEBHOOK_URL` vs `WEBHOOK_PORT`), nên lệch được.

**Cách vá trong thư viện:** `startIntakeWorker` chỉ nhận **cổng + host**, rồi tự
sinh URL từ cổng thật đang nghe (`server.port()`), nên không còn hai biến để lệch.
Thêm `pruneForeignWebhooks` dọn webhook cùng host lệch cổng trước khi đăng ký, nên
một webhook thừa từ lần chạy cũ không bắn trùng.

> Lưu ý trung thực: bản thân hàm `ensureItsaplanWebhook` của thư viện KHÔNG sai —
> nó đăng ký đúng URL được đưa. Lỗi là ở chỗ *người vận hành* đưa URL lệch cổng.
> Bản vá là loại bỏ khả năng lệch đó, không phải sửa một hàm hỏng.

## Cách bot mới tích hợp

```ts
import { startIntakeWorker } from "@vuihoc/bot-core/worker";
import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import { TelegramTransport, TelegramChannelSender } from "@vuihoc/bot-core/telegram";
import { SqliteMessageRouteStore, SqliteNotifyBindingReader } from "@vuihoc/bot-core/intake";
import { makeOpenLazyDb } from "@vuihoc/bot-core/core";

const db = makeOpenLazyDb({ applySchema: /* intakeApplySchema + notifyApplySchema */ })(DB_PATH);
const itsaplan = new ItsaplanClient({ baseUrl: ITSAPLAN_BASE_URL, apiKey: ITSAPLAN_API_KEY });
const transport = new TelegramTransport({ token: BOT_TOKEN });
const channel = new TelegramChannelSender({ transport, /* … */ });

await startIntakeWorker({
  itsaplan,
  projectKey: "OP",          // worker chỉ phục vụ dự án này (ADR-0001)
  host: "10.0.0.5",    // IP LAN Itsaplan gọi về được
  port: 3104,                // worker nghe ở đây; URL webhook SINH TỪ cổng này
  // server: { listenHost: "0.0.0.0", itsaplanSecrets: [...] },  // v0.5.2: Itsaplan ở máy khác ⇒ nhận thẳng, khỏi proxy (mặc định bind 127.0.0.1)
  server: { itsaplanSecrets: [WEBHOOK_SECRET] },   // whsec_… của subscription
  dispatcher: {
    bindings: new SqliteNotifyBindingReader(db),
    routes: new SqliteMessageRouteStore(db),
    channel,
    copy: /* StateChangeCopyMap riêng dự án — chuỗi tiếng Việt ở bot, không ở lib */,
  },
  reply: {
    routes: new SqliteMessageRouteStore(db),
    tracker: itsaplan,
    copy: { comment: ({ who, text, time }) => `…`, ack: ({ identifier }) => `…` },
  },
});
```

### Env tối thiểu một bot cần (tên biến, không phải giá trị)

| Biến | Dùng để |
|---|---|
| `ITSAPLAN_BASE_URL`, `ITSAPLAN_API_KEY` | client Itsaplan |
| `ITSAPLAN_PROJECT_KEY` | dự án worker phụ trách (vd `OP`) |
| `ITSAPLAN_WEBHOOK_SECRET` | `whsec_…` của subscription để kiểm chữ ký |
| `WEBHOOK_HOST` + `WEBHOOK_PORT` | host + cổng; URL webhook sinh từ hai cái này |
| `TELEGRAM_BOT_TOKEN` | ChannelPort Telegram |
| `INTAKE_DB_PATH` | SQLite cục bộ (ADR-0003: cache tạm) |

**KHÔNG** đặt `WEBHOOK_URL` rời nữa — URL do `startIntakeWorker` sinh từ host+port.

## Nền tảng dùng chung (v0.6.0)

Bốn bổ sung để lib làm nền cho mọi bot, rút từ bài học dựng OP:

### 1. `TelegramNotifyChannel` — ChannelPort cho Telegram, lắp sẵn

Trước đây mỗi bot phải tự viết lớp nối notify ↔ Telegram (`sendComment` /
`sendStateChange` / `clearInteractiveButtons`). Giờ dùng thẳng:

```ts
import { TelegramNotifyChannel } from "@vuihoc/bot-core/telegram";
const channel = new TelegramNotifyChannel({
  transport,
  reporterOkButton: { label: "👍 Đã ổn", callbackData: (id) => `reporter_ok:${id}` }, // ADR-0006
});
// dùng cho dispatcher.channel
```

Nhãn nút và payload callback do bot TIÊM — không literal tiếng Việt trong lib.
`TelegramChannelSender` (cũ) vẫn dành cho ENGINE (hội thoại); `TelegramNotifyChannel`
dành cho NOTIFY (báo ngược).

### 2. Lưu người báo theo USER ID (khóa định danh bền)

Binding mang thêm `reporterUserId` = user id của kênh (Telegram = `from.id`), bền
hơn username/tên hiển thị (đổi được). Truyền khi tạo ticket:

```ts
createTicket(deps, { chatId, reporter: { userId: fromId, username, name } });
```

Tra ticket theo người, độc lập chat: `bindings.getLatestBindingByUserId(userId, "OP")`.
Cột `reporter_user_id` **nullable**; DB cũ được ALTER bù cột tự động khi áp schema —
**không cần migration tay**, bot chưa truyền id thì hành vi như cũ.

> Tầng `identity` đã lưu theo id sẵn (`userId` = telegram user id, cột PK
> `telegram_user_id`); đây là bổ sung tương ứng cho tầng *binding chat↔ticket*.

### 3. `dbPath` — chốt chặn worker trỏ nhầm DB

Truyền `dbPath` để lib tự KIỂM lúc khởi động (resolve tuyệt đối + đếm
`ticket_bindings` + cảnh báo nếu rỗng/thiếu bảng):

```ts
await startIntakeWorker({ /* … */, dbPath: INTAKE_DB_PATH });
```

Đây là chốt chặn lỗi OP 16/10 (worker đọc nhầm `data/op.db` rỗng do path tương
đối + CWD khác → nuốt mọi comment). Cũng có hàm độc lập: `inspectBindingDb(path)`
và `resolveDbPath(path)` trong `@vuihoc/bot-core/core`.

### 4. Tối ưu tốc độ realtime (OP) — các knob đã có, chỉ cần CẤU HÌNH

OP chú trọng tốc độ phản hồi + tạo ticket. Các điểm tốc độ **không hardcode**,
đều inject được:

| Knob | Ở đâu | Chỉnh cho realtime |
|---|---|---|
| Ack webhook | `ItsaplanWebhookServer` | Đã trả `200` cho Itsaplan **trước** khi chạy handler — dispatcher chạy nền, Itsaplan không chờ. Không cần chỉnh. |
| Timeout gửi Telegram | `TelegramTransport({ timeoutMs })` | Dựng transport notify với `timeoutMs` NGẮN (vd 5s) để một chat kẹt không giữ cả luồng; mặc định 15s. |
| Số lần retry 429 | `TelegramTransport({ maxRetries })` | Mặc định 1. Giữ thấp cho realtime. |
| Trễ xác nhận tạo ticket | `createTicket(deps, …)` với `deps.confirm.minConfirmDelayMs` | Mặc định 5s (chống model tự "bấm"). Người thật bấm nút thì 5s là đủ nhanh; hạ thêm nếu đo được an toàn. |

> Điểm nghẽn tốc độ tạo ticket của OP nằm ở model (DeepSeek ~15s/lượt), **ngoài
> phạm vi lib** — chỉnh ở cấu hình gateway (maxTokens thấp, thinking phù hợp),
> không phải ở `@vuihoc/bot-core`.

### 5. Outbox opt-in — đảm-bảo-gửi (v0.7.0, mặc định TẮT)

Mặc định lib gửi thẳng (nhanh, nhưng một lỗi tức thời làm mất tin đó). Bot nào CẦN
chắc chắn không mất tin thì BỌC `ChannelPort`:

```ts
import { SqliteOutboxStore, OutboxChannelPort, outboxApplySchema } from "@vuihoc/bot-core/intake";
const outbox = new SqliteOutboxStore(db);                 // db đã áp outboxApplySchema
const channel = new OutboxChannelPort(telegramChannel, outbox); // dùng cho dispatcher.channel
// định kỳ (cron/worker tick) gửi lại việc tồn:
await outbox.drain(telegramChannel);
```

Gửi thẳng ổn thì KHÔNG ghi DB (đường thành công không chậm). Lỗi → xếp hàng, `drain`
gửi lại tối đa `maxAttempts` lần + backoff, hết lượt thì `failed` (log). **OP để
mặc định tắt** (realtime, ưu tiên nhanh); bật cho bot cần đảm bảo.

### 6. Đổi tài khoản Telegram (v0.7.0) — relink giữ lịch sử theo người

Khi GV đổi tài khoản Telegram, dùng `relinkIdentityAndBindings` để đổi định danh
(name_code → user id mới, có guard chống chiếm danh) VÀ chuyển binding ticket cũ
sang id mới trong một thao tác:

```ts
import { relinkIdentityAndBindings } from "@vuihoc/bot-core/identity";
const r = relinkIdentityAndBindings(repo, bindings,
  { nameCode: "TE_usera", newUserId: "<id mới>", approver: adminId },
  { isAuthorizedApprover: (a) => a === adminId, protectedAdminIds: [...] });
// r.reboundBindings = số ticket đã theo người sang id mới
```

Lịch sử ticket giữ theo NGƯỜI (name_code + id mới), không mất; chat_id tự cập nhật
khi có tin mới. Nhất quán với khóa định danh `reporterUserId` ở §2.

## Điều kiện hạ tầng

- Máy chạy worker phải **Itsaplan gọi về được** (cùng LAN / có route). Kiểm bằng
  `GET /projects/<KEY>/webhooks` xem webhook có `isActive`.
- Mỗi worker một dự án. Nhiều worker dùng chung một DB phải khác `ITSAPLAN_PROJECT_KEY`
  để lọc sự kiện (ADR-0001).
