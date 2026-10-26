# Báo cáo kết quả công việc: PR 11 — Lệnh nhắm vào ticket đã có (Issue #25)

## 1. Đã làm gì (theo từng mục của đặc tả)

- **D1 (Tìm ứng viên)**:
  - Nhận diện mã ticket trực tiếp qua `mentionedIdentifiers`.
  - Nhận diện số trần (`/(?<!\d)(\d{3,5})(?!\d)/g`) với ràng buộc bảo mật: chỉ tính khi khớp mã một ticket của chính người báo (`allBindings.some(...)`).
  - Nhận diện ticket vừa tạo (`justCreated`) trong cửa sổ 24 giờ (`JUST_CREATED_WINDOW_MS = 24 * 3_600_000`) khi có mã ticket khác được nhắc để phục vụ `move_created`.
  - Nhận diện ticket kỹ thuật vừa hỏi (`recentlyRelayed`, `techQuestion`) qua message routes (`getLatestMessageRouteForChat` với `kind === "comment"`, trong 72 giờ: `TECH_QUESTION_WINDOW_MS = 72 * 3_600_000`); loại trừ khi đang soạn dở tờ khai có mô tả và loại trừ ticket đã đóng.
  - Cắt trần danh sách ứng viên tối đa 4.
- **D2 (Đọc lệnh LLM & Không LLM, TECH-1218)**:
  - Đọc lệnh có LLM qua `LlmTicketCommandInterpreter` và fallback tất định không LLM qua `stripSupplementCommandWrapper` và `classifyCancelOrCloseIntent`.
  - Lọc sớm tin cảm ơn / chitchat / từ chối / huỷ chung chung khi không nhắc mã để không ghi nhầm vào ticket.
  - Xử lý câu lệnh trần chưa có nội dung (TECH-1218, ví dụ `update vào tick TECH-1218`): trả về outcome `clarify` (legacy `clarify_intent`), đính kèm nút "Huỷ" (`button.cancel_action`), hỏi xin ảnh chụp màn hình hoặc nội dung chi tiết.
- **D3 (Tra cứu ticket & phân quyền hiển thị ADR-0008 §6)**:
  - Ticket của mình (`ownTicket === true`): hiển thị tiêu đề, tên cột trạng thái trên dự án, và trao đổi gần nhất của kỹ thuật viên (`lastTechComment`).
  - Ticket của người khác (`ownTicket === false`): CHỈ hiển thị tên cột trạng thái, giấu kín tiêu đề và trao đổi kỹ thuật.
- **D4 (Bản xem trước & ma trận 8 trạng thái phản hồi ADR-0008)**:
  - Hỗ trợ xem trước cho các thao tác `append`, `edit`, `move_created`.
  - Hàng nút gồm nút xác nhận (`✅ Bổ sung vào TECH-X` / `✅ Sửa TECH-X` / `✅ Chuyển sang TECH-X`) + nút `Huỷ` (`button.cancel_action`) (hoặc `Sự cố mới` khi là `suggest`).
  - Xử lý ma trận 8 trạng thái trong `resolvePendingAction`: so khớp nút chuẩn hoá qua `foldButton`; gộp nội dung và ảnh khi đang chờ; bảo toàn payload ảnh/chữ sang lượt định tuyến tiếp theo khi người báo gửi ảnh trước rồi gõ lệnh bổ sung.
- **D5 (Sửa ticket & kiểm nền Optimistic Concurrency Check ADR-0008 §5)**:
  - Module `edit.ts`: `planEdit` sinh danh sách `EditOp[]`, hàm thuần tất định `applyEditOps` áp các thao tác sửa tiêu đề, trường `Thông tin sự cố`, hoặc câu trong mô tả; ghi nhận thay đổi và thao tác bị từ chối `rejected`.
  - Kiểm tra xung đột nền khi bấm xác nhận: so sánh `baseTitle` và `baseDescription` (chuẩn hoá `trimEnd()`) với trạng thái mới nhất từ tracker; từ chối sửa nếu ticket bị cập nhật trong lúc chờ; nếu nền không đổi, cập nhật tracker và ghi comment dấu vết `✏️` (`markBotComment`).
