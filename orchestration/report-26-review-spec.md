# Báo cáo Review Trục Đặc tả & Hành vi — PR 12 (Issue #26)

- **Người review:** Reviewer độc lập (trục đặc tả và hành vi quan sát được)
- **PR:** https://github.com/minhdevtry/ticket/pull/60 (nhánh `feat/pr-12-cancel-close`, issue #26)
- **Cơ sở đối chiếu:** RFC 0002 §1.4 D8, ADR-0006 bản 10/10, ADR-0008, và `orchestration/specs/issue-26-pr-12-cancel-close.md`
- **Phương pháp kiểm chứng:** Tự viết script độc lập `/tmp/verify-decision-table.ts` dựng `IntakeEngine` với fakes kiểm tra từng nhánh thực thi; chạy 4 bộ test mục tiêu theo ràng buộc đặc tả.

---

## 1. Verdict

**ĐẠT (APPROVED)**.

Toàn bộ 9 ô trong bảng quyết định nghiệp vụ D8, các chốt chặn runtime theo ADR-0006 và ADR-0008, phân loại ý định tĩnh và đếm bình luận chuyên viên đều hoạt động chính xác theo đặc tả. Không có hồi quy trên các PR trước (PR 10, PR 11) và sổ đối chiếu `receptionist-gap-register.test.ts`.

---

## 2. Bảng quyết định 9 ô & Chốt chặn thực thi

| # | Trạng thái ticket | Ý định người báo | Kỳ vọng đặc tả | Code & Test chứng minh | Kết luận |
|---|---|---|---|---|---|
| 1 | `done` hoặc `canceled` | Bất kỳ | Từ chối lịch sự, không chuyển cột, không ghi comment | `engine.ts:1886-1901`, `engine.ts:2513-2530`. Test: `pr12-cancel-close.test.ts` (ca flow 4) & `/tmp/verify-decision-table.ts` (cell 1). Outcome: `closed_refusal`, 0 updates, 0 comments. | **ĐẠT** |
| 2 | Khác (`unstarted`, `started`) | Hủy rõ ("hủy/huỷ/bỏ/không cần nữa") | Xem trước `[✅ Hủy TECH-X]` / `[Giữ lại]`, xác nhận → chuyển **Canceled** (cột 5) | `text.ts:237-254`, `engine.ts:1906, 2544`. Test: `pr12-cancel-close.test.ts` (ca flow 1) & `/tmp/verify-decision-table.ts` (cell 2). Update `columnId: 5`. | **ĐẠT** |
| 3 | `resolved` | Đóng ("đóng/đã vào được") | Xem trước `[✅ Đóng TECH-X]` / `[Giữ lại]`, xác nhận → chuyển **Done** (cột 4) | `engine.ts:1909-1911, 2538`. Test: `pr12-cancel-close.test.ts` (ca flow 3) & `/tmp/verify-decision-table.ts` (cell 3). Update `columnId: 4`. | **ĐẠT** |
| 4 | Khác (`started`), `n >= 3` chuyên viên | Đóng | Xem trước `[✅ Đóng TECH-X]` / `[Giữ lại]`, xác nhận → chuyển **Done** (cột 4) | `engine.ts:1822, 1909, 2538`. Test: `pr12-cancel-close.test.ts` (ca flow 3) & `/tmp/verify-decision-table.ts` (cell 4). Đếm đúng >=3 comment chuyên viên TECH. | **ĐẠT** |
| 5 | Khác (`started`), `n < 3` chuyên viên | Đóng | Xem trước `[✅ Hủy TECH-X]` / `[Giữ lại]`, xác nhận → chuyển **Canceled** (cột 5) | `engine.ts:1906-1913, 2544`. Test: `pr12-cancel-close.test.ts` (ca flow 2) & `/tmp/verify-decision-table.ts` (cell 5). Nút đề xuất tự chuyển sang "Hủy". | **ĐẠT** |
| 6 | Bất kỳ | Không phải chủ ticket (`ownTicket === false`) | Từ chối (`action.not_owner_refusal`), không đề xuất, không đổi cột | `engine.ts:1860-1872`, `engine.ts:2493-2499`. Test: `pr12-cancel-close.test.ts` (ca flow 5) & `/tmp/verify-decision-table.ts` (cell 6). Outcome: `not_owner`. | **ĐẠT** |
| 7 | `done` hoặc `canceled` | Bấm nút xác nhận cũ đã hiện từ trước | Kiểm lại lúc thực thi: từ chối, không đổi cột | `engine.ts:2513-2531`. Test: `pr12-cancel-close.test.ts` (ca flow 4) & `/tmp/verify-decision-table.ts` (cell 7). Outcome: `closed_refusal`. | **ĐẠT** |
| 8 | Bất kỳ | Bấm "Giữ lại" | Hủy thao tác (`action_canceled`), giữ nguyên ticket, không ghi comment | `engine.ts:2287-2308`. Test: `pr12-cancel-close.test.ts` (ca flow 6) & `/tmp/verify-decision-table.ts` (cell 8). Outcome: `action_canceled`, 0 updates. | **ĐẠT** |
| 9 | Bất kỳ | Bấm xác nhận | Chuyển đúng cột, ghi comment lý do đã escape + đính kèm ảnh | `engine.ts:2551-2583`. Test: `pr12-cancel-close.test.ts` (ca flow 1) & `/tmp/verify-decision-table.ts` (cell 9). Comment chứa lý do đã qua `escapeItsaplanMarkdown` và ảnh. | **ĐẠT** |

