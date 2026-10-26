# Báo cáo PR 8: Gác tờ khai khi có sự cố mới (issue #22)

## 1. Đã làm gì (theo từng mục của đặc tả)

- **B5 — Định danh xung đột với tờ khai đang mở**:
  - Nhận diện định danh có nhãn cùng lớp qua `extractLabelledIdentifiers` và `identityConflict`: chỉ Code, Mã KH, Mã HS, UID/SID/CID, mã CRM 7-10 chữ số trọn dòng, SĐT có nhãn hoặc có sẵn trong lời kể (`allowBarePhone: true`). Tên người, SĐT trần mới, tài khoản, URL, mã phiếu không bao giờ tạo xung đột. So khớp theo lớp độc lập (`customer`, `student`, `phone`).
  - Trong `resolvePark`:
    - Trả lời không rõ thì hỏi lại bằng nút, không đoán, giữ nguyên `parkedPayload` (không làm mất dữ liệu bên nào).
    - Tin "thôi huỷ" (`isExplicitCancel`): bỏ tin vừa gác, giữ nguyên tờ khai hiện hành (status không đổi, dữ liệu không mất).
    - Chọn "Sự cố mới" (`saysNewIncident`, nút `button.new_incident`, `withTypedDetail`): mở tờ khai mới độc lập, gác tờ khai cũ qua `fresh.parkedDocId = draft.docId`.
    - Chọn "Bổ sung sự cố đang chờ": gộp tin vào tờ khai đang mở với cờ `skipConflictCheck: true`.
- **B6 — Tờ khai đang hỏi dở mà tin mới là lời báo trọn vẹn**:
  - Bổ sung ngoại lệ "đang trả lời câu hỏi" trong `detectPark`: nếu tờ khai đang hỏi câu hỏi dữ kiện kỹ thuật (`__tech`) hoặc mô tả (`short_description`), tin mới được xử lý như câu trả lời bổ sung thay vì gác nhầm.
- **A12 — `/new` và nút "Tiếp tục sự cố đang chờ"**:
  - `/new` (`forceNew: true`) gác tờ khai đang dở qua `fresh.parkedDocId`.
  - Tự động gắn lời nhắc tờ khai cũ đang chờ kèm nút `button.resume_parked` qua `appendParkedReminder` khi tờ khai mới hoàn tất tạo ticket (`ticket.created`) hoặc bị huỷ (`draft.canceled`).
  - Xử lý bấm nút `button.resume_parked` qua `resumeParkedDraft`: phục hồi tờ khai bị gác, tái đánh giá gate, re-emit bản tóm tắt xác nhận nếu đã đủ trường, không tự tạo thêm ticket.
- **CopyCatalog**:
  - Thêm các khoá `park.unclear`, `park.canceled`, `park.reminder`.
  - Định nghĩa bản tiếng Việt ở `packages/core/examples/tieulinh/copy.ts` và bản tiếng Anh ở `packages/core/src/intake/engine/test-copy.fixture.ts`.
- **Tiêu chí chống mất dữ liệu**:
  - Ba bài kiểm thử chuyên biệt khẳng định không rơi rụng một ký tự nào khi: chọn sự cố mới, chọn bổ sung, hoặc chọn thôi huỷ.

## 2. File nào đổi

- `packages/core/src/intake/ports.ts`: Thêm 3 khoá `park.unclear`, `park.canceled`, `park.reminder` vào `CopyKey`.
- `packages/core/examples/tieulinh/copy.ts`: Thêm chuỗi tiếng Việt cho 3 khoá trên.
- `packages/core/src/intake/engine/test-copy.fixture.ts`: Thêm chuỗi fixture tiếng Anh cho 3 khoá trên.
- `packages/core/src/intake/engine/text.ts`: Thêm `NEW_INCIDENT_SAID`, `saysNewIncident`, `stripNewIncidentDeclaration`, `withTypedDetail`.
- `packages/core/src/intake/engine/identifiers.ts`: Thêm `isGroundedInDigits`, `PHONE_OR_ACCOUNT_PATTERN`, `recoverAccountFromText`, `identityConflict`, re-export helpers từ heuristics.
- `packages/core/src/intake/engine/engine.ts`:
  - `detectPark`: kiểm tra định danh có nhãn cùng lớp, ngoại lệ B6 cho câu hỏi dữ kiện/mô tả.
  - `resolvePark`: xử lý 4 nhánh (Sự cố mới, Bổ sung, Thôi huỷ, Không rõ).
  - `finishCreate` & `collect` (cancel): gọi `appendParkedReminder`.
  - `run`: bắt nút `button.resume_parked` gọi `resumeParkedDraft`.
  - `mergeIntoDraft`: nhận `skipConflictCheck` để cập nhật định danh khi người dùng chọn bổ sung.
