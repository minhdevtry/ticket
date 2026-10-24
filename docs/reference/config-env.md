# Cấu hình và biến môi trường

Trang này là bảng tra cứu mọi biến môi trường mà code chạy thật của Tiểu Linh (`apps/tieulinh`) đọc. Nó được CI đối chiếu với code bằng `scripts/check-docs-refs.ts`: thêm biến vào code hoặc `.env.example` mà không ghi ở đây, hoặc ghi ở đây một biến code không còn đọc, đều làm CI đỏ. Mỗi biến một dòng, tên biến ở cột đầu.

Mẫu giá trị: [`apps/tieulinh/openclaw/.env.example`](https://github.com/minhdevtry/ticket/blob/main/apps/tieulinh/openclaw/.env.example). **Không commit file `.env`**; secret đẩy lên máy chạy qua SSH ([Deploy và đẩy secret qua SSH](/how-to/deploy)).

::: tip Thư viện bot-core không tự đọc biến nào
`@vuihoc/bot-core` nhận mọi cấu hình qua tham số (ví dụ `startIntakeWorker` không đọc `process.env`). Nó chỉ cung cấp bộ nạp env (`parseEnvContent`, `loadEnvFile`, `loadEnvDefaults` trong `@vuihoc/bot-core/core`) để bot tự dùng. Các biến dưới đây thuộc về app.
:::

Quy ước cột: **Bắt buộc** nghĩa là thiếu thì tiến trình dừng ngay lúc khởi động (hoặc không làm được việc chính). **Mặc định** là giá trị code dùng khi biến không đặt. Cột **Đọc bởi**: `worker` là `worker/index.ts`, `mcp` là MCP server `mcp/tieulinh`, `kg-http` là `mcp/kg-http`, `plugin` là plugin OpenClaw, `bootstrap` là `openclaw/bootstrap.ts` và `sync-workspace.ts`.

Các biến dạng số được đọc bằng `Number()` mà không kiểm tra NaN: giá trị rác cho hành vi khó đoán.

## Itsaplan

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `ITSAPLAN_BASE_URL` | worker: có | mcp: `""` | worker, mcp, bootstrap | URL API itsaplan. |
| `ITSAPLAN_API_KEY` | worker: có | mcp: `""` | worker, mcp, bootstrap | Khoá admin itsaplan. Worker dùng nó cho việc quản trị hạ tầng (cấu hình webhook) và làm khoá dự phòng của agent key. |
| `ITSAPLAN_AGENT_KEY` | không | `ITSAPLAN_API_KEY` | worker, mcp | Khoá của bot. Thiếu thì `AgentRunnerService` của worker **không chạy** (chỉ log cảnh báo). |
| `ITSAPLAN_PROJECT_KEY` | không (xem ghi chú) | worker: không có; mcp: `TECH` | worker, mcp | Mã dự án. Worker khoá mọi đường xử lý theo mã này ([ADR-0001 Tiểu Linh](/explanation/adr-index)). Thiếu thì worker cảnh báo, xử lý sự kiện của mọi dự án, tắt KG/Onyx và không đăng ký webhook. |
| `ITSAPLAN_WEB_URL` | không | worker: `""` khi nạp Onyx, `https://itsaplan.example.com` ở vòng đời; mcp: không có | worker, mcp | Gốc link web hiển thị trong thông báo và tài liệu Onyx. |
| `ITSAPLAN_WEBHOOK_SECRET` | không | `""` | worker | Các `whsec_...` ngăn cách bằng dấu phẩy. Có thì `/webhook` bắt header `X-Itsaplan-Signature` hợp lệ; trống thì nhận không kiểm và chỉ cảnh báo. |
| `WEBHOOK_URL` | không | không có | worker, bootstrap | URL để tự đăng ký webhook itsaplan. Worker chỉ đăng ký khi có cả `ITSAPLAN_PROJECT_KEY` (không đoán `TECH`); `bootstrap` đăng ký cho dự án `TECH` cố định. |

Ghi chú về `ITSAPLAN_PROJECT_KEY`: worker chỉ `required` nó bên trong nhánh bật Onyx, và nhánh đó chỉ chạy khi cổng bật đã thoả (cổng bật thì biến này đã có).

## Telegram và kênh

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | worker: có | không có | worker, mcp, plugin | Token bot cho thông báo và nút bấm. MCP chỉ dùng gián tiếp (báo admin, tải file ảnh). |
| `TELEGRAM_BOT_TOKEN_TIEULINH` | không | không có | mcp, bootstrap | Token của Tiểu Linh; tải file ưu tiên biến này hơn `TELEGRAM_BOT_TOKEN`. `openclaw.json` gán nó cho `TELEGRAM_BOT_TOKEN` của MCP. |
| `TELEGRAM_WEBHOOK_SECRET` | không | không có | worker | Phải trùng `secret_token` đã khai lúc `setWebhook`. Có thì `/telegram-webhook` kiểm header `x-telegram-bot-api-secret-token` (sai: 401); trống thì nhận không kiểm và cảnh báo. |
| `ON_CALL_CHAT_ID` | không | không có | worker | Chat trực ca. Thiếu thì cảnh báo chỉ ghi log. |
| `ALERT_CHAT_ID` | không | phần tử đầu của `ADMIN_IDS` | mcp | Chat nhận báo động khi tool lỗi. Thiếu cả hai thì chỉ log. |
| `ADMIN_IDS` | không | `""` | mcp | ID Telegram của quản trị, ngăn cách bằng dấu phẩy. |
| `REQUIRE_APPROVAL` | không | không có | `.env.example`, `openclaw.json` | Có trong mẫu và được truyền cho MCP, nhưng code TypeScript hiện **không đọc** (cờ duyệt người dùng được đặt cứng `false`). Đừng trông chờ nó có tác dụng. |
| `OPENCLAW_STATE_DIR` | không | `~/.openclaw` | mcp | Thư mục trạng thái OpenClaw, để tìm `media/inbound` cho ảnh đính kèm. |
| `OPENCLAW_CONFIG_DIR` | không | `~/.openclaw` | plugin, bootstrap | Thư mục cấu hình OpenClaw (plugin đọc `openclaw.json` ở đây; `sync-workspace` lấy làm gốc workspace). |
| `OPENCLAW_CONFIG_PATH` | không | không có | plugin | Đường dẫn trực tiếp tới `openclaw.json`, ưu tiên cao nhất. |
| `OPENCLAW_BIN` | không | `/usr/local/bin/openclaw` nếu tồn tại, không thì `openclaw` | worker | Binary OpenClaw khi `OPENAI_API_STYLE=openclaw`. |
| `XAC_NHAN_XONG_WORKERS` | không | `iris-agent=http://127.0.0.1:3103` | plugin | Bảng `agent=url` (ngăn cách bằng dấu phẩy) cho plugin `xac-nhan-xong` biết gọi worker nào. Đặt biến thì **thay hoàn toàn** mặc định, không gộp. |

## Worker: webhook, vòng đời, hành vi

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `INTAKE_DB_PATH` | không | worker: `data/intake.db`; mcp: `data/tieulinh.db` | worker, mcp | File SQLite. Đường dẫn tương đối tính theo thư mục chạy, nên hai tiến trình dễ trỏ hai DB khác nhau: đặt đường dẫn tuyệt đối. |
| `WEBHOOK_PORT` | không | `3102` | worker | Cổng HTTP của webhook server. |
| `WEBHOOK_MAX_BODY_BYTES` | không | `1048576` | worker | Trần body mỗi request; vượt thì 413. |
| `LIFECYCLE_INTERVAL_MS` | không | `60000` | worker | Chu kỳ quét vòng đời. |
| `RUNNER_POLL_INTERVAL_MS` | không | `3000` | worker | Chu kỳ poll của `AgentRunnerService` (chỉ khi có `ITSAPLAN_AGENT_KEY`). |
| `AGENT_HANDLES` | không | dispatcher: `iris,vhiris_bot,iris-bot,intake,intake-bot`; runner: `tieulinh,vhticket_bot,intake` | worker | Các handle `@bot` được coi là bot. Đặt biến thì áp cho cả hai chỗ. |
| `COMMENT_FORWARD_POLICY` | không | `all` | worker | `mention`: chỉ đẩy comment có tag bot về người báo. Giá trị khác `mention` đều là `all` (mọi comment của người). |
| `DUPLICATE_MERGE` | không | bật | worker | Gộp ticket trùng khi người xử lý tuyên bố trùng. Chỉ `off` mới tắt; còn cần LLM đã cấu hình, thiếu LLM cũng tắt. |
| `TECH_INFO_REVIEW` | không | LLM review nếu có LLM | mcp | `checklist`: hỏi theo danh sách cố định, không LLM. `off`: tắt. Giá trị khác: dùng LLM nếu có. |
| `ASK_LEARN_DB` | không | không có | mcp | Kho "tự học" cho reviewer dạng `checklist`; chỉ dùng khi `TECH_INFO_REVIEW=checklist`. |
| `NOTIFY_ON_CALL_SUPPLEMENT` | không | tắt | mcp | `1` hoặc `true` bật báo kênh trực ca khi người báo bổ sung. Hiện **không có tác dụng thật**: chỉ chạy khi pipeline nhận `notifier`, mà không điểm nối nào truyền. |

Các endpoint worker phục vụ ở `WEBHOOK_PORT`:

| Đường dẫn | Phương thức | Ai gọi | Ghi chú |
|---|---|---|---|
| `/health`, `/` | GET | bất kỳ | Trả `{status:"ok"}`. |
| `/webhook` | POST | itsaplan | Kiểm chữ ký nếu có `ITSAPLAN_WEBHOOK_SECRET`; chống trùng theo sự kiện, issue, comment và `webhookTimestamp`. Xem [sự kiện webhook](/reference/webhook-events). |
| `/telegram-webhook` | POST | Telegram | Kiểm `secret_token` nếu có `TELEGRAM_WEBHOOK_SECRET`. |
| `/internal/reporter-ok` (và tên cũ `/internal/confirm-done`) | POST | chỉ loopback | Plugin ghi nhận người báo bấm "Đã ổn". Không đóng ticket. |
| `/internal/reporter-reply` | POST | chỉ loopback | Ghi phản hồi tự do của người báo thành comment. |
| `/internal/force-new` | POST | chỉ loopback | Đặt cờ buộc mở sự cố mới cho chat. |

Server của worker app lắng nghe không chỉ định host (mọi interface); "chỉ loopback" được kiểm theo địa chỉ nguồn của kết nối. Đừng mở cổng này ra internet khi chưa đặt secret. Server dựng sẵn trong bot-core (`ItsaplanWebhookServer`) khác ở chỗ mặc định bind `127.0.0.1` (xem [Dựng worker báo ngược](/how-to/notify-worker)).

## LLM

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `OPENAI_BASE_URL` | không | `""` | worker, mcp | Endpoint LLM. Cần có để LLM được coi là đủ cấu hình (trừ khi style là `openclaw`). |
| `OPENAI_API_KEY` | không | `""` | worker, mcp | Khoá LLM. |
| `OPENAI_MODEL` | không | `gpt-4o-mini` | worker, mcp | Tên model, hoặc nhiều model ngăn cách bằng dấu phẩy (model trước lỗi 5xx hoặc mạng thì thử model sau). |
| `OPENAI_API_STYLE` | không | `openai` | worker, mcp | `openai`, `anthropic` hoặc `openclaw`; giá trị lạ là `openai`. |

Thiếu cấu hình LLM thì các tính năng dùng LLM tắt chứ không làm bot chết.

## Onyx (tri thức ticket)

Onyx là tuỳ chọn: thiếu cấu hình thì bot vẫn chạy, chỉ không tích luỹ tri thức.

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `ONYX_BASE_URL` | không | worker: không có; mcp: `""` | worker, mcp | Có thì Onyx mới có cơ hội bật. |
| `ONYX_API_KEY` | không | `""` | worker, mcp | Khoá Onyx. MCP chỉ bật tìm tri thức khi có biến này. |
| `ONYX_SYNC_PROJECTS` | không | `TECH` | worker | Dự án được nạp Onyx, ngăn cách bằng dấu phẩy. `PO` bị chặn cứng (ADR-0002 Tiểu Linh) dù cấu hình thế nào. |
| `ONYX_DOC_PREFIX` | không | `ticket_` | worker | Tiền tố ID tài liệu Onyx. |
| `ONYX_PERSONA_ID` | không | `6` | mcp | Persona Onyx dùng khi tìm kiếm. |
| `ONYX_MCP_URL` | không | `<ONYX_BASE_URL>/mcp` | mcp | Endpoint MCP của Onyx. Không có trong `.env.example`. |
| `ONYX_CONNECTOR_NAME` | không | `FileConnector-IntakeTest-Done` | worker | Tên connector Onyx. |
| `ONYX_DOCUMENT_SET` | không | `intake-test-done` | worker | Tên document set Onyx. |
| `ONYX_CC_PAIR_ID` | không | không có | worker | cc-pair của set mặc định, số nguyên; chỉ dùng khi nơi gọi không truyền tên connector hoặc set riêng. |

## Knowledge Graph (Memgraph) và ticket tương tự

KG chỉ bật khi có `MEMGRAPH_URI` **và** dự án của worker nằm trong `KG_SYNC_PROJECTS` (mặc định rỗng là tắt; ADR-0003 Tiểu Linh).

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `MEMGRAPH_URI` | không | cổng bật: không có thì tắt; client: `bolt://localhost:7687` | worker, mcp, kg-http | URI bolt. Ở MCP, có biến này mới bật tra ticket tương tự. |
| `MEMGRAPH_USER` | không | `""` | worker, mcp, kg-http | User Memgraph. |
| `MEMGRAPH_PASS` | không | `""` | worker, mcp, kg-http | Mật khẩu Memgraph. |
| `KG_SYNC_PROJECTS` | không | `""` (tắt) | worker | Danh sách dự án được nạp KG, ngăn cách bằng dấu phẩy. |
| `KG_SYNC_MAX_ATTEMPTS` | không | `6` | worker | Số lần thử tối đa mỗi mục trong hàng đợi KG. |
| `KG_SYNC_RETRY_INTERVAL_MS` | không | `60000` | worker | Chu kỳ thử lại hàng đợi (KG và Onyx). |
| `KG_SIMILAR_PROJECT` | không | `ITSAPLAN_PROJECT_KEY` | mcp | Dự án mà kho KG dùng để tra ticket tương tự. |
| `RELATED_CURATOR` | không | `dry` | worker | Chốt ticket tương tự lúc người điều phối ghim nguyên nhân (ADR-0007 Tiểu Linh). `off` tắt, `on` ghi vào itsaplan, mọi giá trị khác (kể cả `dry` và gõ sai) chỉ log kế hoạch. |
| `RELATED_CURATOR_DELAY_MS` | không | `90000` | worker | Trì hoãn trước khi chốt. |
| `RELATED_RECHECK` | không | bật | worker | Tra lại ticket đang mở khi kho cụm đổi. Chỉ đúng chuỗi `off` mới tắt. Cần nguồn ticket tương tự (Onyx và LLM). |
| `RELATED_RECHECK_DAYS` | không | `14` | worker | Cửa sổ ticket được tra lại. |
| `RELATED_RECHECK_INTERVAL_MS` | không | `21600000` (6 giờ) | worker | Chu kỳ quét lại. |
| `RELATED_RECHECK_DEBOUNCE_MS` | không | `1800000` (30 phút) | worker | Debounce khi kho đổi. |
| `OLD_SIMILAR_ALGORITHM_UNTIL` | không | `2026-09-26T08:08:00Z` | worker | Mốc bỏ thuật toán ticket tương tự cũ: liên kết do thuật toán cũ ghi hàng loạt trước mốc này bị coi là rác. Đọc một lần lúc nạp module. |
| `SIMILAR_MAX_CANDIDATES` | không | `14` | worker, mcp | Số ứng viên tối đa. |
| `SIMILAR_LLM_CONCURRENCY` | không | `5` | worker, mcp | Số lời gọi LLM song song khi xác minh cặp. |
| `SIMILAR_TIMEOUT_MS` | không | `60000` | worker, mcp | Timeout tra ticket tương tự. |
| `SIMILAR_JUDGE_MODE` | không | `mechanism` | worker, mcp | `mechanism` hoặc `applicability`. Giá trị lạ không bị kiểm tra. |

### Server kg-http

`mcp/kg-http` là điểm vào MCP qua HTTP cho Onyx. Endpoint: `GET /health` và `/mcp` (cần Bearer token, so sánh theo thời gian hằng).

| Biến | Bắt buộc | Mặc định | Đọc bởi | Ý nghĩa |
|---|---|---|---|---|
| `KG_MCP_API_KEY` | có (trừ khi `KG_MCP_ALLOW_NO_AUTH=1`) | không có | kg-http | Bearer token mọi request tới `/mcp` phải mang. Thiếu thì server không khởi động. |
| `KG_MCP_ALLOW_NO_AUTH` | không | không có | kg-http | Đúng chuỗi `1` cho chạy không auth (chỉ dev). |
| `KG_MCP_HOST` | không | `127.0.0.1` | kg-http | Đặt `0.0.0.0` để mở LAN. |
| `KG_MCP_PORT` | không | `8933` | kg-http | Cổng HTTP. |

## Thiết lập webhook khi chạy

`WEBHOOK_URL` (xem bảng Itsaplan) làm worker gọi `ensureItsaplanWebhook`, hàm này bảo đảm webhook ở URL đó tồn tại, đang bật và đủ các sự kiện cần thiết. Đây là đường đăng ký của app Tiểu Linh. Worker dựng bằng `startIntakeWorker` của bot-core đi đường khác: nó sinh URL từ host và cổng thật (xem [Dựng worker báo ngược](/how-to/notify-worker)), nên không có biến `WEBHOOK_URL` rời.
