# Báo cáo: PR 7 của RFC 0002 — Hỏi bổ sung theo luật (issue #21)

## 1. Đã làm gì (theo từng mục của đặc tả và góp ý coordinator)

### 1.1 A1 — Thiếu trường bắt buộc & Biến thể động
- **Nhánh (`variant`) hỗ trợ hàm suy ra**: Thay đổi kiểu `IntakeEngineDeps.variant` từ chuỗi hằng số sang `string | ((draft: IntakeDraft, record: IntakeRecord) => string)`. Toàn bộ các nhánh trong `IntakeEngine` (`toRecord`, `mergeIntoDraft`, `bumpAsked`, `questionButtons`, `summaryOutput`) gọi qua phương thức trung tâm `this.resolveVariant(draft, record)`, cho phép engine tự động chuyển nhánh động khi nhận được dữ liệu mới (ví dụ chuyển từ `product` sang `product+account`).
- **Ngân sách hỏi theo catalog**: `FieldSpec.maxRetries` cho phép định nghĩa ngân sách hỏi lại riêng cho từng trường; `readRecordFromInput` nhận diện `askedCount` từ working memory; `evaluateGate` dừng hỏi khi `questionCount >= retryBudget`.
- **Nút cho câu hỏi**: Đã xác nhận hoạt động chuẩn xác qua `questionButtons` và `fieldButtons`; cập nhật catalog thử trong `golden-intake.test.ts` sang kiểu `enum:phong_ban` khớp 100% các hàng nút với bản ghi vàng PR 2, cho phép xoá bỏ toàn bộ mục phân kỳ `buttons` của A1 trong `golden-intake.allowlist.ts`.
- **Ranh giới miền trung tính (góp ý 1)**: Thêm kiểu `FieldRole = "system" | "department"` vào `FieldSpec` và `RawField.role`/`RawField.vai_tro`. `resolveSystemField` và `resolveDeptField` ưu tiên cờ `role` trung tính hoặc tham số tiêm vào `systemField`/`departmentField` của `IntakeEngineDeps`; không hardcode tên trường miền tiếng Việt ("he_thong", "phong_ban", "bo_phan") trong core.

### 1.2 A2 — Chưa có mô tả sự cố
- Thêm kiểm tra `hasDescription(draft)`:
  - Nếu người báo chỉ gửi ảnh/tệp đính kèm mà chưa có chữ: bot ghi nhận `short_description` vào `lastAskedFields`, tăng lượt hỏi và gửi câu hỏi yêu cầu mô tả (`ask.describe_incident`: "Dạ em đã nhận ảnh anh/chị gửi rồi ạ. Anh/chị mô tả giúp em sự cố đang gặp...").
  - Nếu người báo chỉ gửi lời chào thuần tuý (`userIntent: "chitchat"`) khi chưa có nội dung: bot phản hồi làm rõ ý định (`clarify.greeting`: "Dạ em chào anh/chị! Anh/chị đang gặp sự cố gì, mô tả giúp em nhé ạ.").
  - Khi người báo trả lời mô tả ở lượt sau, `rawText` ghi nhận đầy đủ và chuyển tiếp vào đánh giá gate.

### 1.3 A3 — Hỏi hệ thống một lần kèm nút (ngoài gate)
- Triển khai luật hỏi hệ thống đúng MỘT lần ngoài gate: sau khi gate chính đã đủ điều kiện (`gate.isComplete`), nếu hệ thống chưa xác định và chưa từng hỏi (chưa có trong `explicitlyMissing` và `askedCount < 1`), bot sẽ hỏi hệ thống qua khoá `ask.system` kèm các nút lựa chọn enum.
- Nếu người báo từ chối ("không biết", "không rõ"), hệ thống được ghi nhận vào `explicitlyMissing`, bot không hỏi lại và tóm tắt hiển thị rõ "Chưa xác định" ở mục Hệ thống.

### 1.4 A4 — Xin gấp mà chưa nói lý do
- Triển khai trạng thái và câu hỏi `priority_reason`: khi người báo xin mức ưu tiên cao/khẩn cấp (`requestedPriority`) mà chưa cung cấp lý do, bot hỏi lý do đúng MỘT lần qua khoá `ask.priority_reason` (kèm mức ưu tiên lấy động từ `CopyCatalog`).
- Nếu người báo trả lời lý do: lý do được cắt trần 300 ký tự, lưu vào `draft.requestedPriority.reason` và nâng mức ưu tiên tương ứng.
- Nếu người báo trả lời "không có" (từ chối): mức ưu tiên được giữ nguyên theo bằng chứng (mặc định Medium hoặc mức sàn theo luật).
- **Tuân thủ bất biến ADR-0010 (góp ý 2)**: Không nối chuỗi `Lý do ưu tiên (người báo): ...` vào `description`. `description` là nguyên văn lời người báo; lý do gấp được lưu bền vững trên `draft.requestedPriority.reason` để module định dạng ticket (PR 14) đưa vào comment/trường riêng.

