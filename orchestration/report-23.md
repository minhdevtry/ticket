# Báo cáo PR 9: Tách báo cáo nhiều sự cố (issue #23)

## 1. Đã làm gì (theo từng mục của đặc tả)

PR 9 giải quyết trọn vẹn khoảng trống **B7** (RFC 0002 §1.2):

- **Bộ tách nhiều sự cố / học sinh (`splitMultiIncidentReport`)**:
  - Viết mới `packages/core/src/intake/split/split.ts` và export qua `packages/core/src/intake/split/index.ts` và `@vuihoc/bot-core/intake`.
  - Port đầy đủ các luật tất định từ legacy:
    - Tin < 30 ký tự → không tách.
    - Có dấu hiệu danh sách ví dụ (`EXAMPLE_LIST_MARKER`) như `vdu`, `ví dụ`, `dưới đây`, `các hs` → một sự cố hệ thống kèm ví dụ chứng cứ, không tách.
    - Không có từ chỉ lỗi (`EXPANDED_PROBLEM_WORDS`) → không tách.
    - Tách theo 2 dòng trống trở lên (`\n\s*\n+`); nếu không có, tách theo mẫu mở đầu khối mới (số thứ tự `1.`/`2.`, `**Tên**`, `Code:`, mã CRM 7-10 chữ số trần).
    - Chỉ tách theo định danh có nhãn (`customerId`, `studentAccount`), SĐT không tạo việc tách.
    - Khối phải có câu chữ riêng (`residualProse`) không chỉ là dòng tên người; khối không có câu chữ chỉ được tính khi có mã khách hàng hoặc mã đơn.
    - Chỉ tách khi có ≥ 2 giá trị cùng lớp khác nhau.
- **Câu hỏi tách hay gộp (`parkForSplitDecision`, `splitQuestionOutput`)**:
  - Nhận diện khi tin nhắn đầu tiên của tờ khai chứa ≥ 2 sự cố/học sinh độc lập.
  - Gác tờ khai vào `pendingSplit` (`blocks`, `mediaPaths`, `askedAt`).
  - Trả về `outcome: "split_question"` (ánh xạ sang legacy action `ask_split_or_merge`) kèm câu hỏi và 2 nút lựa chọn: `button.split_n` ("Tách N ticket") và `button.merge_one` ("Gộp 1 ticket").
- **Xử lý phản hồi, phủ định và "thôi/khỏi" trần (`resolvePendingSplit`)**:
  - Hiểu đồng ý tách: "tách", "Tách N ticket", "ừ", "ok", "oke", "okay", "vâng", "dạ", "chuẩn", "tạo đi", "yes", "đồng ý", "đúng" (khi không bị phủ định).
  - Hiểu phủ định: "không tách", "ko tách", "không cần tách ra đâu" → gộp 1 ticket.
  - Hiểu "thôi", "khỏi", "thôi ạ", "khỏi nhé" trần (`saysStopSplit`) → gộp 1 ticket.
  - Hiểu "không", "ko", "k", "no", "gộp 1 ticket", "để chung 1 ticket nhé" → gộp 1 ticket.
  - Huỷ tường minh: người báo nói huỷ ("thôi huỷ đi em") → thoát câu hỏi tách, xoá sạch `pendingSplit` và `pendingSplitQueue`, huỷ tờ khai an toàn.
- **Xử lý câu trả lời chưa rõ ý và hỏi lại 1 lần (`handleUnclearSplitReply`)**:
  - Tin nhắn trả lời không rõ ý (tin dán lại báo cáo, tin báo sự cố thứ 3, tin việc khác):
    - Không đánh rơi nội dung: chữ chưa rõ đưa vào `extraText`, ảnh mới đưa vào `mediaPaths`.
    - Dán lại một khối đơn lẻ đã park thì không nhân bản chữ.
    - Tin chỉ có ảnh hoặc tin `noop` được thêm ảnh / giữ nguyên trạng thái và hỏi lại.
    - Lần 1: hỏi lại đúng 1 lần (`clarifyCount: 1`) kèm lời thông báo giữ nguyên nội dung (`split.unclear_prefix`).
    - Lần 2 vẫn không rõ: mặc định gộp 1 ticket (`mergeParkedSplit`), không làm mất chữ hay ảnh.
