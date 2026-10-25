# Chuyển Tiểu Linh sang bot-core

::: tip Đã chuyển
Tiểu Linh đã chuyển sang bot-core trong monorepo (PR `refactor(tieulinh): adopt @vuihoc/bot-core`): `apps/tieulinh-legacy` dùng `"@vuihoc/bot-core": "workspace:*"`. Trang này ghi lại kết quả, những adapter còn giữ tại chỗ và lý do. Kế hoạch từng module trước khi chuyển đã lỗi thời nên không còn ở đây (xem lịch sử git, thư mục `adoption` cũ của package core). Cách chuyển một bot khác: [Chuyển bot sang bot-core](/how-to/adopt-core).
:::

Công thức đã được chứng minh trước khi có monorepo: harness
`packages/core/scripts/shadow-parity.ts` chép Tiểu Linh ra `$PARITY_SCRATCH`, thay 26 module
local bằng shim re-export từ thư viện, và chạy nguyên suite ra **862 pass / 27
skip / 0 fail** ([báo cáo parity](https://github.com/minhdevtry/ticket/blob/main/packages/core/docs/parity/REPORT.md)). Bản app trong monorepo mới hơn bản đó
(itsaplan v1.8, `stripCommentHtml`, `findIssueByIdentifier`, khoá dự án có chữ
số, TECH-1148...), nên khi chuyển thật phải so lại từng module.

## Kết quả

Mỗi nhóm là một commit riêng (`core` → `itsaplan` → `gate/intake` → `telegram/identity`).
Quy tắc: chỗ app đi trước thư viện thì ĐƯA hành vi mới vào `packages/core` (kèm
test), không bỏ.

**Thay hẳn bằng import từ thư viện** (file local bị xoá, call-site import thẳng
`@vuihoc/bot-core/<subpath>`):
`lib/logger`, `lib/onyx/pii-redactor`, `lib/storage/memo`,
`mcp/shared/{server,tool}` (`/core`); `lib/itsaplan/{client,project,status,ticket-state,sync-labels,ensure-webhook,attachments}`
và phần chung của `worker/project-lock` (`/itsaplan`); `lib/gate/{types,catalog,gate,normalize,recap,schema,buttons,validate}`
và engine `evaluatePriorityRules` (`/intake`); `lib/telegram/transport` (`/telegram`);
hàm thuần của `worker/webhook-server` (chữ ký, khoá dedupe, `isLoopback`, kiểu envelope).

**Giữ một adapter mỏng tại chỗ** (lý do trong ngoặc):
- `lib/tool-error.ts` — nối `setToolFailureAlert` vào `alertAdmin` (thư viện không có Telegram) và đặt `useDeclaredErrorCode: false`; `mcp/shared/index.ts` import nó.
- `lib/storage/lazy-db.ts` — `makeOpenLazyDb({ applySchema, onOpenError: "throw" })` (schema của bot; giữ hành vi ném khi file không mở được).
- `lib/formatting.local.ts` — `appendTicketUpdateDescription`, `isCommentRecentlyForwarded` (layout ticket và state worker), `stripBotMentions` với danh sách handle cũ.
- `lib/itsaplan/client-factory.ts` — `createItsaplanClient`: không retry, không timeout, body 2xx lỏng (xem bảng giữ hành vi).
- `lib/itsaplan/ensure-webhook.ts` — `ensureTieuLinhWebhook` với bộ sự kiện riêng của Tiểu Linh.
- `lib/itsaplan/upload.ts` — `uploadAttachments` cắm `MediaResolver` của bot (`resolveMediaFilePath`), không trần kích thước; `formatAttachmentMarkdown`/`spliceAttachmentsIntoDescription` không escape.
- `lib/channel-envelope.ts` — `stripChannelEnvelope` với hành vi intake cũ (thư viện cho tuỳ chọn).
- `worker/project-lock.ts` — chỉ còn `isTieuLinhProject`.
- `mcp/shared/tools/assess-priority.ts` — wrapper MCP + schema zod; engine từ thư viện.
- `lib/telegram/alert.ts` — mặt tiền `alertAdmin`/`configureAlerts` đọc env, dựng trên `Alerter`.
- `lib/telegram/buttons.ts` — catalog nút, `getLastActiveChatId`, thư mục `~/.vhbot/...`; ghi/xoá file nút và luật bỏ nút quá 64 byte từ `savePendingButtons`/`clearPendingButtons`.
- `lib/storage/identity-repository.ts` — adapter `telegramUserId` ⇄ `userId` trên `SqliteIdentityRepository`.
- `lib/gate/from-validation-rules.ts`, `lib/gate/catalog.fixture.ts` — dữ liệu và adapter riêng của bot.

**Không thay được / chỉ thay một phần** (ghi lý do, không ép):
- `lib/media.ts` — thư viện `telegram/media` nhận `inboundDir` tiêm vào, mặc định content-type `application/octet-stream`, không quét thư mục `openclaw-staged-*`, allow-list khác; còn app đọc env `OPENCLAW_STATE_DIR`, mặc định `image/png`, tải `getFile` từ Telegram. Chỉ lấy `sniffImageContentType` (giống hệt) từ thư viện.
- `lib/storage/identity.service.ts`, `mcp/shared/tools/identity.ts` — thư viện tách service không có chuỗi tiếng Việt; thay là đổi hợp đồng (xem `packages/core/scripts/parity-shims/a1-identity.ts`).
- `worker/webhook-server.ts` (class), `notification-dispatcher`, `notifier`, `ticket-closure`, `lib/intake-step/pipeline.ts`: như kế hoạch gốc (gắn schema/KG/Notifier của bot; pipeline chờ ticket 09).

**Đã đưa từ app vào thư viện** (CHANGELOG `Unreleased`): `isInternalCallbackToken`
(TECH-1148, `stripChannelEnvelope` bỏ `callback_data: noop`), `makeOpenLazyDb({ onOpenError })`,
`listProjectIssues({ page })`, `listComments` có kiểu, `ensureItsaplanWebhook(..., { events })`,
sửa `resolveFriendlyStatusName("")`; cộng test cho `isLoopback`, lỗi tool → `loi`,
chính sách lỗi transport / multipart / tải file.

**Nguyên tắc giữ hành vi (vòng review thứ hai):** Tiểu Linh là baseline đóng băng, nên thư viện
có thể giữ mặc định tốt hơn nhưng bot phải truyền tuỳ chọn tường minh để cư xử như bản cũ.
Mỗi tuỳ chọn có test ở `packages/core` (mặc định) và ở `apps/tieulinh-legacy` (adapter).

| Hành vi | Mặc định thư viện | Tiểu Linh (tuỳ chọn) |
|---|---|---|
| `ItsaplanClient` timeout | 20 s/request | `timeoutMs: 0` = không timeout (`createItsaplanClient`, `maxRetries: 0` giữ nguyên) |
| 2xx body rỗng / không phải JSON | ném `ItsaplanMalformedResponseError` | `strictResponses: false` → `{}` / chuỗi như cũ |
| `ensureItsaplanWebhook` | bật lại webhook tắt tại chỗ, trỏ lại webhook cùng host lệch cổng | `reactivateDisabled: false`, `repointSameHost: false` (khớp URL chính xác; tắt thì xoá-tạo lại) + 4 sự kiện cũ |
| `stripChannelEnvelope` | giữ khối JSON phong bì chiếm trọn tin, giữ chữ sau khối, bỏ ``` dán | `lib/channel-envelope.ts`: `keepSoleEnvelopeBlock`, `keepTextAfterEnvelopeBlock`, `stripPastedEnvelopeFences` đều `false` (TECH-922) |
| `uploadAttachments` | trần 20 MB | `maxBytes: Infinity` |
| `formatAttachmentMarkdown` / splice | escape tên file và URL | `escape: false` (wrapper trong `lib/itsaplan/upload.ts`) |
| `stripBotMentions` | gồm `cmsupport` và mọi `@\w+_bot` | `knownHandles` không có `cmsupport`, `stripBotSuffixHandles: false` |
| mã lỗi tool (`describeToolFailure`) | dùng `err.code` tự khai | `useDeclaredErrorCode: false` → luôn mã thời gian duy nhất |

Thay đổi áp dụng cho CẢ thư viện (chủ ý): `saveUserIdentity` dùng `||` thay `??` (chuỗi rỗng
không ghi đè giá trị đã lưu, giống intake).

**Khác biệt hành vi còn lại** (đã chấp nhận, không có trong parity cũ):
- `TelegramTransport`: lỗi form-data có chữ `(form-data)` bị bỏ; 429 không thử lại (`maxRetries: 0`) ở cả 3 nơi dựng.
- `verifyItsaplanSignature`: secret rỗng bị bỏ qua (cũ vẫn thử HMAC với khoá rỗng).
- `clearPendingButtons`: không còn log cảnh báo khi xoá file lỗi.
- `listPendingIdentities`: trả thêm `department`.
- Thông báo `alertAdmin` khi nút quá 64 byte / ghi file nút hỏng: câu chữ do thư viện sinh (khoá chống lặp giữ nguyên).
- `uploadAttachments` vẫn bỏ qua đường dẫn không phải file thường (chỉ bỏ trần kích thước).

**Số test** (chạy trên máy ngoài): trước app 1019 pass / 27 skip / 0 fail, core 517 pass;
sau app 911 pass / 27 skip / 0 fail, core 562 pass. Test trùng với core được xoá, test
của hành vi đưa vào thư viện được chuyển sang `packages/core`.