### 1.5 A5 — Bộ phận ngoài danh mục
- Khi người báo nhắc tới bộ phận không có trong danh mục (`unrecognizedDept`), ở lượt hỏi bổ sung bộ phận, bot sử dụng câu hỏi riêng `ask.unrecognized_dept` ("Bộ phận {dept} của anh/chị không có trong danh mục của em. Anh/chị chọn giúp em một trong các bộ phận sau nhé ạ.") kèm các nút lựa chọn enum thay vì lặp lại câu hỏi cũ.
- Khi người báo chọn bộ phận hợp lệ, `unrecognizedDept` được tự động dọn sạch khỏi tờ khai.

### 1.6 B3 — Chốt tiêu đề
- Tiêu đề được bảo vệ bằng `isInvalidTitle` và `deriveFallbackTitle` (đã đưa vào `heuristics.ts` ở PR 5, nay tích hợp trực tiếp vào đường xử lý tờ khai và tạo ticket).
- Không bao giờ chấp nhận tên người, mã trần hay lời chào trần làm tiêu đề ticket.
- Khi tiêu đề không hợp lệ hoặc rỗng: tự động rút dòng mô tả lỗi từ `rawText` và `symptoms`; nếu vẫn không trích được, sử dụng tiêu đề dự phòng từ `CopyCatalog` (`ticket.fallback_title`). Không hardcode chuỗi tiếng Việt trong core (góp ý 3).

### 1.7 B4 — Gộp trường
- **`structuredOnly`**: Khi tin nhắn là xác nhận, huỷ, cảm ơn hoặc từ chối trả lời, engine chỉ gộp các trường cấu trúc (định danh, giá trị enum, bằng chứng); không ghi đè tiêu đề và không bổ sung triệu chứng mới.
- **`removeSymptoms`**: Áp dụng loại bỏ các triệu chứng mà người báo yêu cầu gỡ.
- **Bằng chứng chỉ nới**: Mọi cờ bằng chứng boolean (`blocksPayment`, `dataLoss`, `blocksLearning`...) một khi đã `true` thì không bị ghi đè thành `false`; phạm vi `scope` chỉ tăng theo thứ tự bậc `SCOPE_RANK` (`none` < `single_user` < `group` < `entire_system`).

---

## 2. File nào đổi

- `packages/core/src/intake/draft/types.ts`: bổ sung trường `symptoms?: string[]` cho `IntakeDraft`.
- `packages/core/src/intake/gate/types.ts`: bổ sung `FieldRole = "system" | "department"`, thêm `role?: FieldRole` và `maxRetries?: number` vào `FieldSpec`.
- `packages/core/src/intake/gate/catalog.ts`: hỗ trợ `role` và `maxRetries` trong `normalizeField` và `retryBudget`.
- `packages/core/src/intake/gate/schema.ts`: hỗ trợ đọc `askedCount` trong `readRecordFromInput`.
- `packages/core/src/intake/ports.ts`: bổ sung các khoá `CopyKey` mới (`ask.system`, `ask.priority_reason`, `ask.unrecognized_dept`, `clarify.greeting`, `ask.describe_incident`, `ticket.fallback_title`, `priority.level.{low,medium,high,urgent}`).
- `packages/core/examples/tieulinh/copy.ts`: cập nhật bản dịch tiếng Việt cho các `CopyKey` mới.
- `packages/core/src/intake/engine/test-copy.fixture.ts`: cập nhật bản dịch tiếng Anh cho các `CopyKey` mới.
- `packages/core/src/intake/engine/types.ts`: thêm `missingFields?: string[]` vào `StepOutput`.
- `packages/core/src/intake/extractor/merger.ts`: xuất khẩu `SCOPE_RANK` và `EVIDENCE_FLAGS`.
- `packages/core/src/intake/create/create-ticket.ts`: chốt tiêu đề hợp lệ qua `isInvalidTitle`/`deriveFallbackTitle`/`copy.text("ticket.fallback_title")`; bảo toàn nguyên văn `ticket.rawText` cho `description` theo ADR-0010.
- `packages/core/src/intake/engine/engine.ts`:
  - `IntakeEngineDeps.variant`: hỗ trợ hàm phân giải động `(draft, record) => string`.
  - Hỗ trợ tham số `systemField` và `departmentField` tiêm từ bên ngoài.
  - Phân giải trường qua `role` trung tính trong catalog (`FieldRole`).
  - Kiểm tra `hasDescription` (A2); hỏi hệ thống 1 lần (A3); hỏi lý do gấp 1 lần (A4); câu hỏi bộ phận ngoài danh mục (A5); chốt tiêu đề (B3); gộp trường an toàn `structuredOnly`, `removeSymptoms`, bằng chứng đơn điệu (B4).
  - Tóm tắt hiển thị mức ưu tiên và tiêu đề theo `CopyCatalog`.