- **Hàng đợi tạo ticket lần lượt và kế thừa bộ phận (`finishCreate`)**:
  - Khi chọn tách: ticket đầu tiên gom nội dung `firstBlock` + `extraText` và xử lý trước; các khối còn lại xếp vào `pendingSplitQueue`.
  - Khi ticket 1 tạo thành công (`status: "created"`):
    - Đẩy sự cố kế tiếp ra khỏi hàng đợi (`[nextBlock, ...remainingQueue]`).
    - Mở tờ khai mới `nextDoc = this.openFresh(...)`, liên kết `parkedDocId = createdDoc.docId`.
    - Kế thừa bộ phận người báo (`reportingDept`) từ tờ khai trước hoặc từ `nextBlock.reportingDept`.
    - Gom và đánh giá gate cho tờ khai kế tiếp (`this.collect`).
    - Trả về gói tin hỗn hợp `StepOutput` gồm `createdIssue` (ticket vừa tạo) + `nextDraft` (tờ khai kế tiếp đang mở, kèm `docId`, `action`, `status`), kèm thông báo `split.next_ticket_notice`.
    - Người báo chỉ cần xác nhận tiếp ("đúng rồi") là tạo được ticket tiếp theo.
- **Ảnh không chia mù (`mediaAmbiguous`)**:
  - Gắn toàn bộ ảnh cho mọi ticket khi tách nhiều khối (`mediaAmbiguous = true`).
  - Truyền cờ `mediaAmbiguous` xuyên suốt từ ticket 1 qua các ticket tiếp theo trong hàng đợi.
  - Khi tạo ticket, tự động chèn mục ảnh đính kèm (`media.attachments_heading`) và ghi chú đính kèm chung (`media.ambiguous_notice`) vào mô tả ticket.
- **Gộp 1 ticket (`mergeParkedSplit`)**:
  - Gộp toàn bộ các khối chữ và `extraText`, giữ toàn bộ ảnh (`mergedMedia`).
  - Tiêu đề tóm tắt được kiểm tra không bao giờ lấy tên người làm tiêu đề (`deriveFallbackTitle` kèm `studentNames`), fallback về `ticket.fallback_title` qua `CopyCatalog`.
- **TTL quá hạn im lặng**:
  - Sau 24h không tương tác ở câu hỏi tách, tờ khai hết hạn (`isExpiredDraft`). Tin mới ("chào em") mở sự cố mới (`clarify_intent` / `clarify`).

## 2. File nào đổi

- `packages/core/src/intake/extractor/heuristics.ts`:
  - Xuất khẩu hàm `residualProse` để bộ tách dùng chung, không định nghĩa lần hai.
- `packages/core/src/intake/split/split.ts` (mới):
  - Bộ tách `splitMultiIncidentReport`, hằng số `EXAMPLE_LIST_MARKER`, và kiểu `SplitOptions` (`fallbackTitle`).
- `packages/core/src/intake/split/index.ts` (mới):
  - Export module split (`split.ts`, `replies.ts`).
- `packages/core/src/intake/split/split.test.ts` (mới):
  - 6 ca test đơn vị cho `splitMultiIncidentReport`, bao gồm ca kiểm chứng tiêu đề dự phòng khớp legacy.
- `packages/core/src/intake/split/replies.ts` (mới):
  - Hàm thuần phân loại phản hồi tách/gộp (`classifySplitReply`), hỗ trợ `SplitReplyOptions` (`splitLabel`, `mergeLabel`) nhận diện nút bấm chính xác bất kể ngôn ngữ copy, regex tiếng Việt làm fallback cho người gõ tay.
