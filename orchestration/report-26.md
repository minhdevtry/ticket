# Báo cáo kết quả công việc: PR 12 — Huỷ và đóng ticket theo yêu cầu người báo (Issue #26)

## 1. Đã làm gì (theo từng mục của đặc tả)

- **D8 (Cơ chế huỷ/đóng theo yêu cầu người báo, ADR-0006 bản 10/10 & ADR-0008)**:
  - Tái dùng `classifyCancelOrCloseIntent` và `isCancelOrCloseTicketRequest` từ `packages/core/src/intake/engine/text.ts` (đã port ở PR 11) để phân loại ý định `cancel` vs `close` tất định, loại trừ câu sửa thật, chuyển ticket trùng hoặc mô tả sự cố chứa từ đóng/hủy.
  - Port `countSpecialistTimelineComments` và hằng số `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3` vào `packages/core/src/intake/engine/text.ts` và re-export qua `packages/core/src/intake/engine/cancel-close.ts`:
    - Chỉ đếm bình luận của chuyên viên kỹ thuật là người thật thuộc thành viên dự án (`projectAssignees`).
    - Loại bỏ bot tự động (`isBotComment`, `isSystemActor`, actor mang nhãn agent/bot/admin).
    - Loại bỏ bình luận của người báo (`reporterNames`).
  - Hỗ trợ cấu hình ngưỡng bình luận chuyên viên qua `minSpecialistCommentsForDone` trong `IntakeEngineDeps` (mặc định 3), không hardcode trong logic.
  - Mở rộng `pendingTicketAction.kind` trong `packages/core/src/intake/draft/types.ts` với `"cancel_ticket" | "close_ticket"`.
  - Triển khai bảng quyết định Canceled vs Done trong `engine.ts` (`proposeCancelOrClose`):
    - **Ô 1 & 7**: Ticket đã ở trạng thái `done` hoặc `canceled`: từ chối lịch sự bằng outcome `closed_refusal` và thông điệp `ticket.cancel_close_closed_refusal` ("Dạ ticket {identifier} hiện đã đóng ở trạng thái {statusLabel} trên hệ thống rồi nên em không chuyển lại nữa ạ."), không tạo đề xuất và không ghi comment.
    - **Ô 6**: Không phải chủ ticket (`ownTicket === false`): từ chối bằng outcome `not_owner` và thông điệp `action.not_owner_refusal`.
    - **Ô 2**: Nói rõ "hủy/huỷ/bỏ/không cần nữa" (`intent === "cancel"`): đề xuất `cancel_ticket` chuyển sang `Canceled`.
    - **Ô 3**: Ticket đang ở cột `Resolved` và nói "đóng" (`intent === "close"`): đề xuất `close_ticket` chuyển sang `Done`.
    - **Ô 4**: Có từ 3 bình luận chuyên viên trở lên (`specialistComments >= minSpecialistCommentsForDone`) và nói "đóng": đề xuất `close_ticket` chuyển sang `Done`.
    - **Ô 5**: Chưa ở `Resolved` và có dưới 3 bình luận chuyên viên (`specialistComments < 3`), nói "đóng": đề xuất `cancel_ticket` chuyển sang `Canceled` (chưa đủ điều kiện chuyển Done).
  - Bản xem trước và nút xác nhận một chạm (ADR-0008):
    - Đề xuất `cancel_ticket`: nút `button.confirm_cancel` ("✅ Hủy {identifier}") và nút `button.keep_ticket` ("Giữ lại").
    - Đề xuất `close_ticket`: nút `button.confirm_close` ("✅ Đóng {identifier}") và nút `button.keep_ticket` ("Giữ lại").
    - Tuyệt đối không dùng chữ "Huỷ" cho nút từ chối để tránh nhầm lẫn với thao tác huỷ ticket.
    - Người lạ ở chat khác gửi đúng callback text của nút không thể bấm hộ.
  - Phản ứng khi từ chối / huỷ bản xem trước (**Ô 8**):
    - Bấm nút "Giữ lại" hoặc gõ từ chối: giữ nguyên ticket, không đổi trạng thái và không ghi comment (`outcome: "action_canceled"`, thông điệp `action.keep_ticket_done`).
  - Chốt chặn an toàn tuyệt đối khi thực thi (**Ô 9** và chốt chặn an toàn):
    - Tại thời điểm người báo bấm nút xác nhận, `executeConfirmedTicketAction` đọc lại trạng thái ticket mới nhất và đếm lại số bình luận chuyên viên trên timeline.
    - Chỉ chuyển `Done` khi `pending.kind === "close_ticket"` VÀ thỏa mãn điều kiện chuyên viên xử lý (`currentState === "resolved" || specialistComments >= minSpecialistCommentsForDone`).
    - Nếu ticket bị kéo ngược trạng thái trong lúc chờ (ví dụ từ `Resolved` về `In Progress` với 1 bình luận chuyên viên), chốt chặn tự động chuyển sang `Canceled` thay vì `Done`.
    - Chuyển cột qua `TrackerPort.listProjectColumns(projectKey)` và `classifyColumn`, không hardcode `columnId`.
    - Ghi comment dấu vết `comment.cancel_or_close_trace` lên ticket sau khi chuyển cột: kèm icon (`✅` hoặc `🛑`), người yêu cầu (`who` đã escape), hành động (`đóng` hoặc `hủy`), trạng thái đích (`Done` hoặc `Canceled`), và lý do kèm ảnh đính kèm (nội dung đã qua `escapeItsaplanMarkdown`).
    - Cập nhật trạng thái tờ khai sang `canceled` nếu tờ khai hiện tại mang mã ticket vừa huỷ/đóng.
  - Fallback từ `proposeEdit` khi `ops = []`:
    - Nếu bộ đọc lệnh phân loại nhầm thành `edit` nhưng câu lệnh mang ý huỷ/đóng (`isCancelOrCloseTicketRequest`), tự động chuyển sang luồng `proposeCancelOrClose`.