- `packages/core/src/intake/engine/golden-intake.test.ts`: catalog thử nghiệm khai báo `bo_phan` dạng `enum:phong_ban` khớp nút với bản ghi vàng.
- `packages/core/src/intake/engine/golden-intake.allowlist.ts`: xoá mục allowlist cho buttons A1 đã khớp hoàn toàn.
- `packages/core/src/intake/engine/legacy-flows.test.ts`: port 6 test flow từ legacy.
- `packages/core/src/intake/extractor/heuristics.test.ts` (mới): port 3 test đơn vị tiêu đề/tên người từ `multi-incident.test.ts`.
- `packages/core/src/intake/extractor/extractor-dept-system-title.test.ts`: port 1 test câu hỏi bộ phận ngoài danh mục từ legacy.
- `packages/core/src/intake/engine/pr7-ask-missing.test.ts` (mới): 6 test toàn diện cho variant động, ngân sách hỏi, media only, structuredOnly, removeSymptoms, bằng chứng đơn điệu.
- `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển 10 dòng sang `ported`; chuyển 3 dòng tool MCP sang PR 15.
- `packages/core/docs/parity/ENGINE.md`: cập nhật số liệu sổ đối chiếu (core=61, ported=69, deferred=309, by-design=11; PR 7: 0 deferred).
- `docs/rfc/0002-receptionist.md`: cập nhật bảng khoảng trống mục 1.5 cho các dòng A1-A5, B3, B4 thành `Đủ`.
- `packages/core/CHANGELOG.md`: ghi chú phát hành chi tiết cho PR 7.

---

## 3. Lệnh đã chạy và kết quả thật

### 3.1 Kiểm tra bản ghi vàng (`golden-intake.test.ts`)
```bash
bun test packages/core/src/intake/engine/golden-intake.test.ts
```
Kết quả:
```
 9 pass
 0 fail
 11 expect() calls
Ran 9 tests across 1 file. [153.00ms]
Allowlist không còn dòng thừa (mục buttons A1 đã bị xoá hoàn toàn).
```

### 3.2 Kiểm tra các test port và test mới
```bash
bun test packages/core/src/intake/engine/legacy-flows.test.ts \
         packages/core/src/intake/extractor/heuristics.test.ts \
         packages/core/src/intake/extractor/extractor-dept-system-title.test.ts \
         packages/core/src/intake/engine/pr7-ask-missing.test.ts
```
Kết quả:
```
 34 pass
 0 fail
 110 expect() calls
Ran 34 tests across 4 files. [280.00ms]
```

### 3.3 Kiểm tra toàn bộ package core
```bash
bun run --cwd packages/core test
```
Kết quả:
```
 1277 pass
 0 fail
 8978 expect() calls
Ran 1277 tests across 101 files. [45.57s]
```

### 3.4 Kiểm tra sổ đối chiếu lễ tân (`receptionist-gap-register.test.ts`)
```bash
bun test apps/tieulinh/receptionist-gap-register.test.ts
```
Kết quả:
```
 9 pass
 0 fail
 1241 expect() calls