- `packages/core/src/intake/split/replies.test.ts` (mới):
  - 5 ca test phân loại phản hồi tách/gộp, kiểm thử regex gõ tay và nhãn nút bấm tùy chỉnh tiếng Anh/Việt.
- `packages/core/src/intake/index.ts`:
  - Re-export `* from "./split"`.
- `packages/core/src/intake/ports.ts`:
  - Thêm các khoá `CopyKey`: `split.question`, `split.question_no_names`, `split.unnamed_item`, `split.unclear_prefix`, `split.next_ticket_notice`, `split.next_ticket_notice_student`, `button.split_n`, `button.merge_one`, `media.attachments_heading`, `media.ambiguous_notice`.
- `packages/core/examples/tieulinh/copy.ts`:
  - Bổ sung chuỗi tiếng Việt cho các khoá `CopyKey` mới.
- `packages/core/src/intake/engine/test-copy.fixture.ts`:
  - Bổ sung chuỗi tiếng Anh cho các khoá `CopyKey` mới.
- `packages/core/src/intake/create/create-ticket.ts`:
  - Chèn mục `media.attachments_heading` và ghi chú `media.ambiguous_notice` vào mô tả khi `claim.mediaAmbiguous` bật; xoá bỏ các non-null assertion.
- `packages/core/src/intake/engine/types.ts`:
  - Bổ sung các trường `createdIssue`, `nextDraft`, `docId` vào `StepOutput`.
- `packages/core/src/intake/engine/engine.ts`:
  - Đưa kiểm tra tách `splitMultiIncidentReport` lên trước nhánh huỷ (khớp legacy `pipeline.ts:761-773`), thêm điều kiện `mediaPaths.length === 0` cho huỷ.
  - Truyền `{ splitLabel, mergeLabel }` vào `classifySplitReply` khi xử lý phản hồi câu hỏi tách.
  - Chuẩn hoá `splitQuestionOutput`: mỗi khối không tên dùng `split.unnamed_item` ("sự cố"), nối bằng `", "` khớp legacy.
  - Trong `mergeParkedSplit`, khi không dựng được tiêu đề thì dùng `ticket.fallback_title` qua `CopyCatalog`.
  - Dọn dẹp non-null assertion trong `finishCreate` và `resolvePendingAction`.
- `packages/core/src/intake/engine/pr9-split.test.ts` (mới):
  - 14 ca kiểm thử tích hợp/flow (7 ca ban đầu + 5 ca mới sau review + 2 ca bổ sung kiểm chứng).
- `packages/core/src/intake/engine/split-adversarial.test.ts` (mới):
  - 10 ca kiểm chứng đối kháng từ legacy `split-adversarial.test.ts`, bổ sung assert rõ ràng cho `extraText` ở ca D.
- `apps/tieulinh/receptionist-gap-register.test.ts`:
  - Cập nhật 22 dòng test legacy từ `deferred` sang `ported`.
- `packages/core/docs/parity/ENGINE.md`:
  - Cập nhật marker gap-register: `total=450 core=61 ported=109 deferred=269 by-design=11`.
  - Cập nhật hàng PR 9: còn 0 dòng deferred.
- `docs/rfc/0002-receptionist.md`:
  - Cập nhật hàng B7 mục 1.2 sang "Đủ", xoá khoảng trống "Toàn bộ".
  - Sửa dòng 166 bỏ B7 và B3 khỏi nhóm "core còn Chưa".
- `docs/reference/intake-engine.md`:
  - Cập nhật mục Tờ khai v2 ghi nhận PR 9 đã hoàn thành đường ghi cho `pendingSplit`, `pendingSplitQueue`, `mediaAmbiguous`.
- `packages/core/CHANGELOG.md`:
  - Thêm mục thay đổi chi tiết cho PR 9 và các chỉnh sửa sau review.

## 3. Lệnh đã chạy và kết quả thật