- **D6 (Chuyển ticket vừa tạo nhầm sang ticket khác ADR-0008 §7)**:
  - Hàm thuần `descriptionBody`: tách phần mô tả chính và danh sách URL ảnh markdown.
  - Khi xác nhận: chép comment nội dung sang ticket đích, tạo liên kết trùng `duplicates` trên tracker, ghi comment ghi chú trên ticket nguồn, chuyển ticket nguồn sang cột `Canceled` và huỷ tờ khai nguồn.
- **D7 (Quyền sở hữu Ownership)**:
  - Cổng `createOwnershipPort`: hỗ trợ kiểm tra sở hữu kép qua bản ghi binding của chat VÀ qua quy ước chứa Telegram ID trong mô tả ticket (cho ticket bot cũ).
  - Từ chối mọi thao tác ghi vào ticket người khác bằng outcome `not_owner` (legacy `post_create_update`), không lộ preview, ngăn chat khác bấm hộ nút xác nhận.
- **D9 (Tra cứu tiến độ không nêu mã)**:
  - Hàm `isProgressInquiry`: nhận diện câu hỏi tiến độ tự nhiên không kèm mã.
  - Tự động tra cứu ticket gần nhất của chat qua `getLatestBinding` trong cửa sổ 30 phút (`LOOKUP_WINDOW_MS = 30 * 60_000`); quá 30 phút hoặc không có ticket thì hỏi xin mã ticket cụ thể (`outcome: "clarify"`).
- **Hợp đồng CopyKey & Không hardcode**:
  - Khai báo đầy đủ các khoá `lookup.*`, `action.*`, `comment.*` trong `ports.ts` và triển khai trong `test-copy.fixture.ts` và `examples/tieulinh/copy.ts`.
  - 100% câu chữ gửi người dùng và comment hệ thống đều đi qua `CopyCatalog` và options cấu hình; core không hardcode tiếng Việt hay tên app/bot.
- **Sổ đối chiếu & Parity**:
  - Chuyển đúng 28 dòng legacy sang `ported` trong `apps/tieulinh/receptionist-gap-register.test.ts`.
  - Cập nhật số liệu parity trong `packages/core/docs/parity/ENGINE.md`: `ported` tăng lên 174, `deferred` giảm về 204 (PR 11 còn 0 dòng).
  - Cập nhật `packages/core/CHANGELOG.md` và `docs/rfc/0002-receptionist.md`.

## 2. File nào đổi

- Tạo mới:
  - `packages/core/src/intake/engine/text.test.ts`
  - `packages/core/src/intake/engine/edit.ts`
  - `packages/core/src/intake/engine/edit.test.ts`
  - `packages/core/src/intake/engine/command-interpreter.ts`
  - `packages/core/src/intake/engine/ownership-confirm.test.ts`
  - `packages/core/src/intake/engine/pr11-ticket-commands.test.ts`