Ran 9 tests across 1 file. [35.00ms]
Sổ đối chiếu và ENGINE.md khớp nhau 100%.
```

### 3.5 Kiểm tra tài liệu (`bun run docs:check`)
```bash
bun run docs:check
```
Kết quả:
```
copy-keys: 41 khoá
adr-index: 16 ADR
TypeDoc: markdown generated at ./reference/api
VitePress: build complete in 41.11s.
Mẫu code: 26 ts check, 14 ts run, 2 ts no-check.
Docs khớp code: 48 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
(EXIT 0)
```

### 3.6 Kiểm tra chất lượng và baseline (`bun run scripts/lint-baseline.ts`)
```bash
bun run scripts/lint-baseline.ts
```
Kết quả:
```
ok   style/noNonNullAssertion: 418 lỗi (cho phép tối đa 418)
ok   suspicious/noExplicitAny: 780 lỗi (cho phép tối đa 780)
Số lỗi của các rule đang tắt không tăng.
(EXIT 0)
```

---

## 4. Test nào thêm, test nào port

### Test port từ legacy (10 ca):
1. `packages/core/src/intake/engine/legacy-flows.test.ts`:
   - `tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'`
   - `câu hỏi dùng nhãn tiếng Việt, không lộ tên trường nội bộ, và nút được đẩy ra Telegram`
   - `mặc định Medium (không còn rơi về Low) và gửi Itsaplan chữ thường`
   - `xin gấp chưa có lý do → hỏi một lần; trả lời lý do → High`
   - `thiếu hệ thống: hỏi MỘT lần kèm nút, không biết thì tóm tắt ghi rõ 'Chưa xác định'`
   - `chọn hệ thống qua nút thì điền đúng giá trị`
2. `packages/core/src/intake/extractor/heuristics.test.ts`:
   - `chỉ coi là tên người khi từ ĐẦU là họ Việt và mọi từ viết hoa Unicode thật`
   - `chốt tiêu đề: nhận 8 tiêu đề Title-Case, từ chối tên người / mã trần / lời chào`
   - `deriveFallbackTitle lấy dòng mô tả lỗi, không lấy tên học sinh (TECH-1146)`
3. `packages/core/src/intake/extractor/extractor-dept-system-title.test.ts`:
   - `câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ`

### Test thêm mới cho PR 7 (6 ca trong `pr7-ask-missing.test.ts`):
- `variant là hàm suy ra: đổi nhánh động theo dữ liệu đầu vào`
- `ngân sách hỏi: trường hết ngân sách (askedCount >= budget) thì thôi hỏi`
- `A2: chỉ có ảnh (media) thì hỏi short_description`
- `B4: tin xác nhận / huỷ chỉ gộp trường cấu trúc, triệu chứng không bị ghi đè`
- `B4: removeSymptoms gỡ triệu chứng khỏi danh sách gộp`
- `B4: bằng chứng ưu tiên chỉ nới (evidence đơn điệu tăng)`

---

## 5. Còn dở gì, và phần đó thuộc PR nào

1. **Quyết định về vị trí ghi lý do ưu tiên (A4 vs ADR-0010)**:
   - Đặc tả A4 ghi *"lý do ghi vào ticket"*. Trong legacy cũ, lý do được nối chuỗi vào mô tả ticket (`Lý do ưu tiên (người báo): ...`).
   - Tuy nhiên, điều này xung đột với quyết định 1 của ADR-0010 (*"Mô tả ticket = lời nguyên văn của người báo. Không tóm tắt, không nhận định, không phỏng đoán"*).
   - Quyết định hiện tại ở PR 7: tuân thủ nghiêm ngặt ADR-0010, giữ nguyên văn `ticket.rawText` làm `description`, lưu trữ lý do nguyên vẹn trong trường cấu trúc `draft.requestedPriority.reason`. Việc đưa lý do này vào comment bot hay trường metadata riêng của Itsaplan sẽ do PR 14 (`ticket-formatter`) đảm nhiệm khi hoàn thiện định dạng ticket của Tiểu Linh.
   - Nếu chủ/coordinator muốn ngoại lệ cho phép chắp nối chuỗi vào `description`, cần có quyết định bổ sung sửa đổi ADR-0010.

2. **Chuyển 3 ca kiểm thử tool MCP sang PR 15**:
   - Ba bài kiểm thử liên quan đến bộ nhớ SQLite phòng ban của tool MCP (`checkRequiredFields: nhớ phòng ban vào sqlite, phiên sau thôi hỏi lại`, `checkRequiredFields: không khai bộ nhớ thì giữ nguyên hành vi cũ — vẫn hỏi lại`, và `SQLite persistence: đọc reporting_dept đã lưu & ghi nhận khi có reporting_dept hợp lệ`) đã được chuyển trạng thái `deferred` sang **PR 15** (PR xây dựng `defineBot` lễ tân thành pack MCP và trọn bộ tool MCP `intake_step`, `check_required_fields`, `validate_fields`).
   - Sau khi chuyển, PR 7 còn lại **0 dòng deferred** (đã port toàn bộ các ca thuộc phạm vi).