- `bun test packages/core/src/intake/split/split.test.ts`:
  `6 pass, 0 fail, 26 expect() calls (34.00ms)`
- `bun test packages/core/src/intake/split/replies.test.ts`:
  `5 pass, 0 fail, 66 expect() calls (8.00ms)`
- `bun test packages/core/src/intake/engine/pr9-split.test.ts`:
  `14 pass, 0 fail, 140 expect() calls (137.00ms)`
- `bun test packages/core/src/intake/engine/split-adversarial.test.ts`:
  `10 pass, 0 fail, 93 expect() calls (150.00ms)`
- `bun test apps/tieulinh/receptionist-gap-register.test.ts`:
  `9 pass, 0 fail, 1241 expect() calls (63.00ms)`
- `bun run scripts/lint-baseline.ts --base=origin/main`:
  `ok style/noNonNullAssertion: không thêm lỗi mới (HEAD: 0, base: 3)`
  `ok suspicious/noExplicitAny: không thêm lỗi mới (HEAD: 0, base: 0)`
  `Số lỗi của các rule đang tắt không tăng so với nhánh nền 'origin/main'.`
- `bun run check`:
  `EXIT=0` (tất cả 4 workspace @vuihoc/bot-core, @vuihoc/tl2-shadow, @vuihoc/tieulinh, @vuihoc/tieulinh-legacy check pass)
- `bun run test`:
  `EXIT=0`
  - `@vuihoc/bot-core test: 1344 pass, 0 fail across 107 files (57.02s)`
  - `@vuihoc/tieulinh test: 77 pass, 0 fail across 8 files (21.54s)`
  - `@vuihoc/tl2-shadow test: 154 pass, 0 fail across 14 files (2.87s)`
  - `@vuihoc/tieulinh-legacy test: 938 pass, 27 skip, 0 fail across 88 files (59.79s)`
- `bun run test:scripts`:
  `61 pass, 0 fail across 6 files (63.00ms)`
- `bun run scan`:
  `✓ public-hygiene scan clean`
- `bun run docs:snippets`:
  `Mẫu code: 26 ts check, 14 ts run, 2 ts no-check.`
- `bun run docs:refs`:
  `Docs khớp code: 48 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.`
- `bun run docs:check`:
  `EXIT=0` (build complete in 44.47s, docs:snippets pass, docs:refs pass)

## 4. Test nào thêm / port (35 ca)

### `packages/core/src/intake/split/split.test.ts` (6 ca):
1. `splitMultiIncidentReport tách đúng 2 học sinh từ văn bản thật TECH-1146`: bóc tách độc lập 2 khối học sinh, kiểm tra phân lập trường định danh và text.
2. `splitMultiIncidentReport tách đúng 2 ca độc lập từ mã CRM (TECH-1248/1249)`: tách theo mã CRM đứng riêng dòng.
3. `splitMultiIncidentReport vẫn bắt được ca thật có 2 UID khác nhau (TECH-938)`: tách theo UID có nhãn.
4. `danh sách học sinh VÍ DỤ dưới một sự cố hệ thống KHÔNG bị tách (TECH-462, TECH-603)`: phát hiện `EXAMPLE_LIST_MARKER` và giữ nguyên 1 sự cố.
5. `cùng một học sinh nhắc lại ở 2 đoạn (mã KH ở đoạn này, thiếu ở đoạn kia) KHÔNG bị tách (TECH-560)`: kiểm tra không trùng lặp cùng 1 học sinh.
6. `tiêu đề từng khối khớp legacy (Sự cố kỹ thuật) trên ca không dựng được tiêu đề mô tả lỗi`: kiểm chứng `fallbackTitle` nhận từ `CopyCatalog` khi không có mô tả lỗi.

