# Chuyển Bot CM (teacheragent) sang `@vuihoc/bot-core`

Bot thật: `<path-to>/teacheragent` (mọi file dưới `cm/`).
CHỈ ĐỌC — tài liệu mô tả việc chủ bot sẽ làm. Không sửa, không chạy gì trong repo
đó. Phân tích dựa trên research `teacheragent.md` (đọc file thật, read-only).

CM được dựng bằng **chép tay** từ Tiểu Linh chứ không import (DESIGN.md §1.1:
"Đứng riêng, thừa hưởng đủ … Không import, không chạy chung … Code thừa hưởng
được sao chép"). Mọi file chép đều đã trôi dạt — không bản nào còn giống bản gốc
(research §2.1/§5) — nên chuyển sang thư viện là cách gom các bản sửa lạc nhau về
một chỗ.

## File forked trong CM → module thư viện

| File trong CM (`cm/`) | Module thư viện | Ghi chú (từ research §2.1/§2.2) |
|---|---|---|
| `lib/logger.ts` (128) | `@vuihoc/bot-core/core` logger | CM lớn hơn 3× vì thêm `redactSecrets` + trace id. Thư viện core đã có `redactSecrets` (`src/core/logger.ts` export). Kiểm trace-id còn giữ. |
| `lib/tool-error.ts` (87) | `@vuihoc/bot-core/core` tool-error | **Drift hai chiều.** CM có `CodedError`/`errorCodeFor()` (mã `E_TICKET_RATE_LIMITED`); intake có hook alert. Thư viện hợp cả hai: export `CodedError`, `errorCodeFor`, `newErrorCode`, `setToolFailureAlert` (`src/core/index.ts`). |
| `lib/channel-envelope.ts` (252) | `@vuihoc/bot-core/core` channel-envelope | CM >2× intake; thư viện export `stripChannelEnvelope` + `extractChannelEnvelope`. Đối chiếu nhánh CM thêm. |
| `lib/formatting.ts` (338) | `@vuihoc/bot-core/core` formatting | Near-copy diverged 478 dòng. Thư viện đã gộp phần CM-only: `formatIctDate`, `foldForComparison`/`looseIncludes`, luật `stripBotMentions` bỏ `@<tên>_bot` (`src/core/formatting.ts` header). |
| `lib/http-client.ts` (173) | `@vuihoc/bot-core/itsaplan` `./http` | CM-only (retry/429). Thư viện itsaplan đã mang retry/429 qua `./http` + `isRetryableItsaplanError` (`src/itsaplan/index.ts`). |
| `lib/itsaplan/client.ts` (671) | `@vuihoc/bot-core/itsaplan` client | **Drift fix.** Thư viện = hợp của CM (`ItsaplanApiError`, `ItsaplanMalformedResponseError`, `isRetryableItsaplanError`) + intake (field/column metadata, `stateType`, 5bf501e). |
| `lib/itsaplan/{status,project,attachments,ticket-state,sync-labels,ensure-webhook}.ts` | `@vuihoc/bot-core/itsaplan` | Near-copy diverged; thư viện là hợp. `ticket-state`/`sync-labels` gần như trùng (research §2.2). |

## Code CM-only — Ở LẠI trong bot

Thư viện cố ý bỏ ngoài (research §3; spec §Kept out of the library). Giữ nguyên:

- `lib/itsaplan/sync.ts` (1114) — `ItsaplanSyncAdapter` riêng CMSUPPORT; `fields.ts`,
  `names.ts` (domain CM).
- `lib/domain/*` (ticket, pending-confirmation, broadcast, handover, assignment,
  teacher, outbox, faq, user-role …) — mô hình nghiệp vụ CM.
- `cm/admin/*` (~7.2k LOC portal), `cm/reports/*`, worker CM-only
  (`broadcast-dispatcher`, `outbox-dispatcher`, `event-mapper`, `gv-templates` …).
- `mcp/server.ts` (2239, 25 tool CM) — viết lại hẳn, không trùng file với intake.

## Luật dấu comment (bắt buộc với CM)

CM **phải** gọi `setBotCommentMarker('<!-- cm-bot -->')` lúc khởi động trước khi
ghi comment đầu tiên (`src/core/formatting.ts`). Mặc định thư viện là
`<!-- intake-bot -->`; nếu CM không đổi, dispatcher CM sẽ coi comment của chính
bot là của NGƯỜI (vòng echo) hoặc worker intake nhận nhầm dấu. Phía nhận diện
hiểu cả hai dấu qua `LEGACY_BOT_COMMENT_MARKERS`; chỉ phía GHI cần đặt lại.

## Quyết định "copy-not-import" (DESIGN §1.1) và pin tag

DESIGN §1.1 chọn chép-không-import để CM **đứng riêng, tự quyết, không gãy theo
bot khác**. Pin theo tag (ADR-0001) GIỮ ĐÚNG tinh thần đó mà bỏ được cái giá của
chép tay: CM vẫn độc lập (một tag cố định, nâng khi CM muốn, một bot nâng không
đụng bot khác — spec User Story 2), nhưng bản sửa không còn kẹt ở một bản sao.
Khác biệt duy nhất với §1.1: nguồn chung giờ là một tag thay vì bản chép. Theo
spec §Implementation ("CM's own fixes merged into the library before CM
migrates"), các fix drift của CM đã được gộp vào thư viện TRƯỚC khi CM chuyển, nên
migrate không mất fix nào.

## Cách kiểm (chủ bot tự đo baseline TRƯỚC)

CM có **289** file `*.test.ts` (research §4). Thư viện KHÔNG được chạy suite CM —
đó là repo thật, chỉ đọc. Gợi ý quy trình cho chủ bot:

1. Chủ bot tự chạy `bun test` trong `cm/` ở trạng thái hiện tại để **đo baseline
   của chính CM** (con số này do chủ bot đo, không phải 862/27/0 của intake).
2. Chuyển từng module theo thứ tự `core → itsaplan`, chạy lại suite sau mỗi bước,
   so với baseline vừa đo.
3. Bật preload chặn gọi dịch vụ thật (README §4; CM dùng `CM_ITSAPLAN_API_KEY`,
   `CM_TELEGRAM_BOT_TOKEN` — đã có trong danh sách scrub của `test-preload`).

## Ngoài phạm vi

Thay module pending-confirmation của CM bằng engine confirm của thư viện là việc
sau, cần thiết kế lại theo schema CM — **ngoài phạm vi** lần này (spec §Out of
Scope). CM dùng tới `core` + `itsaplan`, không dùng `intake` engine lúc này.

**Ẩn chi tiết lỗi kỹ thuật khỏi người dùng (0.4.2):** bản gốc CM đã bỏ dòng chi tiết
kỹ thuật khỏi tin báo lỗi cho người dùng. Thư viện giữ được điều đó: gọi một lần lúc
khởi động `setToolFailureOptions({ hideDetailFromUser: true })` (từ `@vuihoc/bot-core/core`).
Mặc định là `false` (theo intake), nên CM phải bật rõ ràng. Khi bật, người dùng chỉ thấy
mã lỗi và lời dặn chụp màn hình; `chi_tiet` và log vẫn giữ đủ cho kỹ thuật tra ngược.