---

## 7. Sửa sau review (vòng 2)

### 7.1 Bổ sung test còn thiếu cho B3
Đã thêm 4 ca test khẳng định trên đầu ra tracker (`createIssue` được gọi với `title` nào) trong `packages/core/src/intake/create/create-ticket.test.ts`:
1. `tiêu đề bình thường (hợp lệ) → giữ nguyên khi gửi tới tracker`: kiểm tra tiêu đề hợp lệ do LLM điền được gửi nguyên vẹn đến tracker.
2. `tiêu đề là tên người hoặc mã trần → thay bằng tiêu đề dự phòng từ lời báo`: kiểm tra cả hai trường hợp tiêu đề là tên người Việt (`Trần Thị B`) và mã trần (`Code: 9100003`) không tới được tracker mà được thay thế bằng dòng mô tả sự cố rút từ `rawText`.
3. `lời báo không dựng được tiêu đề hợp lệ → dùng copy.text('ticket.fallback_title')`: kiểm tra trường hợp `rawText` chỉ có thông tin định danh/tên người, không trích xuất được tiêu đề lỗi, engine rơi về tiêu đề mặc định từ `CopyCatalog` (`ticket.fallback_title`).
4. `tiêu đề rỗng → rơi về tiêu đề dự phòng từ lời báo hoặc copy fallback`: kiểm tra tiêu đề rỗng hoặc chỉ có khoảng trắng rơi về fallback tương ứng.

### 7.2 Kiểm chứng test A5
Đã xác nhận test A5 đã tồn tại và phủ đúng ý: `packages/core/src/intake/extractor/extractor-dept-system-title.test.ts` (dòng 98) — test `"câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ"` khẳng định trên đầu ra engine, kiểm tra `reportingDeptUnrecognized` được ghi vào tờ khai và câu hỏi `ask.unrecognized_dept` được đưa ra kèm nút enum.

### 7.3 Dời toàn bộ chuỗi tiếng Việt hardcode trong core ra CopyCatalog
Đã chuẩn hoá 3 vị trí hardcode chuỗi tiếng Việt theo đúng nguyên tắc "core giữ logic, app giữ chữ":
1. **`ask.describe_incident_item`**: Thêm khoá `ask.describe_incident_item` vào `CopyKey` để nội suy `{item}` cho `ask.describe_incident`:
   - `packages/core/examples/tieulinh/copy.ts`: `"ảnh anh/chị gửi"`
   - `packages/core/src/intake/engine/test-copy.fixture.ts`: `"the image/media you sent"`
   - `packages/core/src/intake/engine/engine.ts:274`: lấy tham số nội suy từ `deps.copy.text("ask.describe_incident_item")`.
2. **`field.unknown_value`**: Thêm khoá `field.unknown_value` vào `CopyKey` cho giá trị chưa xác định:
   - `packages/core/examples/tieulinh/copy.ts`: `"Chưa xác định"`
   - `packages/core/src/intake/engine/test-copy.fixture.ts`: `"Unknown"`
   - `packages/core/src/intake/engine/engine.ts:893-895`: gán `derived[systemField]` và `gate.effectiveValues[systemField]` từ `deps.copy.text("field.unknown_value")`.
3. **`summary.priority_line` & loại bỏ so chuỗi tiếng Việt**:
   - Thêm khoá `summary.priority_line` vào `CopyKey`:
     - `packages/core/examples/tieulinh/copy.ts`: `"- Mức ưu tiên: {priority}"`
     - `packages/core/src/intake/engine/test-copy.fixture.ts`: `"- Priority: {priority}"`
   - `packages/core/src/intake/engine/engine.ts:899-908`: Bỏ hoàn toàn việc dò chuỗi `recap.toLowerCase().includes("ưu tiên")` và chuỗi hardcode `\n- Mức ưu tiên: ...`. Thay bằng kiểm tra theo dữ liệu: `hasPriorityInRecap` kiểm tra xem `variant.recapFields` có chứa trường ưu tiên (`priority`, `muc_do_uu_tien`, `muc_khan_cap`) hay không; nếu chưa có thì chèn dòng định dạng từ `deps.copy.text("summary.priority_line", { priority: priorityLabel })`. Test bảo vệ `tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'` tiếp tục xanh.
