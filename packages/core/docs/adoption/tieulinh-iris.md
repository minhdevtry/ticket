# Chuyển Tiểu Linh / Iris (intake-agents) sang `@vuihoc/bot-core`

Bot thật: `<path-to>/intake-agents` (mọi file dưới `intake/`).
CHỈ ĐỌC — tài liệu này mô tả việc chủ bot sẽ làm, không sửa gì trong repo đó.

Công thức đã được chứng minh: harness `scripts/shadow-parity.ts` chép Tiểu Linh
ra `$PARITY_SCRATCH`, thay 26 module local bằng shim re-export từ thư viện, và
chạy nguyên suite ra **862 pass / 27 skip / 0 fail** — đúng baseline
(`docs/parity/REPORT.md`). Mỗi dòng dưới là một shim thật trong harness đó.

## Bảng chuyển theo module

Mỗi hàng: file trong bot → import thư viện → có cần adapter không.
Nguồn adapter: `scripts/shadow-parity.ts` (bảng `SHIMS`).

| File trong bot (`intake/`) | Import từ thư viện | Adapter? |
|---|---|---|
| `lib/logger.ts` | `@vuihoc/bot-core/core` | Không — re-export thẳng |
| `lib/tool-error.ts` | `@vuihoc/bot-core/core` | **Có** — gọi `setToolFailureAlert((k,m)=>alertAdmin(k,m))` để giữ cảnh báo admin của intake (thư viện không có Telegram) |
| `mcp/shared/server.ts` | `@vuihoc/bot-core/core` | Không — re-export `createIntakeMcpServer`/`runOnStdio`/`runOnHttp` + type |
| `mcp/shared/tool.ts` | `@vuihoc/bot-core/core` | Không |
| `lib/onyx/pii-redactor.ts` | `@vuihoc/bot-core/core` | Không — `redactIncidentPII` |
| `lib/channel-envelope.ts` | `@vuihoc/bot-core/core` | Không — thư viện là superset (thêm `extractChannelEnvelope`) |
| `lib/formatting.ts` | `@vuihoc/bot-core/core` | **Có** — tách: hàm chung lấy từ thư viện; hàm riêng intake (`appendTicketUpdateDescription`, `isCommentRecentlyForwarded`) giữ trong `formatting.local.ts` |
| `lib/storage/lazy-db.ts` | `@vuihoc/bot-core/core` | Không — `openLazyDb` (thư viện có thêm `makeOpenLazyDb`) |
| `lib/storage/memo.ts` | `@vuihoc/bot-core/core` | Không — `memoByKey`/`memoByPath` |
| `worker/project-lock.ts` | `@vuihoc/bot-core/itsaplan` | Không — `normalizeProjectKey`/`projectOfIdentifier`/`identifierInProject` |
| `lib/itsaplan/client.ts` | `@vuihoc/bot-core/itsaplan` | Không — `export *` |
| `lib/itsaplan/project.ts` | `@vuihoc/bot-core/itsaplan` | Không |
| `lib/itsaplan/status.ts` | `@vuihoc/bot-core/itsaplan` | Không |
| `lib/itsaplan/attachments.ts` | `@vuihoc/bot-core/itsaplan` | Không |
| `lib/itsaplan/ticket-state.ts` | `@vuihoc/bot-core/itsaplan` | Không |
| `lib/itsaplan/sync-labels.ts` | `@vuihoc/bot-core/itsaplan` | Không |
| `lib/itsaplan/ensure-webhook.ts` | `@vuihoc/bot-core/itsaplan` | Không |
| `lib/gate/{types,catalog,gate,normalize,recap,schema,buttons,validate}.ts` | `@vuihoc/bot-core/intake` | Không — `export *` từ `intake/gate` |
| `mcp/shared/tools/assess-priority.ts` | `@vuihoc/bot-core/intake` | **Có** — giữ wrapper MCP `assessPriority` tại chỗ, ủy quyền engine `evaluatePriorityRules` + types cho thư viện |

Ba adapter trên là toàn bộ chỗ cần sửa call-site; 23 module còn lại là re-export
thuần. Thư viện là superset trung thực của intake, không cần ticket sửa thư viện
(`docs/parity/REPORT.md` §Library behaviour differences).

### Bổ sung 0.3.0 (nhánh `feat/telegram-media`) — Telegram, media, webhook

Thêm 5 module đã qua parity (tổng 31, bản sao vẫn 862/27/0). Shim chính xác nằm ở
`scripts/parity-shims/12-telegram.ts` và `14-notify.ts`; mỗi shim giữ phần riêng của
bot trong file `.local.ts` cạnh nó (`preserveAs`).