- `packages/core/src/intake/engine/identifiers.test.ts` (mới): Port 11 ca từ `identifier-grounding.test.ts` và 2 ca từ `multi-incident.test.ts`.
- `packages/core/src/intake/engine/pr8-park.test.ts` (mới): Port 8 ca flow từ `pipeline.flow.test.ts` và 3 ca "không mất dữ liệu bên nào".
- `apps/tieulinh/receptionist-gap-register.test.ts`: Cập nhật 18 dòng từ `deferred` sang `ported`.
- `packages/core/docs/parity/ENGINE.md`: Cập nhật bảng đối chiếu và số liệu (ported: 69 -> 87, deferred: 309 -> 291, PR 8: 0 deferred).
- `docs/rfc/0002-receptionist.md`: Cập nhật trạng thái dòng B5, B6, A12 thành "Đủ" trong bảng khoảng trống mục 1.5.
- `packages/core/CHANGELOG.md`: Thêm mục thay đổi chi tiết cho PR 8.

## 3. Lệnh đã chạy và kết quả thật

- `bun run --cwd packages/core test`:
  `1305 pass, 0 fail, 9090 expect() calls (45.53s)`
- `bun test packages/core/src/intake/engine/golden-intake.test.ts`:
  `9 pass, 0 fail, 11 expect() calls (0 unallowed diffs)`
- `bun test apps/tieulinh/receptionist-gap-register.test.ts`:
  `9 pass, 0 fail, 1241 expect() calls`
- `bun run scripts/lint-baseline.ts --base origin/main`:
  `ok style/noNonNullAssertion: không thêm lỗi mới (HEAD: 2, base: 2)`
  `ok suspicious/noExplicitAny: không thêm lỗi mới (HEAD: 0, base: 0)`
- `bun run verify`:
  `EXIT=0` (lint, lint:baseline, check, test, test:scripts, scan, docs:snippets, docs:refs)
- `bun run docs:check`:
  `EXIT=0` (build complete in 40.81s, docs:snippets pass, docs:refs pass)

## 4. Test nào thêm / port

- Port từ `apps/tieulinh-legacy/lib/identifier-grounding.test.ts` (11 ca):
  - `giữ lại đúng chữ số, bỏ khoảng trắng/dấu chấm/gạch ngang`
  - `giá trị có chữ số nằm trong nguồn thì grounded`
  - `giá trị toàn chữ (không có chữ số) coi như grounded — không đối chiếu được bằng số`
  - `giá trị không nằm trong nguồn thì KHÔNG grounded`
  - `moi lại đúng SĐT thật trong lời kể`
  - `không có số nào hợp lệ thì trả về undefined`
  - `hai SĐT thật sự khác nhau (khác sự cố) → xung đột`
  - `cùng một SĐT nhưng gõ có khoảng trắng/dấu chấm khác nhau → KHÔNG xung đột`
  - `một bên là tập con chữ số của bên kia (vd gõ thiếu số 0 đầu) → KHÔNG xung đột`
  - `một bên không có chữ số (mã toàn chữ) → không đối chiếu được, KHÔNG coi là xung đột`
  - `giá trị giống hệt nhau → không xung đột`
