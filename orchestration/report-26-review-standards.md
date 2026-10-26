# Báo cáo review trục chuẩn hoá code — PR 12 (issue #26)

## 1. Kết luận (Verdict)

**CHANGES REQUESTED** (Cần sửa đổi trước khi merge).

Nhánh `feat/pr-12-cancel-close` (PR #60) đã port thành công toàn bộ hành vi D8 (RFC 0002 §1.4 / ADR-0006) với cấu trúc mạch lạc, 12/12 ca test legacy chạy xanh, không thêm `any` hay `!`, cập nhật sổ đối chiếu và tài liệu chuẩn xác. Tuy nhiên, vẫn còn vi phạm nguyên tắc "không hardcode câu chữ gửi người dùng trong core" tại `engine.ts:1939` (chuỗi ghi chú tệp tiếng Việt), hardcode định danh bot trong `text.ts:247`, và các sửa đổi an toàn đang dở ở working tree cần được chốt vào commit.

---

## 2. Bảng phát hiện (Findings)

| Mức độ | Vị trí (`file:dòng`) | Vấn đề | Cách sửa đề xuất |
|---|---|---|---|
| **HIGH** | `packages/core/src/intake/engine/engine.ts:1939` | **Hardcode câu chữ gửi người dùng trong core**: Chuỗi ghi chú số lượng tệp đính kèm được hardcode trực tiếp thành `\n(kèm ${mediaPaths.length} ảnh/tệp)` thay vì lấy từ `CopyCatalog`. Khi dùng catalog tiếng Anh hay ngôn ngữ khác, preview vẫn bị lọt chuỗi tiếng Việt. Trong khi đó, tại dòng 1790 và 2142 đã dùng đúng `deps.copy.text("action.suggest_append_media_note", { count: mediaPaths.length })`. | Đổi dòng 1939 thành:<br>`const files = mediaPaths.length ? `\n${deps.copy.text("action.suggest_append_media_note", { count: mediaPaths.length }).trim()}` : "";` |
| **MEDIUM** | `packages/core/src/intake/engine/text.ts:247-248` | **Core hardcode tên bot/hệ thống của app**: `NON_SPECIALIST_ACTOR_RE` chứa các từ khoá riêng của app như `tiểu linh`, `iris`, `onyx`, `bot-ticket-intake`. Vi phạm CODING_STANDARDS §8 ("Core không hardcode tên sản phẩm, tên công ty hay tên hệ thống của một app"). | Chuyển `NON_SPECIALIST_ACTOR_RE` trong core về regex trung tính (như `DEFAULT_SYSTEM_ACTOR_RE` trong `supplement-notifier.ts`), đồng thời mở rộng `options` của `countSpecialistTimelineComments` nhận `ignoredActors?: string[] \| RegExp` để engine hoặc app tiêm danh sách bot cần bỏ qua. |
| **MEDIUM** | `packages/core/src/intake/engine/engine.ts:2546-2548` & `2563-2567` (HEAD `b0b6078`) | **Xử lý lỗi ném exception và nhãn đóng/huỷ ở commit HEAD**: Tại HEAD `b0b6078`, việc ném `throw new Error(...)` làm crash `step()` khi thiếu cột và nhãn `"đóng"` / `"hủy"` bị hardcode trong comment dấu vết. *(Ghi chú: Trong working tree đã có bản sửa dở dùng `deps.copy.text("action.column_not_found")`, `uploadMedia`, và `action.word_close`/`action.word_cancel`).* | Cần hoàn thiện và commit chính thức bản sửa từ working tree vào nhánh PR để không làm mất logic xử lý an toàn này. |
| **LOW** | `packages/core/src/intake/engine/pr12-cancel-close.test.ts` | **Thiếu ca test cho ô #7 bảng quyết định**: `engine.ts:2513-2531` đã có logic từ chối `closed_refusal` nếu ticket bị đổi sang Done/Canceled giữa lúc preview và confirm, nhưng bộ test mới chỉ kiểm thử trường hợp đổi từ Resolved về In Progress (chuyển Canceled thay vì Done), chưa có ca test nào khẳng định việc từ chối khi ticket đã đóng trước khi bấm nút xác nhận. | Bổ sung 1 ca test trong `pr12-cancel-close.test.ts`: hiển thị preview huỷ/đóng lúc ticket còn mở, cập nhật ticket sang Done/Canceled trên tracker fake, rồi bấm xác nhận → khẳng định trả về `closed_refusal` và không đổi cột/comment. |

---

## 3. Bảng lệnh và kết quả kiểm thử mục tiêu

| Lệnh | Kết quả thực tế | Đánh giá |
|---|---|---|
| `bun run lint` | 20 diagnostics trong 10 file (toàn bộ nằm ở `apps/tieulinh-legacy/**`, `apps/tieulinh/sla.test.ts`, `biome.json` từ trước; không có lỗi nào thuộc file mới của PR 12) | **PASS** (baseline cũ) |
| `bun run lint:baseline` | `style/noNonNullAssertion`: 413 (tối đa 418)<br>`suspicious/noExplicitAny`: 780 (tối đa 780)<br>*Số lỗi của các rule đang tắt không tăng.* | **PASS** |
| `bun test packages/core/src/intake/engine/pr12-cancel-close.test.ts` | **12 pass, 0 fail**, 214 expect() calls [145.00ms] | **PASS** |
| `bun test packages/core/src/intake/engine/pr11-ticket-commands.test.ts` | **19 pass, 0 fail**, 92 expect() calls [186.00ms] | **PASS** |
| `bun test apps/tieulinh/receptionist-gap-register.test.ts` | **9 pass, 0 fail**, 1241 expect() calls [28.00ms] | **PASS** |

---

## 4. Vùng đã kiểm nhưng không thấy lỗi (Tuân thủ chuẩn)

1. **Không `any`, không `!` trong code mới**:
   - Quét regex toàn bộ diff `origin/main...HEAD`: không có `: any` hay `as any`, không có non-null assertion `!`.
   - Kết quả `bun run lint:baseline` giữ nguyên số lượng lỗi, không tăng bất kỳ lỗi nào.
2. **Một hằng, một hàm, một kiểu — một chủ duy nhất**:
   - `classifyCancelOrCloseIntent` và `isCancelOrCloseTicketRequest` được tái sử dụng trực tiếp từ `packages/core/src/intake/engine/text.ts` (đã có từ PR 11), không tạo bản sao thứ hai.
   - `countSpecialistTimelineComments` đặt tại `text.ts`, tái sử dụng `isSystemActor` và `TimelineCommentEntry` từ `supplement-notifier.ts`, cùng `isBotComment` từ `formatting.ts`, không tạo trùng lặp logic đếm comment.
3. **Ranh giới sửa đổi (Ownership & Boundaries)**:
   - Tuyệt đối không sửa đổi các khu vực cấm: `apps/tieulinh-legacy/**`, `.github/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.
4. **Tham số cấu hình**:
   - Ngưỡng bình luận chuyên viên cấu hình được linh hoạt qua `minSpecialistCommentsForDone` trong `IntakeEngineDeps`, có giá trị mặc định là `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3`.
5. **Chất lượng kiểm thử**:
   - `pr12-cancel-close.test.ts` được đặt cạnh nguồn trong `packages/core/src/intake/engine/`.
   - Sử dụng `FakeClock`, không phụ thuộc vào thời gian thực (`Date.now()`, `setTimeout`) hay I/O ngoài mạng.
   - Khẳng định trên đầu ra hệ thống (`stepOutput`, `calls.updateIssue`, `calls.addComment`), không tự dựng chuỗi so sánh.
6. **Porting đối chiếu Legacy**:
   - Đủ 12 ca kiểm thử (7 ca flow + 5 ca router), giữ nguyên 100% tên ca và ý định kiểm thử gốc từ `pipeline.flow.test.ts` và `ticket-reply-router.test.ts`.
7. **Sổ đối chiếu & Tài liệu**:
   - `packages/core/CHANGELOG.md` có ghi chép đầy đủ mục PR 12 trong `## Unreleased`.
   - `packages/core/docs/parity/ENGINE.md` khớp chính xác với sổ đối chiếu: `total=450 core=61 ported=186 deferred=192 by-design=11` (số test deferred của PR 12 giảm về 0).
   - `apps/tieulinh/receptionist-gap-register.test.ts` chuyển đúng 12 dòng PR 12 sang trạng thái `ported`.
   - `docs/rfc/0002-receptionist.md` chỉ sửa đổi dòng D8 và đoạn tổng kết khoảng trống tương ứng.
