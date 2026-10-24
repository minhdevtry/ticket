# Chuyển Tiểu Linh / Iris (intake-agents) sang `@vuihoc/bot-core`

> **Trạng thái: ĐÃ CHUYỂN trong monorepo `ticket`** (PR `refactor(tieulinh): adopt
> @vuihoc/bot-core`, `apps/tieulinh` dùng `"@vuihoc/bot-core": "workspace:*"`).
> Phần "Kết quả chuyển thật" ngay dưới ghi những gì đã làm và chỗ lệch so với kế
> hoạch; bảng và các mục phía sau là kế hoạch gốc, giữ lại để đối chiếu.

Công thức đã được chứng minh trước khi có monorepo: harness
`scripts/shadow-parity.ts` chép Tiểu Linh ra `$PARITY_SCRATCH`, thay 26 module
local bằng shim re-export từ thư viện, và chạy nguyên suite ra **862 pass / 27
skip / 0 fail** (`docs/parity/REPORT.md`). Bản app trong monorepo mới hơn bản đó
(itsaplan v1.8, `stripCommentHtml`, `findIssueByIdentifier`, khoá dự án có chữ
số, TECH-1148...), nên khi chuyển thật phải so lại từng module.

## Kết quả chuyển thật

Mỗi nhóm là một commit riêng (`core` → `itsaplan` → `gate/intake` → `telegram/identity`).
Quy tắc: chỗ app đi trước thư viện thì ĐƯA hành vi mới vào `packages/core` (kèm
test), không bỏ.

**Thay hẳn bằng import từ thư viện** (file local bị xoá, call-site import thẳng
`@vuihoc/bot-core/<subpath>`):
`lib/logger`, `lib/channel-envelope`, `lib/onyx/pii-redactor`, `lib/storage/memo`,
`mcp/shared/{server,tool}` (`/core`); `lib/itsaplan/{client,project,status,ticket-state,sync-labels,ensure-webhook,attachments}`
và phần chung của `worker/project-lock` (`/itsaplan`); `lib/gate/{types,catalog,gate,normalize,recap,schema,buttons,validate}`
và engine `evaluatePriorityRules` (`/intake`); `lib/telegram/transport` (`/telegram`);
hàm thuần của `worker/webhook-server` (chữ ký, khoá dedupe, `isLoopback`, kiểu envelope).

**Giữ một adapter mỏng tại chỗ** (lý do trong ngoặc):
- `lib/tool-error.ts` — nối `setToolFailureAlert` vào `alertAdmin` (thư viện không có Telegram); `mcp/shared/index.ts` import nó.
- `lib/storage/lazy-db.ts` — `makeOpenLazyDb({ applySchema, onOpenError: "throw" })` (schema của bot; giữ hành vi ném khi file không mở được).
- `lib/formatting.local.ts` — `appendTicketUpdateDescription`, `isCommentRecentlyForwarded` (layout ticket và state worker).
- `lib/itsaplan/client-factory.ts` — `createItsaplanClient` tắt retry (xem Khác biệt hành vi).
- `lib/itsaplan/ensure-webhook.ts` — `ensureTieuLinhWebhook` với bộ sự kiện riêng của Tiểu Linh.
- `lib/itsaplan/upload.ts` — `uploadAttachments` cắm `MediaResolver` của bot (`resolveMediaFilePath`).
- `worker/project-lock.ts` — chỉ còn `isTieuLinhProject`.
- `mcp/shared/tools/assess-priority.ts` — wrapper MCP + schema zod; engine từ thư viện.
- `lib/telegram/alert.ts` — mặt tiền `alertAdmin`/`configureAlerts` đọc env, dựng trên `Alerter`.
- `lib/telegram/buttons.ts` — catalog nút, `getLastActiveChatId`, thư mục `~/.vhbot/...`; ghi/xoá file nút và luật bỏ nút quá 64 byte từ `savePendingButtons`/`clearPendingButtons`.
- `lib/storage/identity-repository.ts` — adapter `telegramUserId` ⇄ `userId` trên `SqliteIdentityRepository`.
- `lib/gate/from-validation-rules.ts`, `lib/gate/catalog.fixture.ts` — dữ liệu và adapter riêng của bot.