- Port từ `apps/tieulinh-legacy/lib/intake-step/multi-incident.test.ts` (2 ca):
  - `extractBlockInfo bỏ qua tham số URL, SĐT, TK/MK, mã phiếu thu; chỉ lấy định danh có nhãn`
  - `identityConflict chỉ so CÙNG LỚP định danh, và chỉ khi cả hai bên đều có`
- Port từ `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts` (8 ca):
  - `sau khi huỷ, lượt tiếp theo mở tài liệu mới và KHÔNG quên thông tin các lượt sau`
  - `chọn "Bổ sung sự cố đang chờ" → gộp tin B vào CHÍNH tờ khai A (người dùng đã xác nhận là cùng sự cố)`
  - `trả lời không rõ (không bấm 1 trong 2 nút) → hỏi lại, không đoán, không mất dữ liệu bên nào`
  - `đang hỏi sự cố mới hay bổ sung, người dùng gõ "thôi huỷ" → bỏ tin vừa rồi, tờ khai A giữ nguyên`
  - `B tạo ticket xong → ticket_created nhắc tên A kèm nút "Tiếp tục sự cố đang chờ"; bấm nút → quay lại đúng A (docId, SĐT, tiêu đề của A) chờ xác nhận`
  - `không có tờ khai nào bị gác lại → ticket_created bình thường, không có câu nhắc/nút phụ`
  - `B bị HUỶ (không tạo ticket) → packet "canceled" cũng nhắc về A còn đang chờ`
  - `customerId thật không bị reground/xoá dù symptoms LLM paraphrase không còn chữ số (TECH-956)`
- Thêm 3 ca kiểm thử "không mất dữ liệu bên nào":
  - `không mất dữ liệu (1/3): chọn 'Sự cố mới' giữ nguyên 100% chữ và trường của tờ khai A, tờ khai B độc lập`
  - `không mất dữ liệu (2/3): chọn 'Bổ sung sự cố đang chờ' gộp trọn vẹn cả nội dung A và B, không rơi rụng`
  - `không mất dữ liệu (3/3): chọn 'thôi huỷ' khi đang gác thì bỏ tin gác, tờ khai A giữ nguyên 100% dữ liệu`
- Thêm 4 ca kiểm thử ở vòng sửa review (vòng 2) trong `packages/core/src/intake/engine/pr8-park.test.ts`:
  - `pr8-park.test.ts:390`: `B6 ngoại lệ: tờ khai đang hỏi short_description (gửi ảnh) → tin mới là lời báo trọn vẹn KHÔNG bị gác mà xử lý như câu trả lời bổ sung`
  - `pr8-park.test.ts:423`: `B6 ngoại lệ: tờ khai đang hỏi câu hỏi kỹ thuật (__tech) → tin mới là lời báo trọn vẹn KHÔNG bị gác`
  - `pr8-park.test.ts:464`: `B6 phân biệt: tờ khai đang hỏi trường dữ kiện khác (không phải __tech/short_description) và tin mới là lời báo trọn vẹn → CÓ bị gác`
  - `pr8-park.test.ts:501`: `A12 nối liền: /new gác tờ khai đang dở → tạo ticket sự cố mới → nhận tin nhắc kèm nút resume → bấm nút phục hồi đúng tờ khai cũ giữ nguyên 100% dữ liệu`
## 5. Còn dở gì (và thuộc PR nào)

- `B7` (Tách báo cáo nhiều sự cố trong một tin): thuộc PR 9.
- `C1-C4` (Xử lý tin sau khi tạo ticket, định danh khác trên ticket đã tạo): thuộc PR 10.
- `D1-D7` (Lệnh nhắm vào ticket đã có): thuộc PR 11.
- `D8` (Huỷ/đóng ticket theo yêu cầu người báo): thuộc PR 12.
- `F1-F4` (Soát thông tin kỹ thuật): thuộc PR 13.
- `K6` (Chữ và domain dữ liệu app Tiểu Linh): thuộc PR 14.
- `K4, K1-K3` (Khai báo bot và adapter OpenClaw): thuộc PR 15, 16.


## 7. Sửa sau review (vòng 2)