### `packages/core/src/intake/split/replies.test.ts` (5 ca):
7. `nhận diện đúng các biến thể đồng ý tách (split)`: kiểm tra các chuỗi gõ tay tiếng Việt ("tách", "ừ", "ok", "chuẩn", "đúng rồi"...).
8. `nhận diện đúng các biến thể đồng ý gộp / từ chối tách (merge)`: kiểm tra các chuỗi gõ tay ("không tách", "gộp 1 ticket", "thôi", "khỏi", "để chung"...).
9. `xử lý phủ định: 'không tách', 'đừng tách' tuyệt đối không nhận thành split`: xử lý tiền tố phủ định.
10. `trả về 'unknown' với câu trả lời không rõ ý hoặc chuyển chủ đề`: các câu trả lời chitchat, báo lỗi mới, noop.
11. `nhận diện nhãn nút tùy chỉnh qua options (kể cả tiếng Anh) bất kể ngôn ngữ copy`: kiểm chứng bấm nút tiếng Anh ("Split 2 tickets", "Keep 1 ticket") và fallback regex tiếng Việt.

### `packages/core/src/intake/engine/pr9-split.test.ts` (14 ca):
12. `TECH-1248 + TECH-1249: gửi 2 sự cố ở 2 lượt khác nhau — tách thành 2 ticket riêng, nội dung và ảnh không bị lẫn`.
13. `TECH-1146: một tin nhắn chứa 2 học sinh — hỏi tách ticket, khi tách mỗi ticket chỉ có đúng học sinh của mình`.
14. `TECH-1146 (chọn gộp 1 ticket): tiêu đề tóm tắt cả 2 học sinh, KHÔNG BAO GIỜ lấy tên người làm tiêu đề`.
15. `ảnh đính kèm không phân biệt được thuộc học sinh nào: đính kèm cả hai và có ghi chú rõ ràng`.
16. `BUG 5 — người báo gõ "không tách" thì GỘP, tuyệt đối không tách`.
17. `BUG 6/7 — đang hỏi tách mà người báo huỷ: thoát câu hỏi, xoá luôn hàng đợi tách`.
18. `BUG 6 (Vòng 3 — P1): đang hỏi tách mà người báo nhắn câu khác: hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket không mất nội dung`.
19. `khẳng định chuỗi copy split.question* và split.next_ticket_notice* giữ nguyên từng byte tiếng Việt cũ`.
20. `pipeline: thông báo tiếp theo chọn đúng khoá khi khối kế tiếp không có studentName`.
21. `bấm nút callbackData thật ("Split N tickets" / "Keep 1 ticket") hoạt động chính xác với bản copy tiếng Anh (TEST_COPY), tờ khai không rơi chữ`: khẳng định nút tiếng Anh hoạt động và tờ khai không rỗng.
22. `bấm nút callbackData thật ("Tách 2 ticket" / "Gộp 1 ticket") hoạt động chính xác với bản copy tiếng Việt (tieuLinhCopy), tờ khai không rơi chữ`: khẳng định nút tiếng Việt hoạt động và tờ khai không rỗng.
23. `thứ tự tách-trước-huỷ: tin nhắn tách được dù extractor đoán intent cancel vẫn hỏi tách (khớp legacy)`: kiểm tra tách trước huỷ.
24. `nhánh huỷ không kích hoạt khi tin huỷ có kèm ảnh (mediaPaths.length > 0) (khớp legacy)`: tin huỷ kèm ảnh không bị huỷ thẳng.
25. `câu hỏi tách cho khối không có tên học sinh/khách hàng dùng 'sự cố' (sự cố, sự cố) khớp legacy`: kiểm tra format tóm tắt khi không có tên.