- **Hợp đồng CopyKey & Không hardcode**:
  - Khai báo đầy đủ các khoá mới trong `ports.ts`: `button.confirm_cancel`, `button.confirm_close`, `button.keep_ticket`, `action.preview_cancel_ticket`, `action.preview_close_ticket`, `action.cancel_close_done`, `action.keep_ticket_done`, `action.cannot_read_status`, `action.label_close`, `action.label_cancel`, `action.draft_kept_note`, `ticket.cancel_close_closed_refusal`, `comment.cancel_or_close_trace`.
  - Triển khai đầy đủ trong `test-copy.fixture.ts` (tiếng Anh) và `packages/core/examples/tieulinh/copy.ts` (tiếng Việt Tiểu Linh).
  - 100% câu chữ gửi người dùng và comment hệ thống đều đi qua `CopyCatalog`; core không hardcode tiếng Việt.
- **Sổ đối chiếu & Parity**:
  - Chuyển đúng 12 dòng legacy sang `ported` trong `apps/tieulinh/receptionist-gap-register.test.ts`.
  - Cập nhật số liệu parity trong `packages/core/docs/parity/ENGINE.md`: `ported` tăng từ 174 lên 186, `deferred` giảm từ 204 xuống 192 (PR 12 còn 0 dòng).
  - Cập nhật `packages/core/CHANGELOG.md` và `docs/rfc/0002-receptionist.md` (dòng D8 sang trạng thái Đủ).

## 2. File nào đổi

- Tạo mới:
  - `packages/core/src/intake/engine/cancel-close.ts`: module export cho D8 (`classifyCancelOrCloseIntent`, `isCancelOrCloseTicketRequest`, `countSpecialistTimelineComments`, `MIN_SPECIALIST_COMMENTS_FOR_DONE`).
  - `packages/core/src/intake/engine/pr12-cancel-close.test.ts`: 12 bài kiểm thử port từ legacy (7 flow + 5 router).
