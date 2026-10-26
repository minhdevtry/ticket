# Báo cáo Review độc lập: Trục đặc tả và hành vi — PR 9 (Issue #23 / PR #55)

**Người review**: Agent Reviewer Độc Lập (Orca Worker `task_040bb97437dc`)  
**Nhánh kiểm tra**: `minhdevtry/feat-pr-9-split` (PR https://github.com/minhdevtry/ticket/pull/55, commit `5dc4b11`)  
**Đối tượng review**: Port **B7** của RFC 0002 (`docs/rfc/0002-receptionist.md` mục 1.5, 2.1, 5; `orchestration/specs/issue-23-pr-9-split.md`)  
**Chế độ**: Chỉ đọc (read-only), không chỉnh sửa code/test repo, tự chạy các test mục tiêu và kịch bản đối chiếu độc lập.

---

## 1. Kết luận (Verdict)

# **APPROVE**

Triển khai của PR 9 trong commit `5dc4b11` đáp ứng đầy đủ và trung thực 100% các tiêu chí đặc tả của B7 (RFC 0002) cũng như toàn bộ các ca kiểm thử legacy (`multi-incident.test.ts` và `split-adversarial.test.ts`). Không phát hiện bất kỳ đường dẫn nào làm rơi câu chữ hoặc ảnh đính kèm. Hàng đợi tạo ticket tuần tự, kế thừa bộ phận và gói tin hỗn hợp `createdIssue` + `nextDraft` hoạt động chính xác theo hợp đồng miền.

---

## 2. Bảng đối chiếu chi tiết yêu cầu B7

| # | Yêu cầu đặc tả B7 | Code chứng minh | Test chứng minh | Kết quả |
|---|---|---|---|:---:|
| **1** | **Bộ tách (`splitMultiIncidentReport`)**: <br>- Tin < 30 ký tự không tách <br>- Có dấu hiệu ví dụ (`EXAMPLE_LIST_MARKER`: `vdu`, `ví dụ`, `dưới đây`, `các hs`) không tách <br>- Phải có từ chỉ lỗi (`EXPANDED_PROBLEM_WORDS`) <br>- Tách theo ≥ 2 dòng trống hoặc mẫu mở đầu khối mới (`1.`/`2.`, `**Tên**`, `Code:`, CRM trần 7-10 số) <br>- Chỉ tách theo định danh có nhãn (`customerId`, `studentAccount`); SĐT không tạo việc tách <br>- Khối phải có câu chữ riêng, không chỉ là tên người <br>- Cùng một HS nhắc lại ở 2 đoạn không tách | `packages/core/src/intake/split/split.ts:24-93`<br>`packages/core/src/intake/extractor/heuristics.ts:604` (`residualProse`) | `packages/core/src/intake/split/split.test.ts:5-93`<br>`packages/core/src/intake/engine/split-adversarial.test.ts:394-434` (Case F)<br>Kịch bản đối chiếu `/tmp/compare-split.ts` (10/10 khớp legacy) | **ĐẠT** |
| **2** | **Câu hỏi tách/gộp**: <br>- Hỏi đúng câu chữ "Tách N ticket / Gộp 1 ticket" <br>- 2 nút bấm tương ứng (`button.split_n`, `button.merge_one`) <br>- Ánh xạ sang action legacy `ask_split_or_merge` | `packages/core/src/intake/engine/engine.ts:927-957` (`splitQuestionOutput`)<br>`packages/core/src/intake/engine/action-map.ts:16`<br>`packages/core/src/intake/ports.ts:127-132` | `packages/core/src/intake/engine/pr9-split.test.ts:318, 458, 477, 516`<br>`packages/core/src/intake/engine/split-adversarial.test.ts:259, 298` | **ĐẠT** |
| **3** | **Phủ định và "thôi/khỏi" trần**: <br>- Hiểu "không tách", "ko tách", "k tách", "chẳng tách", "đừng tách", "khỏi tách", "thôi tách" là GỘP <br>- Hiểu "thôi", "khỏi", "thôi ạ", "khỏi đi" trần là GỘP <br>- Tuyệt đối không rơi vào nhánh tách | `packages/core/src/intake/engine/engine.ts:969-988` (`resolvePendingSplit`) | `packages/core/src/intake/engine/pr9-split.test.ts:456-470` (BUG 5)<br>`packages/core/src/intake/engine/split-adversarial.test.ts:288-324` (Case B: 25 biến thể)<br>Kịch bản `/tmp/test-adversarial-patterns.ts` (46/46 regex match) | **ĐẠT** |
| **4** | **Trả lời không rõ ý**: <br>- Hỏi lại ĐÚNG MỘT LẦN (`clarifyCount: 1`) kèm lời giải thích (`split.unclear_prefix`) <br>- Lần 2 vẫn không rõ thì mặc định GỘP 1 ticket (`mergeParkedSplit`) <br>- Mọi nhánh không rơi chữ hay ảnh (tin dán lại, tin báo sự cố thứ 3, tin chỉ có ảnh, token `noop` đều được gom vào `extraText` và `mediaPaths`) | `packages/core/src/intake/engine/engine.ts:1049-1077` (`handleUnclearSplitReply`)<br>`packages/core/src/intake/engine/engine.ts:1079-1115` (`mergeParkedSplit`) | `packages/core/src/intake/engine/pr9-split.test.ts:514-538` (BUG 6 P1)<br>`packages/core/src/intake/engine/split-adversarial.test.ts:327-356` (Case C)<br>`packages/core/src/intake/engine/split-adversarial.test.ts:359-391` (Case D, E)<br>`packages/core/src/intake/engine/split-adversarial.test.ts:469-490` (Case H) | **ĐẠT** |
| **5** | **Hàng đợi tạo lần lượt**: <br>- Chọn tách thì tạo từng ticket, gom `firstBlock` + `extraText` cho ticket 1; các khối còn lại vào `pendingSplitQueue` <br>- Kế thừa bộ phận người báo (`reportingDept`) từ tờ khai trước cho các ticket sau <br>- Gói tin hỗn hợp trả về `createdIssue` (ticket vừa tạo) + `nextDraft` (tờ khai kế tiếp) <br>- Ticket sau chỉ cần xác nhận ("đúng rồi") là tạo tiếp | `packages/core/src/intake/engine/engine.ts:626-699` (`finishCreate`)<br>`packages/core/src/intake/engine/engine.ts:981-1002` (`resolvePendingSplit`) | `packages/core/src/intake/engine/pr9-split.test.ts:335-385`<br>`packages/core/src/intake/engine/split-adversarial.test.ts:257-285` (Case A)<br>`packages/core/src/intake/engine/split-adversarial.test.ts:436-465` (Case G)<br>Kịch bản độc lập `/tmp/test-sequential-three.ts` (tạo tuần tự 3 ticket) | **ĐẠT** |
| **6** | **`mediaAmbiguous`**: <br>- Ảnh gắn cho mọi ticket khi không chia được, bật cờ `mediaAmbiguous = true` <br>- Cờ được truyền sang các ticket tiếp theo trong hàng đợi <br>- Tự động bổ sung thông báo đính kèm chung (`media.ambiguous_notice`) vào mô tả ticket mà không ghi đè `rawText` | `packages/core/src/intake/engine/engine.ts:983, 999, 630`<br>`packages/core/src/intake/create/create-ticket.ts:179-184` | `packages/core/src/intake/engine/pr9-split.test.ts:421-454`<br>`packages/core/src/intake/engine/split-adversarial.test.ts:257-285` (Case A) | **ĐẠT** |
| **7** | **Huỷ giữa câu hỏi tách**: <br>- Thoát câu hỏi, huỷ tờ khai (`status: "canceled"`) <br>- Xoá sạch `pendingSplit` và `pendingSplitQueue`, không để ticket mồ côi | `packages/core/src/intake/engine/engine.ts:257-260`<br>`packages/core/src/intake/engine/engine.ts:1033-1045` | `packages/core/src/intake/engine/pr9-split.test.ts:473-512` (BUG 6/7)<br>`packages/core/src/intake/engine/split-adversarial.test.ts:288-324` | **ĐẠT** |
| **8** | **TTL 24h**: <br>- Im lặng quá 24h ở câu hỏi tách thì tờ khai hết hạn (`isExpiredDraft`) <br>- Tin mới mở sự cố mới hoàn toàn, không hồi sinh câu hỏi tách cũ | `packages/core/src/intake/engine/engine.ts:187-194` | `packages/core/src/intake/engine/split-adversarial.test.ts:493-505` (Case I) | **ĐẠT** |
| **9** | **Không hồi quy**: <br>- Các nhánh PR 1-8 (`detectPark`, `resolvePark`, hỏi bổ sung PR 7, chuẩn hoá đầu vào) vẫn xanh hoàn toàn, không bị ảnh hưởng | `packages/core/src/intake/engine/engine.ts:180-205, 270-285` | `packages/core/src/intake/engine/engine.test.ts` (23 pass)<br>`packages/core/src/intake/engine/pr8-park.test.ts` (14 pass)<br>`packages/core/src/intake/engine/pr7-ask-missing.test.ts` (7 pass) | **ĐẠT** |

---

## 3. Các phát hiện theo mức độ (Findings)

- **Mức Nghiêm trọng (Blocker / Critical)**: Không có (0).
- **Mức Trung bình (Major)**: Không có (0).
- **Mức Nhỏ / Ghi nhận kiến trúc (Minor / Observations)**:
  1. **Hợp đồng gói tin hỗn hợp `createdIssue` + `nextDraft`**:
     - *Vị trí*: `packages/core/src/intake/engine/engine.ts:664-699`.
     - *Nhận xét*: Thiết kế gói tin trả về của `finishCreate` được chuẩn hoá rõ nét. Khi có sự cố kế tiếp trong hàng đợi, engine trả về đồng thời `createdIssue` (ticket vừa tạo) và `nextDraft` (tóm tắt trạng thái và docId của sự cố tiếp theo). Đồng thời, `out.docId` được chuyển sang `nextDoc.docId`, giúp chu kỳ hội thoại của kênh (Telegram/Web) lập tức nhắm vào ticket tiếp theo mà không bị bám vào ticket vừa đóng.
  2. **Tái sử dụng tiện ích bóc tách không trùng lặp**:
     - *Vị trí*: `packages/core/src/intake/extractor/heuristics.ts:604` và `packages/core/src/intake/split/split.ts:20`.
     - *Nhận xét*: Thay vì sao chép lại hàm `residualProse` như legacy, PR 9 đã export hàm này từ `heuristics.ts` để `split.ts` tái sử dụng trực tiếp, tuân thủ đúng yêu cầu DRY và chỉ dẫn trong đặc tả PR 9.
  3. **Chống trùng lặp thông báo `mediaAmbiguous`**:
     - *Vị trí*: `packages/core/src/intake/create/create-ticket.ts:179-184`.
     - *Nhận xét*: Logic kiểm tra `!ticket.rawText.includes(ambiguousNotice)` ngăn việc lặp lại thông báo đính kèm chung nếu văn bản đã có sẵn thông báo này (ví dụ khi gộp hoặc retry).

---

## 4. Bảng lệnh đã chạy và kết quả thực tế

Toàn bộ các lệnh dưới đây được chạy trực tiếp trên worktree `minhdevtry/feat-pr-9-split`:

| Lệnh đã chạy | Mục đích | Kết quả thực tế |
|---|---|---|
| `bun test packages/core/src/intake/split/split.test.ts` | Kiểm tra bộ tách đơn vị `splitMultiIncidentReport` | **5 pass**, 0 fail, 20 expect() calls (9.00ms) |
| `bun test packages/core/src/intake/engine/pr9-split.test.ts` | Kiểm tra tích hợp pipeline cho flow tách từ legacy | **7 pass**, 0 fail, 95 expect() calls (142.00ms) |
| `bun test packages/core/src/intake/engine/split-adversarial.test.ts` | Kiểm tra 10 kịch bản đối kháng A–J từ legacy | **10 pass**, 0 fail, 92 expect() calls (212.00ms) |
| `bun test packages/core/src/intake/engine/engine.test.ts` | Kiểm tra toàn bộ engine chung và các nhánh cơ sở | **23 pass**, 0 fail, 57 expect() calls (189.00ms) |
| `bun test apps/tieulinh/receptionist-gap-register.test.ts` | Kiểm tra sổ đối chiếu tính năng lễ tân | **9 pass**, 0 fail, 1241 expect() calls (27.00ms) |
| `bun test packages/core/src/intake/engine/pr8-park.test.ts packages/core/src/intake/engine/pr7-ask-missing.test.ts` | Kiểm tra không hồi quy PR 7 & PR 8 | **21 pass**, 0 fail, 130 expect() calls (148.00ms) |
| `bun run /tmp/compare-split.ts` (script độc lập) | So sánh output 10 ca kiểm thử giữa legacy và core | **Khớp 100%** toàn bộ các trường `customerId`, `studentAccount`, `studentName`, `title`, `text` |
| `bun run /tmp/test-adversarial-patterns.ts` (script độc lập) | Đối chiếu 46 mẫu phản hồi quyết định tách/gộp/phủ định | **46/46 khớp** chính xác kỳ vọng |
| `bun run /tmp/test-sequential-three.ts` (script độc lập) | Mô phỏng tạo tuần tự 3 ticket từ 1 tin nhắn | **Tạo đủ 3 ticket** liên tiếp, kế thừa bộ phận, dọn sạch hàng đợi |

---

## 5. Những điểm lệch legacy có chủ ý và lý do

1. **Ngôn ngữ và nhãn tách biệt (`CopyCatalog`)**:
   - *Legacy*: Chuỗi câu hỏi tách, tiền tố hỏi lại, nhãn nút ("Tách N ticket", "Gộp 1 ticket"), thông báo ticket tiếp theo bị hardcode tiếng Việt trực tiếp trong `pipeline.ts`.
   - *Core PR 9*: Toàn bộ chuỗi văn bản được đưa qua `CopyCatalog` thông qua các khoá chuẩn (`split.question`, `split.unclear_prefix`, `split.next_ticket_notice`, `button.split_n`, `button.merge_one`, `media.ambiguous_notice`). Nhờ đó Core duy trì tính trung lập, không phụ thuộc cứng vào bất kỳ ngôn ngữ hay ứng dụng cụ thể nào.
2. **Kế thừa bộ phận theo vai trò trường (`FieldRole`)**:
   - *Legacy*: Đọc và ghi cứng vào tên trường `"Phòng ban"`.
   - *Core PR 9*: Dùng `resolveDeptField(variant)` truy vấn trường mang vai trò `department` từ domain catalog. Không so chuỗi tên trường cứng.
3. **Mô hình gói tin `StepOutput` và quản lý phiên**:
   - *Legacy*: Dùng `IntakePacket` với các trường phụ thuộc luồng chat Telegram bot legacy.
   - *Core PR 9*: Tuân thủ hợp đồng máy trạng thái sạch của `@vuihoc/bot-core`, trả về `createdIssue` cùng `nextDraft` có kiểu dữ liệu chặt chẽ (`docId`, `outcome`, `status`, `action`), phục vụ tốt cho cả bot Telegram, Webhook và giao diện tương tác mới.
