# Sự kiện webhook itsaplan

itsaplan gọi `POST` tới URL webhook của dự án mỗi khi có thay đổi. Trang này mô tả phong bì sự kiện, cách kiểm chữ ký và chống trùng, và sự kiện nào được xử lý như thế nào. Mọi thứ ở đây lấy từ `@vuihoc/bot-core/itsaplan` (`itsaplan/webhook` và `ensure-webhook`) và `NotificationDispatcher` trong `@vuihoc/bot-core/intake`. CI đối chiếu bảng sự kiện với union `ItsaplanWebhookEventName` trong code.

## Sự kiện

| Sự kiện | Khi nào bắn | Tự đăng ký | Dispatcher |
|---|---|---|---|
| `issue.created` | Ticket mới (kể cả ticket nhân sự tự tạo trực tiếp trên itsaplan) | có | bỏ qua |
| `issue.updated` | Ticket đổi nội dung | không | xử lý như đổi trạng thái |
| `issue.deleted` | Ticket bị xoá | không | bỏ qua |
| `issue.assigned` | Ticket được giao | có | bỏ qua |
| `issue.state_changed` | Trạng thái đổi | có | báo trạng thái cho người báo |
| `issue.column_changed` | Ticket sang cột khác | không | xử lý như đổi trạng thái |
| `issue.label_changed` | Nhãn đổi | không | bỏ qua |
| `issue.link_changed` | Liên kết giữa các ticket đổi | không | bỏ qua |
| `comment.created` | Comment mới | có | đẩy về người báo (có điều kiện) |
| `comment.updated` | Comment được sửa hoặc ghim | có | bỏ qua (không báo lại) |

Cột "Tự đăng ký" là danh sách mặc định `REQUIRED_WEBHOOK_EVENTS`: `ensureItsaplanWebhook` bảo đảm webhook của dự án có ít nhất các sự kiện này. Bot chỉ xử lý một phần sự kiện có thể truyền `{ events }` để đăng ký bộ riêng (Tiểu Linh làm vậy). "Dispatcher" là hành vi của `NotificationDispatcher.handleEvent`; bot tự viết handler (`server.onEvent`) thì xử lý sự kiện theo ý mình.

### Quy tắc của dispatcher

- **Khoá dự án trước mọi tác dụng phụ.** itsaplan gửi sự kiện của mọi dự án tới mọi webhook, không lọc. Sự kiện mà dispatcher không đọc được dự án thì bị bỏ, không được đoán.
- **Comment của bot không đẩy lại** (nhận diện bằng dấu comment bot, xem [Chuyển bot sang bot-core](/how-to/adopt-core)), tránh vòng echo.
- **Comment gắn cờ nội bộ** (`#noibo`, `#nộibộ`, `#internal`, `[nội bộ]`, `[noi bo]`) ở lại trên tracker, không gửi người báo.
- **`commentForwardPolicy`**: `all` (mặc định) đẩy mọi comment của người; `mention` chỉ đẩy comment có tag bot.
- **Thiếu binding thì cảnh báo to**, không im lặng: thường do worker trỏ nhầm file SQLite.
- Bot không bao giờ tự đóng ticket: chỉ người xử lý chuyển sang hoàn tất. Khi ticket sang "đã xử lý", người báo nhận nút "Đã ổn" chỉ để ghi comment.

## Phong bì

```ts check
import type { ItsaplanWebhookEnvelope } from "@vuihoc/bot-core/itsaplan";

// Hình dạng của một sự kiện comment mới (dữ liệu giả).
export const example: ItsaplanWebhookEnvelope = {
  action: "create",
  type: "Comment",
  event: "comment.created",
  data: { id: 7, issueId: 42, body: "Đã kiểm tra, đang xử lý." },
  actor: { type: "human", name: "Nhân sự A" },
  createdAt: "2026-10-25T09:00:00.000Z",
  webhookTimestamp: 1_792_918_800_000,
};
```

`actor.type` có thể là `human`, `agent` hoặc `system`.

## Chữ ký

Header `X-Itsaplan-Signature` có dạng `t=<giây>,v1=<hex>`. `v1` là HMAC-SHA256, khoá là secret `whsec_...` của subscription, trên chuỗi `<t>.<raw body>` (đúng byte nhận được). Server từ chối nếu chữ ký thiếu hoặc sai (401) hoặc `t` lệch đồng hồ quá 5 phút. Vì webhook không lọc dự án nên một endpoint có thể nhận từ nhiều subscription: `verifyItsaplanSignature` nhận **danh sách** secret.

```ts check
import { verifyItsaplanSignature } from "@vuihoc/bot-core/itsaplan";

declare const header: string | undefined; // giá trị header X-Itsaplan-Signature
declare const rawBody: string; // body thô, chưa parse

export const ok = verifyItsaplanSignature(header, rawBody, ["whsec_aaa", "whsec_bbb"]);
```

Nếu không đặt secret, `ItsaplanWebhookServer` vẫn nhận request nhưng cảnh báo: chỉ chấp nhận được khi server bind loopback sau một reverse proxy.

## Chống trùng

Khoá chống trùng là `<event>|<issueId>|<commentId>|<webhookTimestamp>` (`webhookDedupeKey`), nên hai sự kiện khác nhau cùng mili giây không bị coi là một. Payload không có `webhookTimestamp` thì không khoá được và luôn được xử lý. Kho chống trùng mặc định nằm trong RAM của một tiến trình; truyền `dedupeStore` (ví dụ bản SQLite) để bền qua lần khởi động lại và dùng chung giữa các worker.

## Phản hồi

Server trả `200` cho itsaplan **trước** khi chạy handler, nên handler chạy nền và itsaplan không chờ. Sự kiện trùng cũng trả `200` với `duplicate: true`. Body hỏng trả `400`, vượt trần body (mặc định 1 MB) trả `413`.