- Cập nhật:
  - `packages/core/src/intake/draft/types.ts`: mở rộng `pendingTicketAction.kind` với `"cancel_ticket" | "close_ticket"`.
  - `packages/core/src/intake/ports.ts`: mở rộng `CopyKey` với 13 khoá mới của D8; mở rộng `TrackerPort.updateIssue` với `state?: "done" | "canceled" | "open" | "resolved"`.
  - `packages/core/src/intake/adapter.ts`: cập nhật `itsaplanTrackerPort.updateIssue` tự động ánh xạ `patch.state` sang `columnId` qua `listProjectColumns` và `classifyColumn`.
  - `packages/core/src/intake/engine/text.ts`: bổ sung `countSpecialistTimelineComments` và `MIN_SPECIALIST_COMMENTS_FOR_DONE`.
  - `packages/core/src/intake/engine/command-interpreter.ts`: hỗ trợ định tuyến tất định sang `cancel_or_close` kể cả khi LLM trả `edit` / `unclear`.
  - `packages/core/src/intake/engine/engine.ts`: triển khai `proposeCancelOrClose`, `countSpecialistComments`, chốt chặn an toàn và thực thi chuyển cột trong `executeConfirmedTicketAction`, xử lý nút "Giữ lại" trong `resolvePendingAction`, bổ sung `minSpecialistCommentsForDone` vào `IntakeEngineDeps`.
  - `packages/core/src/intake/engine/index.ts`: export `cancel-close`.
  - `packages/core/src/intake/engine/test-copy.fixture.ts`: bổ sung mẫu chuỗi tiếng Anh cho các khoá mới.
  - `packages/core/examples/tieulinh/copy.ts`: bổ sung mẫu chuỗi tiếng Việt Tiểu Linh cho các khoá mới.
  - `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển 12 dòng D8 từ `deferred` sang `ported`.
  - `packages/core/docs/parity/ENGINE.md`: cập nhật số liệu sổ đối chiếu (ported 186, deferred 192, PR 12 = 0).
  - `docs/rfc/0002-receptionist.md`: cập nhật dòng D8 sang Đủ.
  - `packages/core/CHANGELOG.md`: ghi nhận thay đổi của PR 12.

## 3. Lệnh đã chạy và kết quả thật

1. `bun run --cwd packages/core test`:
   - Kết quả: **1447 pass, 0 fail**, 10125 expect() calls, 116 files.
2. `bun run --cwd apps/tieulinh test`:
   - Kết quả: **77 pass, 0 fail**, 1603 expect() calls, 8 files.
3. `bun test packages/core/src/intake/engine/pr12-cancel-close.test.ts`:
   - Kết quả: **12 pass, 0 fail**, 214 expect() calls.
4. `bun test apps/tieulinh/receptionist-gap-register.test.ts`:
   - Kết quả: **9 pass, 0 fail**, 1241 expect() calls.
5. `bun run verify`:
   - `biome check .`: 0 errors.
   - `lint:baseline`: số lỗi không tăng (`noNonNullAssertion`: 413 <= 418; `noExplicitAny`: 780 <= 780).
   - `check`: toàn bộ 4 workspace (`@vuihoc/bot-core`, `@vuihoc/tl2-shadow`, `@vuihoc/tieulinh`, `@vuihoc/tieulinh-legacy`) typecheck sạch 100%.
   - `test`: toàn bộ test workspace chạy xanh.
   - `test:scripts`: 61 pass, 0 fail.
   - `scan`: `✓ public-hygiene scan clean`.
   - `docs:snippets`: 26 `ts check`, 14 `ts run`, 2 `ts no-check`.
   - `docs:refs`: Docs khớp code: 48 trang sạch.
6. `bun run docs:check`:
   - Build VitePress hoàn thành trong 47.39s.
   - Snippets và references sạch 100%.

## 4. Test nào thêm, test nào port

### Port 12 ca test legacy (giữ nguyên tên ca và ý nghĩa):
1. **7 ca flow** từ `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts`:
   - `hủy rõ (chưa xử lý / đang xử lý dở kể cả có ≥3 comment chuyên viên / đã xử lý Resolved) → luôn chuyển Canceled (cột 5) + escapeItsaplanMarkdown`
   - `nói 'đóng' khi chưa xử lý (0, 1 hoặc 2 bình luận chuyên viên, chưa ở Resolved) → chuyển Canceled (cột 5), nút [✅ Hủy ... / Giữ lại]`
   - `nói 'đóng' khi đã có chuyên viên xử lý (≥ 3 bình luận chuyên viên HOẶC đang ở cột Resolved) → chuyển Done (cột 4), nút [✅ Đóng ... / Giữ lại]`
   - `ticket đã ở Done (cột 4) hoặc Canceled (cột 5) → không chuyển lại, không ghi comment, trả lời lịch sự`
   - `không phải chủ ticket (ownTicket = false) → từ chối hủy/đóng, không đổi cột, không ghi comment`
   - `bấm nút 'Giữ lại' hoặc fallback trong proposeEdit khi ops=[] hoạt động chuẩn, và chốt chặn không bao giờ chuyển Done khi chưa đủ điều kiện`
   - `người khác (chat khác) không bấm hộ nút xác nhận hủy được; câu mô tả sự cố có chữ đóng/hủy khi unclear hỏi lại Bổ sung/Sự cố mới chứ không hủy vé`
2. **5 ca router** từ `apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.test.ts`:
   - `phân loại tất định các câu thật yêu cầu HỦY rõ → intent = 'cancel'`
   - `phân loại tất định các câu yêu cầu ĐÓNG / báo đã dùng được (không kèm từ hủy) → intent = 'close'`
   - `không bắt nhầm câu sửa thật, chuyển ticket trùng, câu thiếu mã ticket hay mô tả sự cố có chữ hủy/đóng (≥20 câu thực tế)`
   - `LlmTicketCommandInterpreter định tuyến tất định sang cancel_or_close kể cả khi LLM trả edit / unclear`
   - `countSpecialistTimelineComments chỉ đếm bình luận của chuyên viên TECH, loại bỏ bot và người báo`

## 5. Còn dở gì, và phần đó thuộc PR nào

Không còn việc dở trong phạm vi PR 12. Các phần tiếp theo trong chuỗi di trú RFC 0002:
- **PR 13**: Soát thông tin kỹ thuật (F1-F4: checklistReview, llmReview, learned).
- **PR 14**: Dữ liệu domain, chữ và định dạng ticket chi tiết của Tiểu Linh (J1, K6).
- **PR 15**: DefineBot lễ tân thành pack MCP và skill.
- **PR 16**: Adapter OpenClaw cho lễ tân.