**Không thay được / chỉ thay một phần** (ghi lý do, không ép):
- `lib/media.ts` — thư viện `telegram/media` nhận `inboundDir` tiêm vào, mặc định content-type `application/octet-stream`, không quét thư mục `openclaw-staged-*`, allow-list khác; còn app đọc env `OPENCLAW_STATE_DIR`, mặc định `image/png`, tải `getFile` từ Telegram. Chỉ lấy `sniffImageContentType` (giống hệt) từ thư viện.
- `lib/storage/identity.service.ts`, `mcp/shared/tools/identity.ts` — thư viện tách service không có chuỗi tiếng Việt; thay là đổi hợp đồng (xem `scripts/parity-shims/a1-identity.ts`).
- `worker/webhook-server.ts` (class), `notification-dispatcher`, `notifier`, `ticket-closure`, `lib/intake-step/pipeline.ts`: như kế hoạch gốc (gắn schema/KG/Notifier của bot; pipeline chờ ticket 09).

**Đã đưa từ app vào thư viện** (CHANGELOG `Unreleased`): `isInternalCallbackToken`
(TECH-1148, `stripChannelEnvelope` bỏ `callback_data: noop`), `makeOpenLazyDb({ onOpenError })`,
`listProjectIssues({ page })`, `listComments` có kiểu, `ensureItsaplanWebhook(..., { events })`,
sửa `resolveFriendlyStatusName("")`; cộng test cho `isLoopback`, lỗi tool → `loi`,
chính sách lỗi transport / multipart / tải file.

**Khác biệt hành vi còn lại** (đều đã chấp nhận, không có trong parity cũ):
- `ItsaplanClient`: thư viện có timeout 20 s mỗi request (app cũ không có), lỗi là `ItsaplanApiError`
  (cùng chuỗi `Itsaplan API error: <status> (<path>) - ...`), 2xx body rỗng/không phải JSON ném
  `ItsaplanMalformedResponseError` thay vì trả `{}`/chuỗi. Retry 429/5xx của thư viện bị TẮT
  qua `createItsaplanClient` (retry POST có thể tạo ticket/comment trùng).
- `formatAttachmentMarkdown`/`uploadAttachments`: tên file và URL được escape (`_` → `\_`, `&`/khoảng trắng → `&#NN;`),
  bỏ qua file > 20 MB hoặc không phải file thường.
- `ensureItsaplanWebhook`: webhook đang tắt được bật lại tại chỗ (giữ id/secret) thay vì xoá-tạo-lại; webhook cùng host
  lệch cổng được trỏ lại thay vì đẻ thêm. Bộ sự kiện giữ nguyên 4 sự kiện cũ (không có `issue.created`).
- `TelegramTransport`: lỗi form-data có chữ `(form-data)` bị bỏ; 429 không thử lại (`maxRetries: 0`) ở cả 3 nơi dựng.
- `verifyItsaplanSignature`: secret rỗng bị bỏ qua (cũ vẫn thử HMAC với khoá rỗng).
- `clearPendingButtons`: không còn log cảnh báo khi xoá file lỗi.
- `listPendingIdentities`: trả thêm `department`.
- Thông báo `alertAdmin` khi nút quá 64 byte / ghi file nút hỏng: câu chữ do thư viện sinh (khoá chống lặp giữ nguyên).

**Số test** (chạy trên máy ngoài): trước app 1019 pass / 27 skip / 0 fail, core 517 pass;
sau app 893 pass / 27 skip / 0 fail, core 540 pass. Test trùng với core được xoá, test
của hành vi đưa vào thư viện được chuyển sang `packages/core`.

---

# Kế hoạch gốc (trước khi chuyển)

Bot thật: `<path-to>/intake-agents` (mọi file dưới `intake/`).
CHỈ ĐỌC — phần dưới mô tả việc chủ bot sẽ làm, không sửa gì trong repo đó.

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