### `packages/core/src/intake/engine/split-adversarial.test.ts` (10 ca):
26. `A. trạng thái chuẩn: hỏi tách → 'Tách 2 ticket' → 2 ticket, nội dung/ảnh không lẫn`.
27. `B. phủ định/hủy/gộp tại câu hỏi tách (Bug 5/6, P2: thôi/khỏi = merge)`.
28. `C. P1 (Blocker): câu trả lời KHÔNG rõ ý giữ nguyên báo cáo + ảnh, hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket`.
29. `D. dán lại y nguyên báo cáo 2 HS khi đang ở câu hỏi tách`: khẳng định `blocks.length === 2` và ghi nhận `extraText` theo parity legacy.
30. `E. trả lời bằng MỘT báo cáo mới có định danh KHÁC (HS thứ 3) khi đang hỏi tách`.
31. `F. không tách được — các dạng KHÔNG phải 2 sự cố độc lập`.
32. `G. P3: gói tin sau khi tạo ticket 1 khi còn hàng đợi rõ ràng contract (createdIssue + nextDraft)`.
33. `H. P1 (tin chỉ có ảnh / noop): ảnh được gộp vào báo cáo đã park và hỏi lại; noop không mất dữ liệu`.
34. `I. TTL: im lặng quá lâu ở câu hỏi tách`.
35. `J. P4: cụm mức ưu tiên và nhãn phòng ban/hệ thống trần KHÔNG BAO GIỜ là tiêu đề`.

## 5. Còn dở gì

1. **Vấn đề chữ lặp khi dán lại toàn bộ báo cáo nhiều khối (mục KHÔNG sửa)**:
   - *Hiện tượng*: Khi đang ở câu hỏi tách, nếu người báo dán lại y nguyên toàn bộ báo cáo gồm nhiều khối, điều kiện chống trùng của legacy (`pipeline.ts:1315-1316`: `buffered.blocks.some((b) => b.text.includes(carriedText))`) chỉ kiểm tra xem có khối đơn lẻ nào chứa toàn bộ tin dán lại hay không. Vì `carriedText` là văn bản tổng hợp của cả 2 khối nên không khối đơn lẻ nào chứa nó. Do đó, `carriedText` bị đưa vào `extraText`, và nếu sau đó người báo chọn gộp 1 ticket thì mỗi mã học sinh xuất hiện 2 lần trong `rawText`.
   - *Nguồn gốc*: Đây là lỗi CÓ SẴN Ở BẢN GỐC LEGACY (`pipeline.ts`), core port trung thực 100% để giữ nguyên parity.
   - *Đề xuất*: Không tự sửa trong PR 9 để tránh lệch hành vi tham chiếu legacy. Đề xuất chủ repo xem xét quyết định: giữ nguyên parity legacy hay mở PR riêng sửa cả core lẫn legacy cùng lúc.
2. **Cảnh báo lint `noCommaOperator` khi quét toàn repo**:
   - Khi chạy `bunx biome check apps/tieulinh/sla.test.ts`, file chỉ có 1 warning (không có error, mã giống hệt `origin/main`). Tuy nhiên khi quét toàn repo vượt ngưỡng diagnostic (100 diagnostic), Biome 2.5.15 phân loại warning cuối thành error. File này nằm ngoài ownership của PR 9 nên giữ nguyên, không sửa.
3. **Các PR kế tiếp của RFC 0002**:
   - PR 10: Tin sau khi tạo ticket (C1-C4, G2: ngữ cảnh ticket đã tạo, bổ sung comment không đè mô tả, nút theo ticket đang mở).
   - PR 11: Lệnh nhắm vào ticket đã có (D1-D7, D9: routing 72h, tra cứu, xem trước, sửa, chuyển ticket).
   - PR 12: Huỷ và đóng ticket theo yêu cầu người báo (D8 theo ADR-0006).

## 6. Sửa sau review (vòng 2)

Chi tiết 6 việc đã hoàn thiện theo đặc tả `orchestration/specs/issue-23-pr-9-review-fixes.md`:

1. **Nút bấm độc lập ngôn ngữ (Mục 1)**:
   - Sửa `classifySplitReply` (`packages/core/src/intake/split/replies.ts:21-45`) nhận thêm `SplitReplyOptions` (`splitLabel`, `mergeLabel`) và dùng `foldButton` so khớp chính xác nhãn nút trước khi rơi về regex tiếng Việt.
   - Sửa `engine.ts:976` truyền nhãn nút của `button.split_n` và `button.merge_one` từ `CopyCatalog`.
   - Bổ sung 2 test tích hợp trong `pr9-split.test.ts:611-696` bấm nút callbackData thật với cả hai bộ copy tiếng Anh (`TEST_COPY`) và tiếng Việt (`tieuLinhCopy`), khẳng định cả đầu ra `rawText` chứa đủ nội dung từng khối (không rỗng).
2. **Tiêu đề dự phòng từng khối qua CopyCatalog (Mục 2)**:
   - Giữ nguyên `heuristics.ts:679` trả `""` (không hardcode tiếng Việt trong core).
   - `splitMultiIncidentReport` (`packages/core/src/intake/split/split.ts:27-82`) nhận `SplitOptions` (`fallbackTitle`). Khi khối không dựng được tiêu đề mô tả lỗi, gán `title` bằng `fallbackTitle` lấy từ `deps.copy.text("ticket.fallback_title")`.
   - `engine.ts:1102` trong `mergeParkedSplit` cũng áp dụng fallback này khi gộp.
   - Bổ sung test đơn vị `split.test.ts:94-115` so sánh tiêu đề từng khối khớp legacy ("Sự cố kỹ thuật") trên ca không dựng được tiêu đề.
3. **Câu hỏi tách khớp legacy (Mục 3)**:
   - Thêm khoá `CopyKey` `split.unnamed_item` ("sự cố" trong `tieuLinhCopy`, "incident" trong `TEST_COPY`).
   - Sửa `engine.ts:936-944` trong `splitQuestionOutput`: mỗi khối không có `studentName` hoặc `customerId` sẽ đóng góp `unnamedItem`, nối danh sách bằng `", "`. Khối không tên in ra `(sự cố, sự cố)`, khớp 100% với legacy `pipeline.ts:1167-1178`.
   - Bổ sung test kiểm chứng trong `pr9-split.test.ts:742-754`.
4. **Thứ tự tách-trước-huỷ và điều kiện mediaPaths (Mục 4)**:
   - Sửa `engine.ts:251-285`: đưa khối kiểm tra tách `splitMultiIncidentReport` lên trước nhánh kiểm tra `extracted.userIntent === "cancel"`.
   - Thêm điều kiện `mediaPaths.length === 0` cho nhánh huỷ, khớp legacy `pipeline.ts:761-773`.
   - Bổ sung 2 test trong `pr9-split.test.ts:698-740` chứng minh tin tách được với intent `cancel` vẫn hỏi tách, và tin huỷ kèm ảnh không bị huỷ thẳng.
5. **Vị trí ghi chú `mediaAmbiguous` (Mục 5)**:
   - Thêm khoá `media.attachments_heading` ("### 📸 Ảnh đính kèm" / "### 📸 Attached images").
   - Sửa `create-ticket.ts:180-187`: đặt ghi chú `media.ambiguous_notice` ngay dưới mục `media.attachments_heading` trong mô tả ticket, khớp với cấu trúc `ticket-formatter.ts:301-318` của legacy.
6. **Báo cáo, RFC và khẳng định kiểm thử (Mục 6)**:
   - Cập nhật số liệu test thật (35 ca test split, toàn bộ xanh).
   - Bổ sung `replies.ts` và `replies.test.ts` vào danh sách file.
   - Thêm assert rõ ràng cho `extraText` trong test D của `split-adversarial.test.ts:376`.
   - Sửa `docs/rfc/0002-receptionist.md` dòng 166 bỏ B7 và B3 khỏi danh sách `Chưa`; chuẩn hoá tham chiếu hàng B7 là mục 1.2 (thay vì 1.5).
   - Xoá bỏ hoàn toàn các `!` non-null assertion trong `create-ticket.ts` và `engine.ts`, bảo đảm `lint-baseline.ts --base=origin/main` đạt HEAD=0 lỗi mới.