- Cập nhật:
  - `packages/core/src/intake/ports.ts`: mở rộng `TrackerIssue`, `TrackerPort`, `ChannelBindingStore`, `OwnershipPort`, `ReplyCandidate`, `TicketCommand`, `MessageRoute`, `MessageRouteStore`, `CopyKey`.
  - `packages/core/src/intake/adapter.ts`: bổ sung `linkIssues`, `listProjectColumns`, `getIssueTimeline`, trả về `description` trong `getIssue`.
  - `packages/core/src/intake/create/binding-store.ts`: bổ sung `getBindingByIdentifier`, bổ sung `updatedAt` cho `getLatestBinding`.
  - `packages/core/src/intake/notify/stores.ts`: bổ sung `getLatestMessageRouteForChat` cho `SqliteMessageRouteStore`.
  - `packages/core/src/intake/draft/types.ts`: bổ sung `edit` trong `pendingTicketAction`.
  - `packages/core/src/intake/engine/text.ts`: bổ sung `stripSupplementCommandWrapper`, `classifyCancelOrCloseIntent`, `isCancelOrCloseTicketRequest`, `isProgressInquiry`.
  - `packages/core/src/intake/engine/engine.ts`: tích hợp D1-D7, D9 trong `routeExistingTicket`, `lookup`, `previewAction`, `resolvePendingAction`, `executeConfirmedTicketAction`, `buildCandidates`.
  - `packages/core/src/intake/engine/index.ts`: export `edit.ts` và `command-interpreter.ts`.
  - `packages/core/src/intake/engine/test-copy.fixture.ts`: khai báo copy strings tiếng Anh cho tests.
  - `packages/core/examples/tieulinh/copy.ts`: khai báo copy strings tiếng Việt mẫu của Tiểu Linh.
  - `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển 28 dòng PR 11 sang `ported`.
  - `packages/core/docs/parity/ENGINE.md`: cập nhật bảng đếm số liệu gap register.
  - `packages/core/CHANGELOG.md`: ghi nhận thay đổi của PR 11.
  - `docs/rfc/0002-receptionist.md`: cập nhật trạng thái các dòng D1-D7, D9 sang "Đủ".

## 3. Lệnh đã chạy và kết quả thật

- **Chạy các test suites mới của PR 11 + gap register**:
  ```bash
  bun test packages/core/src/intake/engine/text.test.ts packages/core/src/intake/engine/edit.test.ts packages/core/src/intake/engine/ownership-confirm.test.ts packages/core/src/intake/engine/pr11-ticket-commands.test.ts apps/tieulinh/receptionist-gap-register.test.ts
  ```
  *Kết quả*: **39 pass, 0 fail**, 1391 expect() calls (204.00ms).

- **Kiểm tra kiểu dữ liệu toàn repo**:
  ```bash
  bun run check
  ```
  *Kết quả*: Cả 4 workspaces (`@vuihoc/bot-core`, `@vuihoc/tl2-shadow`, `@vuihoc/tieulinh`, `@vuihoc/tieulinh-legacy`) đều **Exited with code 0** (clean 100%).

- **Kiểm tra linter baseline (quy tắc cấm `any` và `!` trong code mới)**:
  ```bash
  bun run lint:baseline
  ```
  *Kết quả*:
  - `style/noNonNullAssertion: 416 lỗi (cho phép tối đa 418)` (ok)
  - `suspicious/noExplicitAny: 780 lỗi (cho phép tối đa 780)` (ok)
  - Số lỗi của các rule đang tắt **không tăng**.

- **Kiểm tra repo công khai (không secret, thông tin thật)**:
  ```bash
  bun run scan
  ```
  *Kết quả*: `✓ public-hygiene scan clean`.

- **Kiểm tra tài liệu TypeDoc và mẫu code**:
  ```bash
  bun run docs:snippets && bun run docs:refs
  ```
  *Kết quả*: 40 mẫu code kiểm tra sạch, 46 trang tài liệu khớp code.

- **Toàn bộ test suite core**:
  ```bash
  bun run --cwd packages/core test
  ```
  *Kết quả*: **1413 pass, 0 fail**, 9703 expect() calls across 113 files (44.02s).

## 4. Test nào thêm, test nào port

Tổng cộng **28 ca test legacy được port đầy đủ**:
1. `nhận các cách viết mã ticket` (`text.test.ts`)
2. `mentionedIdentifiers nhận các kiểu người báo hay gõ (TECH-1001, 30/09)` (`text.test.ts`)
3. `mentionedIdentifiers hỗ trợ khoá dự án có chữ số mà không khớp nhầm SĐT hay mã khác` (`text.test.ts`)
4. `bóc vỏ câu lệnh bổ sung / đính kèm trần (TECH-1218: 'update vào tick TECH-1218') để không ghi câu lệnh thành comment` (`text.test.ts`)
5. `planEdit lọc thao tác hợp lệ` (`edit.test.ts`)
6. `applyEditOps: sửa dòng có sẵn, thêm dòng mới vào cuối Thông tin sự cố, thay câu mô tả duy nhất` (`edit.test.ts`)
7. `descriptionBody lấy phần Mô tả và ảnh` (`edit.test.ts`)
8. `append / edit / lookup chỉ nhận mã trong ứng viên; câu kỹ thuật hỏi vào prompt` (`pr11-ticket-commands.test.ts`)
9. `move_created cần ticket vừa tạo làm nguồn` (`pr11-ticket-commands.test.ts`)
10. `kỹ thuật vừa hỏi → GỢI Ý bổ sung, chưa ghi gì; bấm xác nhận mới ghi` (`pr11-ticket-commands.test.ts`)
11. `giục gấp có lý do vào ticket có sẵn → chỉ khi bấm xác nhận mới nâng mức + ghi lý do (thay escalate_issue cũ)` (`pr11-ticket-commands.test.ts`)
12. `gợi ý → 'Sự cố mới' thì tin vào tờ khai, không ghi ticket cũ` (`pr11-ticket-commands.test.ts`)
13. `'bổ sung TECHTEST-795 …' khi đang soạn dở → xem trước + Huỷ; Huỷ thì không ghi, tờ khai giữ nguyên` (`pr11-ticket-commands.test.ts`)
14. `đang chờ xác nhận mà nhắn việc khác → bỏ bản xem trước, xử lý tin mới như thường` (`pr11-ticket-commands.test.ts`)
15. `ticket có Telegram ID người báo trong mô tả cũng là của mình (ticket bot cũ)` (`pr11-ticket-commands.test.ts`)
16. `sửa: xem trước cũ → mới, xác nhận thì sửa thẳng + comment dấu vết` (`pr11-ticket-commands.test.ts`)
17. `bot vừa tạo nhầm → 'cái này bổ sung cho TECHTEST-795' → xác nhận: chép sang 795, nối trùng, huỷ bản vừa tạo` (`pr11-ticket-commands.test.ts`)
18. `tin báo trạng thái, ticket đã huỷ, hay lời 'huỷ'/'cảm ơn' → không gợi ý ghi vào ticket` (`pr11-ticket-commands.test.ts`)
19. `không có câu hỏi kỹ thuật, không nhắc mã → không gọi bộ đọc lệnh` (`pr11-ticket-commands.test.ts`)
20. `đang soạn dở tờ khai → câu trả lời cho tờ khai không bị kéo sang ticket kỹ thuật vừa hỏi` (`pr11-ticket-commands.test.ts`)
21. `TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment` (`pr11-ticket-commands.test.ts`)
22. `tra yêu cầu của người khác → không kể gì (kể cả tiêu đề)` (`ownership-confirm.test.ts`)
23. `tra yêu cầu của mình → đủ tin, trạng thái PO kèm lời giải thích` (`ownership-confirm.test.ts`)
24. `không truyền chatId thì không chứng minh được là của mình → từ chối` (`ownership-confirm.test.ts`)
25. `bổ sung vào yêu cầu người khác → từ chối, không xem trước, không ghi` (`ownership-confirm.test.ts`)
26. `bổ sung: lần đầu chỉ xem trước (chưa ghi); bấm xác nhận mới ghi đúng bản đã xem` (`ownership-confirm.test.ts`)
27. `bấm Huỷ → không ghi, bản chờ bị xoá` (`ownership-confirm.test.ts`)
28. `update_issue: báo updated=false khi cả ghi mô tả lẫn comment đều lỗi, không được báo thành công giả` (`pr11-ticket-commands.test.ts`)
- Thêm ca test mới:
  - `D9: tra cứu tiến độ không nêu mã trong cửa sổ 30 phút nhận diện ticket gần nhất` (`pr11-ticket-commands.test.ts`)
  - `chuẩn hoá nhãn nút chính xác` (`text.test.ts`)

## 5. Còn dở gì, và phần đó thuộc PR nào

- Toàn bộ 28 mục tiêu và test yêu cầu của PR 11 đã hoàn thành sạch 100%, không còn việc dở trong phạm vi PR 11.
- Các tính năng kế tiếp trong chuỗi RFC 0002 theo phân công:
  - **PR 12**: Huỷ và đóng ticket theo yêu cầu người báo (D8 theo ADR-0006 bản 10/10: số bình luận chuyên viên `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3` chuyển Done/Canceled, các nút `[✅ Hủy TECH-X]` / `[✅ Đóng TECH-X]` và `[Giữ lại]`).
  - **PR 13**: Soát thông tin kỹ thuật (F1-F4: `checklistReview`, `llmReview`, `learned`).
  - **PR 14**: Dữ liệu domain, chữ và định dạng ticket của Tiểu Linh (J1).
  - **PR 15 & 16**: Pack MCP, defineBot lễ tân và adapter OpenClaw.
