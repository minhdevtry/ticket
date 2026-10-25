# Subpath và entry point

`@vuihoc/bot-core` là một package, nhiều subpath, mỗi subpath là một tầng. Danh sách này lấy từ `exports` trong `packages/core/package.json`; CI báo lỗi nếu thêm một subpath mà không mô tả ở đây, hoặc nhắc tới một subpath không tồn tại. Chi tiết từng hàm, class, kiểu nằm ở [API (TypeDoc)](/reference/api/).

| Subpath | Làm gì | Dùng khi |
|---|---|---|
| `@vuihoc/bot-core/core` | Hạ tầng: logger, tool-error, scaffold MCP server (stdio và HTTP), bộ nạp env, khử PII, `channel-envelope`, formatting chung (kể cả dấu comment bot), SQLite lười và `openPrivateDb` (file riêng tư 0600, lỗi mở thì ném), memo, preload cho test | Mọi bot |
| `@vuihoc/bot-core/itsaplan` | Client itsaplan, project, trạng thái ticket, đính kèm, nhãn, đăng ký webhook, và front door webhook (chữ ký, chống trùng, server) | Mọi thứ nói chuyện với itsaplan |
| `@vuihoc/bot-core/intake` | Lễ tân: gate (catalog, trường thiếu), luật ưu tiên, bản nháp, xác nhận, tạo ticket, engine hội thoại `step`, dispatcher báo ngược, reply router, outbox, kho trạng thái ticket (`TicketStateStore`), kênh nhật ký JSONL (`LogChannel`) | Bot tiếp nhận |
| `@vuihoc/bot-core/identity` | Vòng đời danh tính người dùng: đăng ký, duyệt, từ chối, đổi tài khoản (relink) có chặn chiếm danh | Bot cần biết người dùng là ai |
| `@vuihoc/bot-core/openclaw` | Bộ công cụ viết plugin OpenClaw: giới hạn theo agent, token danh tính theo lượt, nút bấm chờ gửi, kế hoạch đồng bộ workspace và deploy | Plugin chạy trên gateway OpenClaw |
| `@vuihoc/bot-core/telegram` | Kênh Telegram: transport Bot API, gửi an toàn, tách tin dài, render, media đến, cảnh báo admin, `ChannelPort` cho báo ngược | Bot dùng Telegram |
| `@vuihoc/bot-core/bot` | Bot kit: `defineBot` (khai báo, kiểm tra), `createBot` (runtime: poll agent-runs, heartbeat, dừng êm, health, đọc env), `runBot` (chạy tới khi có tín hiệu dừng), `/healthz` | Bot mới, muốn một khai báo thay vì ghép tay |
| `@vuihoc/bot-core/llm` | LLM: `createLlm` (Anthropic Messages hoặc OpenAI Chat, thử lại 429/5xx/mạng), vòng lặp tool (`runToolLoop`, `defineLlmTool`), `extract` có cấu trúc, trace lên itsaplan (`runAgentLoop`), token/chi phí, `llmEnv` | Bot gọi LLM; có sẵn ở handler hậu cần qua `ctx.llm` |
| `@vuihoc/bot-core/backoffice` | Hậu cần: kiểu `RunContext` và handler theo trigger, dispatcher run, tracker khoá một dự án, luật "sự kiện → điều kiện → hành động", hẹn giờ bền (`after`, `closeAfter`), lịch cron (`parseCron`, `BotScheduler`), kho SQLite (`BotStore`), đăng ký webhook theo luật, `TicketClosure` (báo người báo khi Resolved/Done, nút "Đã ổn" và trả lời tự do chỉ ghi comment), `ctx.keys` (khoá chống trùng bền), `InboundDefinition` (`backoffice.inbound`: tin của người báo vào bot) | Viết handler `mention`, rule; thường dùng qua `defineBot` |
| `@vuihoc/bot-core/testing` | `FakeItsaplan` (itsaplan giả, nói giao thức agent-runs) và `FakeLlm` (LLM giả, nói cả hai kiểu API), đều chạy trên HTTP thật. Chỉ dùng trong test | Test bot không cần mạng |
| `@vuihoc/bot-core/worker` | `startIntakeWorker`: lắp sẵn worker báo ngược (webhook, đăng ký, dispatcher, reply) | Bot cần báo ngược về chat |
| `@vuihoc/bot-core/eval` | Khung chạy hội thoại nhiều lượt rồi chấm; tiêu chí chấm do bot tiêm | Test chất lượng hội thoại |
| `@vuihoc/bot-core/prose/*` | Không phải code: markdown dùng chung (`AGENTS.shared.md`, skill `confirm-before-create`), bot sao chép vào lớp markdown của mình | Bot dùng OpenClaw |

Phụ thuộc theo một chiều: `core` ← `itsaplan` ← `intake`. `telegram`, `worker`, `identity`, `openclaw` và `eval` đứng trên các tầng đó. `llm` đứng trên `core` (và `itsaplan` cho trace), `backoffice` đứng trên `core`, `itsaplan` và `llm`, còn `bot` ghép `backoffice` với `core` thành một vòng đời.

## Thêm hoặc đổi subpath

1. Sửa `exports` trong `packages/core/package.json` và thêm một dòng vào bảng trên.
2. Thêm entry point vào `docs/typedoc.json` để TypeDoc phát trang API cho subpath mới.
3. Ghi vào `packages/core/CHANGELOG.md`.
