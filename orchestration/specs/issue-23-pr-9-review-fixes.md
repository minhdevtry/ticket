# Đặc tả sửa: PR 9 của RFC 0002 — sửa finding review (issue #23)

## Context

Repo: `minhdevtry/ticket`. Đây là **vòng sửa thứ hai** của PR 9 (issue #23) — chuỗi lễ tân
`docs/rfc/0002-receptionist.md` mục 5.

Nhánh: `minhdevtry/feat-pr-9-split`, base: `origin/main` (đã có PR 1-8 của RFC 0002).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker.
- `AGENTS.md` và `CODING_STANDARDS.md` (mục 7: test phải chứng minh, không tự khẳng định).
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 1.2 (bảng khoảng trống, hàng B7) và mục 5 (hàng PR 9).
- `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts` và `pipeline.ts` (chỉ đọc) — đối chiếu parity.

**Bối cảnh.** Vòng implement đã xong, đã qua verify + docs:check (EXIT=0). Coordinator đã tự
tái hiện và xác nhận: bộ tách core khớp legacy **100%** trên 48 văn bản sinh tổ hợp; 22 test
mới xanh; sổ đối chiểu 9/9 xanh.

Vòng sửa này giao **6 việc**, xếp theo mức độ.

## Việc cần làm

### 1. (Trung bình) Nút bấm dùng nhãn làm `callbackData` nhưng bộ đọc so regex tiếng Việt cứng

**Vấn đề.** `engine.ts` đặt `callbackData = splitLabel = deps.copy.text("button.split_n", { count })`
— tức `callbackData` mang **chính nhãn hiển thị**. Nhưng `classifySplitReply`
(`packages/core/src/intake/split/replies.ts`) nhận diện ý bằng regex **tiếng Việt cứng**:
`/tách/`, `/gộp/`, `/đúng rồi|ok|.../`, `"thôi"`, `"khỏi"`.

**Coordinator đã tái hiện** (bản copy tiếng Anh của `test-copy.fixture.ts` dùng
`"Split {count} tickets"` và `"Keep 1 ticket"`):

```
"Split 2 tickets" -> unknown   ❌ bấm nút không tách
```

**Hệ quả đã đo (probe của coordinator trên engine thật, bản copy tiếng Anh):**
```
lượt 1: split_question      (nút: "Split 2 tickets")
lượt 2 (bấm nút "Split 2 tickets"): split_question   ← ĐỨNG YÊN, không tách không gộp
rawText sau đó: rỗng (0 ký tự)                       ← chữ chưa vào tờ khai
```

Nghĩa là **bấm nút "Tách" chết hoàn toàn** khi bộ copy không phải tiếng Việt — và đó **chính là
bộ copy mà test dùng** (`TEST_COPY`), nên bộ test hiện tại **không bắt được** lỗi này. (Nút "Gộp"
may mắn vì nhãn "Keep 1 ticket" chứa "1 ticket" khớp regex `/một ticket|1 ticket/` — nhưng đó là
trùng hợp, không phải cố ý.)

Đây là lý do ca test phải chạy với **cả hai** bộ copy: bản tiếng Việt (app thật) và bản tiếng
Anh (`TEST_COPY`) — và phải **bấm nút thật** (gửi `callbackData` của nút), không chỉ gọi hàm
phân loại.

**Cách sửa đúng — không hardcode tiếng Việt vào logic.** Bộ đọc phải nhận ra **chính nhãn nút**
mà engine gửi, thay vì đoán bằng regex ngôn ngữ. Gợi ý:

- `classifySplitReply` nhận thêm danh sách nhãn nút hợp lệ (`splitLabel`, `mergeLabel`) và so
  **chính xác** (đã `foldButton` như phần nút khác) trước khi rơi về regex.
- Regex tiếng Việt **giữ lại** làm đường dự phòng cho người báo **gõ tay** (đây là hành vi
  legacy cần giữ) — nhưng đường dự phòng phải là tiếng Việt vì người gõ tay bằng tiếng Việt.

**Cần làm.**
1. Sửa để bấm nút **luôn** được nhận ra, bất kể bản copy dùng ngôn ngữ nào.
2. Thêm test **bấm nút thật** (gửi `callbackData` của nút vào engine) với **cả hai** bộ copy:
   - bản tiếng Việt (`examples/tieulinh/copy.ts`): bấm "Tách N ticket" → tách, "Gộp 1 ticket" → gộp.
   - bản tiếng Anh (`TEST_COPY`): bấm "Split N tickets" → tách, "Keep 1 ticket" → gộp.
   Test tiếng Anh **phải thất bại** với code hiện tại, và phải khẳng định **cả đầu ra**: sau khi
   bấm nút tách thì tờ khai **có** chứa chữ của các khối (không rơi chữ).
3. Giữ nguyên hành vi gõ tay tiếng Việt ("không tách" → gộp, "thôi" → gộp, "tách 2 ticket" → tách).

### 2. (Trung bình) `deriveFallbackTitle` lệch parity ở ca không dựng được tiêu đề

Legacy (`multi-incident.ts:325`) kết thúc bằng `return "Sự cố kỹ thuật";`. Core
(`extractor/heuristics.ts:679`) kết thúc bằng `return "";` — đổi này có từ PR 8 (khi bỏ chuỗi
tiếng Việt hardcode khỏi core).

**Coordinator đã tái hiện:**
```
legacy: "Sự cố kỹ thuật"   core: ""
```
(chỉ lệch ở ca không dựng được tiêu đề; ca có mô tả lỗi thì hai bản khớp.)

**Hệ quả.** `split.ts` dùng `deriveFallbackTitle` để gán **tiêu đề từng khối**. Khối không dựng
được tiêu đề thì core để trống → tiêu đề ticket rỗng, khác legacy.

**Cách sửa.** Không đưa lại chuỗi `"Sự cố kỹ thuật"` vào core. Thay vào đó để **chỗ gọi** quyết
định chuỗi dự phòng, và chuỗi đó lấy từ `CopyCatalog`:

- Thêm khoá `CopyKey` cho tiêu đề dự phòng (ví dụ `ticket.fallback_title` — khoá này **đã có**
  từ PR 7, dùng lại, đừng tạo khoá thứ hai).
- Ở `split.ts` (chỗ gán tiêu đề từng khối) và ở `create-ticket.ts` / `engine.ts` (chỗ chốt
  tiêu đề chính), khi `deriveFallbackTitle` trả rỗng thì dùng `deps.copy.text("ticket.fallback_title")`.
- Kiểm tra khoá mới (nếu có) có mặt ở **cả** `packages/core/examples/tieulinh/copy.ts` và
  `packages/core/src/intake/engine/test-copy.fixture.ts`.

**Bắt buộc:** sau khi sửa, tiêu đề từng khối phải **khớp legacy** (kể cả ca dự phòng). Thêm test
so sánh tiêu đề từng khối giữa core và legacy trên một ca không dựng được tiêu đề.

### 3. (Nhẹ) Câu hỏi tách lệch câu chữ so với legacy

Legacy (`pipeline.ts:1167-1168`): `names = blocks.map((b) => b.studentName || b.customerId || "sự
cố")` → mỗi khối không tên đóng góp chuỗi `"sự cố"`, nên **2 khối không tên** in ra
`(sự cố, sự cố)`.

Core (`engine.ts:932-946`): khối không tên bị lọc bỏ, và khi không còn tên nào thì dùng khoá
`split.question_no_names` → in `(2 sự cố)`.

**Coordinator đã tái hiện:** `legacyQuestion(2, [{},{}])` = "...(sự cố, sự cố)..." khác
`coreQuestion(2, [{},{}])` = "...(2 sự cố)...".

Đây là **sai lệch người dùng thấy được** — RFC mục 1.2 yêu cầu "không mất hành vi nhìn thấy
được (chữ, nút, thứ tự hỏi...)".

**Cách sửa.** Dựng tóm tắt giống hệt legacy: mỗi khối không có tên cũng đóng góp `"sự cố"`, và
danh sách được nối bằng `", "`. Nếu giữ khoá `split.question_no_names` thì phải **bỏ** (không
dùng nữa) — hoặc sửa nội dung để khớp legacy. Chọn một cách và **ghi rõ trong báo cáo**.

### 4. (Nhẹ) Thứ tự kiểm tra "huỷ" và "tách" khác legacy, và thiếu điều kiện `media.length === 0`

**Legacy** (`pipeline.ts:761-773`): kiểm tra **tách trước**, rồi mới tới nhánh huỷ; nhánh huỷ có
điều kiện `intent === "cancel" && media.length === 0`.

**Core** (`engine.ts:252` nhánh huỷ, `engine.ts:273` nhánh tách): kiểm tra **huỷ trước**, và nhánh
huỷ **không** có điều kiện `media.length === 0`.

**Hệ quả.** Một tin dài đủ để tách mà extractor gán `intent === "cancel"` sẽ bị core huỷ thẳng
(bỏ cả nội dung) trong khi legacy hỏi tách. Và tin huỷ **có kèm ảnh** sẽ bị core huỷ, legacy
thì không.

**Cách sửa.** Đưa nhánh tách **lên trước** nhánh huỷ (khớp legacy), và thêm điều kiện
`media.length === 0` cho nhánh huỷ (khớp legacy). Thêm test chứng minh tin tách được với
`intent === "cancel"` vẫn hỏi tách, và tin huỷ kèm ảnh không bị coi là huỷ.

### 5. (Nhẹ) Ghi chú `mediaAmbiguous` chèn sai vị trí so với legacy

**Legacy** (`mcp/tieulinh/domain/ticket-formatter.ts:301-318`): dựng mục `### 📸 Ảnh đính kèm`
rồi đặt ghi chú *"Ảnh đính kèm chung cho các sự cố trong cùng lượt báo"* **ngay trong mục đó**.

**Core** (`create/create-ticket.ts:180-184`): nối thẳng ghi chú vào **cuối** `rawText`, không có
mục "Ảnh đính kèm".

**Cách sửa.** Khớp legacy: đặt ghi chú trong mục ảnh đính kèm. Nếu đường tạo ticket của core
chưa có mục "Ảnh đính kèm" (vì ảnh được đính kèm riêng qua `tracker.attach`), thì **ghi rõ
trong báo cáo** sự khác biệt này và lý do — hoặc sửa để chỗ nào hợp lý thì sửa. Đừng để tài
liệu tự mâu thuẫn.

### 6. (Trung bình + Nhẹ) Báo cáo và RFC không khớp code thật

1. **`orchestration/report-23.md`**:
   - Mục 3 ghi sai số test/expect (ví dụ "pr9-split.test.ts: 7 pass, 95 expect" — thực tế 9 pass,
     104 expect). Chạy lại và ghi **đúng số thật**.
   - Mục 2 (danh sách file) **thiếu** `packages/core/src/intake/split/replies.ts` và
     `packages/core/src/intake/split/replies.test.ts`.
   - Mục 4 phải liệt kê **đúng** các ca test, kèm số ca và file thật.
   - Ghi rõ ca test nào khẳng định điều gì (đừng ghi chung chung).
2. **Ca test "D." (dán lại báo cáo)** ở `split-adversarial.test.ts` chỉ assert
   `blocks.length === 2` — **không** assert điều mà báo cáo quy cho nó ("không nhân bản chữ").
   Thêm assert về `extraText` (không chứa lại toàn bộ báo cáo đã park).
3. **RFC 0002 dòng 166** (mục "Tổng kết khoảng trống") vẫn xếp B7 vào nhóm "core còn `Chưa`"
   trong khi hàng B7 (dòng 101) đã đổi sang `Đủ` → **tài liệu tự mâu thuẫn**. Sửa dòng 166 cho
   khớp.
4. **RFC mục 1.5 vs 1.2**: báo cáo và RFC gọi B7 là "mục 1.5", nhưng hàng B7 nằm ở **mục 1.2**
   (mục 1.5 là "Trích xuất, soát thông tin, ưu tiên"). Sửa lại tham chiếu cho đúng.

## KHÔNG sửa (đã kiểm chứng, không phải finding)

**Chữ bị nhân bản khi dán lại báo cáo nhiều HS — đây là lỗi CÓ SẴN Ở LEGACY, không phải hồi quy
của PR 9.** Coordinator đã tái hiện: sau khi dán lại báo cáo rồi gộp, mỗi mã học sinh xuất hiện
**2 lần** trong `rawText` — nhưng legacy có **đúng** điều kiện chống nhân bản giống hệt
(`pipeline.ts:1315-1316`: `buffered.blocks.some((b) => b.text.includes(carriedText))`), và legacy
test "D." cũng chỉ assert `blocks.length === 2`. Tức là core **port trung thực**.

**Tuy nhiên**, vì RFC nói "không bao giờ rơi nội dung" và chữ trùng là lỗi do người dùng thấy:

- **Không tự ý đổi luật** (sẽ lệch legacy).
- Nhưng hãy **ghi rõ** trong `orchestration/report-23.md` mục "còn dở" rằng: dán lại **cả** báo cáo
  nhiều khối sẽ làm chữ lặp trong `rawText`, legacy y hệt, và **đề xuất** một quyết định cho chủ
  (giữ nguyên parity, hay sửa cả hai cùng lúc trong một PR riêng).

Đây là việc cần **chủ quyết**, không tự sửa trong PR 9.

## Tiêu chí chấp nhận

1. Bấm nút "Tách"/"Gộp" **luôn** hoạt động, bất kể bộ copy dùng ngôn ngữ nào; test bằng bản copy
   tiếng Anh chứng minh điều này và **thất bại** với code trước khi sửa.
2. Tiêu đề từng khối **khớp legacy** trên mọi ca, kể cả ca dự phòng; có test so sánh.
3. Câu hỏi tách **khớp legacy** về câu chữ.
4. Thứ tự tách-trước-huỷ và điều kiện `media.length === 0` cho huỷ **khớp legacy**; có test.
5. Vị trí ghi chú `mediaAmbiguous` khớp legacy, hoặc ghi rõ lý do khác biệt trong báo cáo.
6. `orchestration/report-23.md` khớp code thật: đúng số test/expect, đủ danh sách file, đúng mô
   tả từng ca test.
7. RFC 0002: dòng 166 khớp hàng B7; tham chiếu mục đúng (1.2 không phải 1.5).
8. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
9. `bun run scripts/lint-baseline.ts --base=origin/main` — số lỗi của rule đang tắt **không tăng**.

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc.
- Không dùng `any`, không dùng khoá non-null (`!`) trong code mới; không nới
  `biome.lint-baseline.json`.
- **Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`; core không hardcode chuỗi hiển thị và
  không hardcode regex ngôn ngữ để nhận diện ý của người báo khi có thể dùng dữ liệu.**
- Logic tất định ở engine; không nhét quyết định vào prompt.
- Bất biến: không ghi vào ticket đã có khi chưa có bấm nút khớp nhãn (ADR-0008), không tự xác
  nhận, mô tả ticket nguyên văn (ADR-0010), không đè định danh, một lượt một khoá chat.
- **Không đổi hành vi quan sát được** ngoài những ghi ở trên (chỉ sửa để khớp legacy).

## Ownership

Được sửa: `packages/core/src/intake/**`, `packages/core/CHANGELOG.md`,
`packages/core/docs/**`, `apps/tieulinh/receptionist-gap-register.test.ts`, `docs/**`
(trong đó gồm `docs/rfc/0002-receptionist.md` — dòng 166 và tham chiếu mục), `orchestration/report-23.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`, `apps/tieulinh/**` (trừ file sổ đối
chiểu nêu trên).

## Báo cáo

Cập nhật `orchestration/report-23.md`: thêm mục **"7. Sửa sau review (vòng 2)"** mô tả từng việc
đã sửa (file:dòng, tên test), số liệu test **đúng thật**, và phần **còn dở** (gồm vấn đề chữ lặp
khi dán lại báo cáo nhiều khối — cần chủ quyết).

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 9 / issue #23 - sửa finding review xong" \
  --body "<3 câu: đã sửa gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-23.md --json
```