### Chốt chặn an toàn runtime bổ sung:

- **Chốt chặn lúc thực thi (Re-evaluation at execution time):**
  - *Kịch bản:* Lúc đề xuất, ticket đang ở `Resolved` (đề xuất `close_ticket`, nút `[✅ Đóng TECH-X]`). Nhưng trước khi người báo bấm xác nhận, kỹ thuật viên kéo ticket về `In Progress` và chỉ có 1 comment chuyên viên.
  - *Kết quả quan sát được:* Tại thời điểm người báo gửi callback `✅ Đóng TECH-X`, hàm `executeConfirmedTicketAction` đọc lại trạng thái thực tế từ tracker (`engine.ts:2536-2539`). Do `currentState !== "resolved"` và `specialistComments < 3`, `moveToDone` trở thành `false`. Ticket được chuyển sang **Canceled** (cột 5), **tuyệt đối không sang Done**. Kiểm chứng độc lập tại `/tmp/verify-decision-table.ts` (cell 10: `movedCanceled=true, movedDone=false`).
- **Bảo vệ ADR-0008 (Chat khác không bấm hộ):**
  - *Kịch bản:* Người lạ ở chat khác gửi đúng chuỗi callback `✅ Hủy TECH-951` của người báo.
  - *Kết quả quan sát được:* Không có phiên nháp khớp hoặc kiểm tra quyền sở hữu `isOwnTicket` trả về `false`. Thao tác bị chặn ngay ở mức engine (`not_owner`), 0 lệnh ghi lên tracker. Kiểm chứng độc lập tại `/tmp/verify-decision-table.ts` (cell 11).
- **Phân loại cột động & Từ chối an toàn khi thiếu cột:**
  - *Kịch bản:* Dự án không có cột Done/Canceled trong cấu hình tracker.
  - *Kết quả quan sát được:* Engine không hardcode ID cột 4/5 mà tra qua `listProjectColumns` + `classifyColumn`. Nếu không tìm thấy cột đích, engine trả lời lịch sự qua `action.column_not_found` ("Dạ em chưa tìm thấy cột {stateLabel} trong dự án để chuyển {identifier} ạ."), không ném ngoại lệ làm sập lượt chat. Kiểm chứng độc lập tại `/tmp/verify-decision-table.ts` (cell 12).
- **Đếm bình luận chuyên viên chuẩn xác:**
  - `countSpecialistTimelineComments` loại bỏ hoàn toàn bot (`isBotComment`), agent (`item.actorKind === "agent"`), system actor (`isSystemActor`), bot names (`NON_SPECIALIST_ACTOR_RE`), và tài khoản người báo (`reporterSet`). Chỉ tính thành viên nhân sự thật thuộc dự án TECH (`humanMembers`).

---

## 3. Findings

Không có blocker hoặc lỗi vi phạm đặc tả.