4. **Chuỗi dự phòng trong `deriveFallbackTitle`**:
   - `packages/core/src/intake/extractor/heuristics.ts:679`: Đổi `return "Sự cố kỹ thuật"` thành `return ""` khi không tìm thấy ứng viên tiêu đề từ lời báo, cho phép đường lùi về `copy.text("ticket.fallback_title")` trong `create-ticket.ts` và `engine.ts` hoạt động chuẩn xác theo ngôn ngữ của `CopyCatalog`.

### 7.4 Bảng đối chiếu mã hành vi ↔ test (A1-A5, B3, B4)

| Mã hành vi | Mô tả hành vi | Trạng thái test | File & Tên test |
|---|---|---|---|
| **A1** | Thiếu trường bắt buộc & Biến thể động (hàm variant, ngân sách hỏi theo catalog) | Đã có test | `pr7-ask-missing.test.ts`: `variant là hàm suy ra: đổi nhánh động theo dữ liệu đầu vào`<br>`pr7-ask-missing.test.ts`: `ngân sách hỏi: trường hết ngân sách (askedCount >= budget) thì thôi hỏi` |
| **A2** | Chưa có mô tả sự cố (chỉ có ảnh hỏi short_description, chào hỏi clarify) | Đã có test | `pr7-ask-missing.test.ts`: `A2: chỉ có ảnh (media) thì hỏi short_description` |
| **A3** | Hỏi hệ thống một lần ngoài gate kèm nút, không biết tóm tắt ghi rõ "Chưa xác định" | Đã có test | `legacy-flows.test.ts`: `thiếu hệ thống: hỏi MỘT lần kèm nút, không biết thì tóm tắt ghi rõ 'Chưa xác định'`<br>`legacy-flows.test.ts`: `chọn hệ thống qua nút thì điền đúng giá trị` |
| **A4** | Xin gấp: có lý do nâng mức, không có lý do giữ mức bằng chứng; mặc định Medium; bằng chứng urgent | Đã có test | `engine.test.ts`: `blocksPayment floor raises the created ticket to Urgent`<br>`engine.test.ts`: `requested priority honoured only with a reason (29/09 decision)`<br>`engine.test.ts`: `requested priority with NO reason is ignored`<br>`legacy-flows.test.ts`: `mặc định Medium (không còn rơi về Low) và gửi Itsaplan chữ thường`<br>`legacy-flows.test.ts`: `xin gấp chưa có lý do → hỏi một lần; trả lời lý do → High` |
| **A5** | Bộ phận ngoài danh mục: câu hỏi nói rõ không có trong danh mục kèm nút | Đã có test | `extractor-dept-system-title.test.ts:98`: `câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ` |
| **B3** | Chốt tiêu đề: tên người / mã trần / rỗng thay bằng fallback từ lời báo hoặc `ticket.fallback_title` | Đã bổ sung đầy đủ | `heuristics.test.ts`: `chốt tiêu đề: nhận 8 tiêu đề Title-Case, từ chối tên người / mã trần / lời chào`<br>`heuristics.test.ts`: `deriveFallbackTitle lấy dòng mô tả lỗi, không lấy tên học sinh (TECH-1146)`<br>`create-ticket.test.ts`: 4 ca test khẳng định trên đầu ra tracker |
| **B4** | Gộp trường: structuredOnly, removeSymptoms, bằng chứng chỉ nới | Đã có test | `pr7-ask-missing.test.ts`: `B4: tin xác nhận / huỷ chỉ gộp trường cấu trúc, triệu chứng không bị ghi đè`<br>`pr7-ask-missing.test.ts`: `B4: removeSymptoms gỡ triệu chứng khỏi danh sách gộp`<br>`pr7-ask-missing.test.ts`: `B4: bằng chứng ưu tiên chỉ nới (evidence đơn điệu tăng)` |

### 7.5 Bằng chứng lệnh đã chạy và kết quả thật
- `bun run --cwd packages/core test`: 1281 pass, 0 fail, 8993 expect() calls (44.15s).
- `bun run scripts/lint-baseline.ts`: 418/418 non-null assertions, 780/780 explicit any (số lỗi không tăng, EXIT 0).
- `bun run docs:check`: TypeDoc sinh sạch, VitePress build 48 trang hoàn tất, kiểm tra code snippets và refs khớp 100% (EXIT 0).
- `bun run verify`: EXIT 0 (toàn bộ lint, baseline, check, test, scan, docs đều sạch).
