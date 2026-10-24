# Subpath và entry point

`@vuihoc/bot-core` là một package, nhiều subpath, mỗi subpath là một tầng. Danh sách này lấy từ `exports` trong `packages/core/package.json`; CI báo lỗi nếu thêm một subpath mà không mô tả ở đây, hoặc nhắc tới một subpath không tồn tại. Chi tiết từng hàm, class, kiểu nằm ở [API (TypeDoc)](/reference/api/).

| Subpath | Làm gì | Dùng khi |
|---|---|---|
| `@vuihoc/bot-core/core` | Hạ tầng: logger, tool-error, scaffold MCP server (stdio và HTTP), bộ nạp env, khử PII, `channel-envelope`, formatting chung (kể cả dấu comment bot), SQLite lười, memo, preload cho test | Mọi bot |
| `@vuihoc/bot-core/itsaplan` | Client itsaplan, project, trạng thái ticket, đính kèm, nhãn, đăng ký webhook, và front door webhook (chữ ký, chống trùng, server) | Mọi thứ nói chuyện với itsaplan |
| `@vuihoc/bot-core/intake` | Lễ tân: gate (catalog, trường thiếu), luật ưu tiên, bản nháp, xác nhận, tạo ticket, engine hội thoại `step`, dispatcher báo ngược, reply router, outbox | Bot tiếp nhận |
| `@vuihoc/bot-core/identity` | Vòng đời danh tính người dùng: đăng ký, duyệt, từ chối, đổi tài khoản (relink) có chặn chiếm danh | Bot cần biết người dùng là ai |
| `@vuihoc/bot-core/openclaw` | Bộ công cụ viết plugin OpenClaw: giới hạn theo agent, token danh tính theo lượt, nút bấm chờ gửi, kế hoạch đồng bộ workspace và deploy | Plugin chạy trên gateway OpenClaw |
| `@vuihoc/bot-core/telegram` | Kênh Telegram: transport Bot API, gửi an toàn, tách tin dài, render, media đến, cảnh báo admin, `ChannelPort` cho báo ngược | Bot dùng Telegram |
| `@vuihoc/bot-core/worker` | `startIntakeWorker`: lắp sẵn worker báo ngược (webhook, đăng ký, dispatcher, reply) | Bot cần báo ngược về chat |
| `@vuihoc/bot-core/eval` | Khung chạy hội thoại nhiều lượt rồi chấm; tiêu chí chấm do bot tiêm | Test chất lượng hội thoại |
| `@vuihoc/bot-core/prose/*` | Không phải code: markdown dùng chung (`AGENTS.shared.md`, skill `confirm-before-create`), bot sao chép vào lớp markdown của mình | Bot dùng OpenClaw |

Phụ thuộc theo một chiều: `core` ← `itsaplan` ← `intake`. `telegram`, `worker`, `identity`, `openclaw` và `eval` đứng trên các tầng đó.

## Thêm hoặc đổi subpath

1. Sửa `exports` trong `packages/core/package.json` và thêm một dòng vào bảng trên.
2. Thêm entry point vào `docs/typedoc.json` để TypeDoc phát trang API cho subpath mới.
3. Ghi vào `packages/core/CHANGELOG.md`.