### Đã làm
1. **Bổ sung test ngoại lệ B6** (`packages/core/src/intake/engine/pr8-park.test.ts`):
   - `pr8-park.test.ts:390`: `B6 ngoại lệ: tờ khai đang hỏi short_description (gửi ảnh) → tin mới là lời báo trọn vẹn KHÔNG bị gác mà xử lý như câu trả lời bổ sung` (chứng minh tờ khai đang hỏi mô tả khi chỉ gửi ảnh không bị gác nhầm khi gửi tiếp lời báo trọn vẹn).
   - `pr8-park.test.ts:423`: `B6 ngoại lệ: tờ khai đang hỏi câu hỏi kỹ thuật (__tech) → tin mới là lời báo trọn vẹn KHÔNG bị gác` (chứng minh tờ khai đang hỏi câu hỏi kỹ thuật từ `techReviewer` không bị gác nhầm).
   - `pr8-park.test.ts:464`: `B6 phân biệt: tờ khai đang hỏi trường dữ kiện khác (không phải __tech/short_description) và tin mới là lời báo trọn vẹn → CÓ bị gác` (chứng minh engine thật sự phân biệt được trường kỹ thuật/mô tả với trường dữ kiện thường, tránh trường hợp luôn không gác hoặc luôn gác).
2. **Bổ sung test nối liền A12 (`/new` → resume)** (`packages/core/src/intake/engine/pr8-park.test.ts:501`):
   - `A12 nối liền: /new gác tờ khai đang dở → tạo ticket sự cố mới → nhận tin nhắc kèm nút resume → bấm nút phục hồi đúng tờ khai cũ giữ nguyên 100% dữ liệu`: chạy xuyên suốt từ `/new` (`forceNew: true`) → gác tờ khai A cũ → mở tờ khai B → tạo ticket cho B → tin created nhắc A kèm nút resume → bấm nút phục hồi A → khẳng định tờ khai A giữ nguyên 100% dữ liệu (`ticket.rawText`, `ticket.title`, `record.values`) và chỉ có đúng 1 ticket được tạo.
3. **Bỏ chuỗi tiếng Việt hardcode trong core**:
   - `packages/core/src/intake/engine/engine.ts:788`: thay chuỗi `"sự cố trước đó"` bằng `""`, nhất quán với dòng 752 trong cùng file. Không còn tiếng Việt chèn vào bộ copy fixture tiếng Anh khi chạy test.
4. **Giữ nguyên nhóm hàm `saysNewIncident`/`withTypedDetail`**:
   - Theo đặc tả và đối chiếu legacy `pipeline.ts:1438`, nhóm hàm này là cần thiết cho hành vi B5 (người báo gõ văn bản thay vì bấm nút). Giữ nguyên, không xoá, không di chuyển.

### File đổi trong vòng 2
- `packages/core/src/intake/engine/engine.ts`: dòng 788 (`title = parked.ticket.title || ""`).
- `packages/core/src/intake/engine/pr8-park.test.ts`: bổ sung 4 ca kiểm thử (3 ca B6, 1 ca A12 nối liền).
- `orchestration/report-22.md`: cập nhật mục 4 và thêm mục 7.

### Bằng chứng lệnh đã chạy và kết quả thật
- `bun run --cwd packages/core test`:
  `1309 pass, 0 fail, 9127 expect() calls` (tăng 4 pass và 37 expect calls so với vòng 1)
- `bun test packages/core/src/intake/engine/pr8-park.test.ts`:
  `15 pass, 0 fail, 108 expect() calls`
- `bun run scripts/lint-baseline.ts --base origin/main`:
  `ok style/noNonNullAssertion: không thêm lỗi mới (HEAD: 2, base: 2)`
  `ok suspicious/noExplicitAny: không thêm lỗi mới (HEAD: 0, base: 0)`
- `bun run verify`:
  `EXIT=0` (lint, lint:baseline, check, test, test:scripts, scan, docs:snippets, docs:refs)
- `bun run docs:check`:
  `EXIT=0` (build complete in 39.65s, docs:snippets pass, docs:refs pass)