### Ghi nhận Info (Kiến trúc & Đảm bảo ADR-0010):
- **Cơ chế tải ảnh qua `TrackerPort.uploadMedia` thay vì `attach`:**
  - *Bối cảnh:* `TrackerPort.attach` trong kiến trúc gốc sẽ ghi đè `description` của ticket bằng chuỗi markdown mới ghép ảnh. Với ticket đã tạo, điều này sẽ xoá sạch mô tả ban đầu của người báo (vi phạm ADR-0010).
  - *Hiện trạng:* PR 12 bổ sung cổng `uploadMedia` trên `TrackerPort` để chỉ tải ảnh lên kho lưu trữ và trả về markdown ảnh để nhúng vào comment lý do huỷ/đóng. Nếu adapter tracker của app không cài đặt `uploadMedia`, engine bỏ qua ảnh an toàn thay vì ghi đè mô tả ticket. Đây là quyết định kiến trúc chuẩn xác, giữ vững ADR-0010.

---

## 4. Bảng lệnh & Kết quả kiểm thử

Mọi kiểm thử mục tiêu được chỉ định trong đặc tả đều được thực thi và có kết quả xanh 100%:

| STT | Lệnh thực thi | Thời gian | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `bun test packages/core/src/intake/engine/pr12-cancel-close.test.ts` | 172ms | **17 pass, 0 fail** (223 expect) | 7 flow tests + 5 router tests + 3 tests bảo vệ sau vòng soi |
| 2 | `bun test packages/core/src/intake/engine/pr11-ticket-commands.test.ts` | 160ms | **19 pass, 0 fail** (92 expect) | Kiểm tra không hồi quy PR 11 (command router) |
| 3 | `bun test packages/core/src/intake/engine/pr10-post-create.test.ts` | 180ms | **23 pass, 0 fail** (99 expect) | Kiểm tra không hồi quy PR 10 (post-create) |
| 4 | `bun test apps/tieulinh/receptionist-gap-register.test.ts` | 20ms | **9 pass, 0 fail** (1241 expect) | 12 dòng D8 chuyển sang `ported` hoàn tất |
| 5 | `bun run /tmp/verify-decision-table.ts` | 45ms | **12/12 scenarios pass** | Script độc lập kiểm chứng 9 ô ma trận + 3 chốt chặn runtime |

---

## 5. Lệch Legacy có chủ ý (Intentional Deviations)

1. **Xử lý thiếu cột Done/Canceled:**
   - *Legacy:* `pipeline.ts:2764` ném `throw new Error(...)` làm văng unhandled exception và làm hỏng toàn bộ lượt phản hồi của người báo.
   - *Core PR 12:* Trả về tin nhắn từ chối lịch sự qua `action.column_not_found` ("Dạ em chưa tìm thấy cột {stateLabel} trong dự án để chuyển {identifier} ạ."), giữ an toàn cho lượt hội thoại.
2. **Cấu hình ngưỡng bình luận chuyên viên:**
   - *Legacy:* Hardcode hằng số `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3` trong code.
   - *Core PR 12:* Đưa `minSpecialistCommentsForDone` vào `IntakeEngineDeps` (mặc định 3), cho phép tuỳ biến theo từng bot hoặc dự án theo đúng thiết kế RFC 0002 §2.2.
3. **Đính kèm ảnh khi huỷ/đóng:**
   - *Legacy:* Gọi hàm upload ghi đè mô tả ticket.
   - *Core PR 12:* Ghép ảnh đính kèm vào nội dung comment lịch sử, tuyệt đối không can thiệp hay sửa đổi phần mô tả ban đầu của người báo (bảo toàn ADR-0010).
4. **Tách biệt hiển thị và máy trạng thái qua `CopyCatalog`:**
   - *Legacy:* Chuỗi văn bản tiếng Việt và nhãn nút nằm rải rác trực tiếp trong `pipeline.ts`.
   - *Core PR 12:* Toàn bộ chuỗi hiển thị và nhãn nút ("✅ Hủy...", "✅ Đóng...", "Giữ lại") đi qua `CopyCatalog` (`CopyKey`). Logic engine thuần túy là máy trạng thái tất định.