| File trong bot | Import thư viện | Phần ở lại bot |
|---|---|---|
| `lib/telegram/transport.ts` | `@vuihoc/bot-core/telegram` (`TelegramTransport`) | nạp token từ env |
| `lib/telegram/buttons.ts` | `@vuihoc/bot-core/telegram` (send an toàn, pending buttons) | catalog nút từng bot, `getLastActiveChatId`, thư mục `~/.vhbot/...` |
| `lib/telegram/alert.ts` | `@vuihoc/bot-core/telegram` (`Alerter`) | facade `alertAdmin`/`configureAlerts` đọc env |
| `lib/media.ts` | `@vuihoc/bot-core/telegram` (media finder) | tải `getFile` trực tiếp (cần token + mạng) |
| `worker/webhook-server.ts` (hàm thuần) | `@vuihoc/bot-core/itsaplan` (webhook) | class server có trạng thái |

`notification-dispatcher.ts`, `notifier.ts`, `ticket-closure.ts` chưa thay được: chúng
gắn với schema intake, Notifier và KG. Thư viện mang luật của chúng (`intake/notify`),
nhưng chuyển sang là đổi cách khởi tạo — làm khi chủ bot quyết, kèm chạy lại suite.

## Thứ tự chuyển an toàn

Theo chiều phụ thuộc `core ← itsaplan ← intake` (spec §Implementation):

1. **core** trước: `logger`, `tool-error` (+adapter alert), `mcp/shared/*`,
   `pii-redactor`, `channel-envelope`, `formatting` (+tách local), `storage/*`.
2. **itsaplan**: 7 module `lib/itsaplan/*` + `worker/project-lock.ts`.
3. **intake**: `lib/gate/*` rồi `assess-priority` (+adapter engine).

Mỗi bước chạy lại suite trước khi sang bước sau.

## Cách kiểm

Suite của chính Tiểu Linh phải giữ **862/27/0**. Dùng chính
`scripts/shadow-parity.ts` (nó chép repo ra scratch, không chạm bản thật) hoặc,
khi chủ bot quyết migrate thật, chạy `bun test .` trong `intake/` sau mỗi bước và
so với baseline. Preload `test-preload` phải bật để test không chạm dịch vụ thật.

## Dấu comment & giữ nguyên mặc định

Tiểu Linh/Iris giữ dấu mặc định `<!-- intake-bot -->` — KHÔNG gọi
`setBotCommentMarker`. Đây là lý do thư viện chọn dấu này làm mặc định
(`src/core/formatting.ts`): worker intake (kg-sync, duplicate-merger, notifier)
chỉ nhận đúng dấu đó.

## Code intake-only — Ở LẠI trong bot, KHÔNG vào thư viện

Những phần này là bot-specific, thư viện cố tình để ngoài (spec §Kept out of the
library; research `intake-agents.md` §3c). Giữ nguyên trong bot:

- **KG / Onyx**: `lib/kg/*`, `lib/onyx/*` (trừ `pii-redactor`), `worker/kg-sync*`,
  similar-ticket (ADR-0002/0003/0004/0007).
- **`lib/gate/from-validation-rules.ts`**: adapter JSON legacy của Tiểu Linh
  (`FIELD_PROMPT_LABELS`, `DEFAULT_SYNONYMS`, product mapping VH) — hàng này KHÔNG
  nằm trong 26 shim, cố ý giữ lại.
- **`appendTicketUpdateDescription`, `isCommentRecentlyForwarded`**: layout
  "### Mô tả / Thông tin sự cố" và state toàn cục của worker intake — ở
  `formatting.local.ts` cạnh shim.
- **Egress Telegram**: `lib/telegram/*` (transport, buttons ghi `~/.vhbot/...`,
  alert) và `lib/media.ts` (quét media Telegram inbound).
- **Worker**: toàn bộ `worker/*` (webhook-server, notifier, lifecycle,
  ticket-closure, ingest, kg-sync, duplicate-merger, related-*).
- **Domain**: `mcp/tieulinh/*`, `mcp/iris/*` (ticketDomain/briefDomain,
  formatter, taxonomy, JSON).

## Engine intake-step — HOÃN theo ticket 09

`lib/intake-step/pipeline.ts` (1864 LOC — xương sống hội thoại: ngân sách hỏi
lại, park xung đột định danh, router ADR-0008) đang được tách thành engine chung
ở `src/intake` (ports + copy-catalog + draft + confirm + create + adapter,
`src/intake/index.ts`). Phần CHUYỂN pipeline sang engine thư viện **chưa chốt —
pending ticket 09**. Trước khi 09 xong, pipeline ở lại trong bot nguyên trạng;
19 module trên vẫn chuyển được độc lập mà không đụng pipeline.
