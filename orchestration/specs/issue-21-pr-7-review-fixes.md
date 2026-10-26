# Đặc tả sửa: PR 7 của RFC 0002 — bổ sung test còn thiếu (issue #21)

## Context

Repo: `minhdevtry/ticket`. Đây là **vòng sửa thứ hai** của PR 7 (issue #21) — chuỗi lễ tân
`docs/rfc/0002-receptionist.md` mục 5.

Nhánh: `minhdevtry/feat-pr-7-ask-missing`, base: `origin/main` (đã có PR 1-6 của RFC 0002).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker: kiểm base, ranh giới
  sửa, cấm, chất lượng code, test, bằng chứng, báo cáo, cách gửi `worker_done`.
- `AGENTS.md` và `CODING_STANDARDS.md` (đặc biệt mục 7: test phải chứng minh, không tự
  khẳng định; mục 8: một hằng, một hàm, một kiểu: một chủ duy nhất).
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 1.5 (dòng B3 và A5).

**Bối cảnh.** Vòng implement đã xong và đã qua verify + docs:check (EXIT=0). Coordinator đã
tự tái hiện bằng probe và xác nhận các luật cốt lõi đúng: A3 hệ thống bị hỏi **đúng một lần**
qua 4 lượt; A4 giữ mức bằng chứng (`urgent`) ở cả hai vế (có lý do, và trả lời "không có").

Vòng sửa này **không đổi hành vi**, chỉ bổ sung những test còn thiếu.

## Việc cần làm

### 1. B3 — đường tạo ticket chốt tiêu đề chưa có test

`packages/core/src/intake/create/create-ticket.ts` đã đổi: tiêu đề rỗng hoặc là **tên người /
mã trần** thì dùng `deriveFallbackTitle(rawText)`, và nếu fallback cũng không hợp lệ thì dùng
`copy.text("ticket.fallback_title")`.

Nhưng **không file test nào trong `packages/core/src/intake/create/` thay đổi theo**. Vi phạm
hợp đồng worker §4 ("Đổi `packages/core` thì thêm test trong core") và CODING_STANDARDS §7.

**Cần làm.** Thêm test ở `packages/core/src/intake/create/create-ticket.test.ts` (đặt cạnh
file nguồn), khẳng định trên **đầu ra của tracker** (tức là `createIssue` được gọi với
`title` nào), không phải trên giá trị nội bộ:

1. Tiêu đề bình thường (do LLM điền, hợp lệ) → giữ nguyên.
2. Tiêu đề là **tên người** hoặc **mã trần** → không tới được tracker; thay bằng tiêu đề dự
   phòng từ lời báo.
3. Lời báo mà `deriveFallbackTitle` cũng không dựng được tiêu đề hợp lệ → dùng
   `copy.text("ticket.fallback_title")`.
4. Tiêu đề rỗng → cũng rơi về tiêu đề dự phòng.

Dùng bộ `copy` thật của test (`makeCopyCatalog(TEST_COPY)` hoặc tương tự) để khoá `ticket.fallback_title`
**có mặt** — nếu khoá thiếu thì `CopyCatalog.text()` ném lỗi lúc chạy.

### 2. A5 — câu hỏi "bộ phận ngoài danh mục" ĐÃ CÓ test, không cần làm thêm

**Coordinator đã kiểm chứng lại**: `packages/core/src/intake/extractor/extractor-dept-system-title.test.ts`
có test `"câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ"` (dòng ~100) —
khẳng định trên đầu ra engine, có cả phần `reportingDeptUnrecognized` được ghi vào tờ khai.
Phần này **đã đạt**, không cần bổ sung.

Chỉ cần xác nhận trong báo cáo rằng test đó tồn tại và phủ đúng ý (nêu tên test và dòng).

### 3. Chuỗi tiếng Việt hardcode trong core (finding của reviewer chuẩn hoá)

Ba chuỗi **mới thêm trong PR 7** (không có trong `origin/main`) đang nằm thẳng trong core.
Điều này vi phạm nguyên tắc "**core giữ logic, app giữ chữ**" và làm nội dung hiển thị bị
lai tạp ngôn ngữ khi đổi bộ copy.

| file:dòng | Chuỗi hardcode | Việc cần làm |
|---|---|---|
| `engine.ts:274` | `{ item: "ảnh anh/chị gửi" }` | Tham số nội suy cho `ask.describe_incident` phải lấy từ `CopyCatalog`, không viết thẳng trong core. |
| `engine.ts:892-893` | `derived[systemField] = "Chưa xác định"` (hai chỗ) | Giá trị "chưa xác định" cho hệ thống phải đến từ `CopyCatalog` (thêm khoá, ví dụ `field.unknown_value`). |
| `engine.ts:897-898` | `recapText = \`${recap}\n- Mức ưu tiên: ${priorityLabel}\`` và `recap.toLowerCase().includes("ưu tiên")` | Cả tiền tố dòng và việc **dò chữ "ưu tiên"** đều là chuỗi tiếng Việt trong core. Tiền tố phải đến từ `CopyCatalog`; việc dò "ưu tiên" phải **không** so chuỗi tiếng Việt — hãy so theo dữ liệu (ví dụ so trường `muc_do_uu_tien` trong recap, hoặc dùng cờ trung tính), vì nếu không thì đổi ngôn ngữ là hỏng. |

**Ràng buộc quan trọng:** khi bỏ so chuỗi tiếng Việt, **không được làm hỏng** hành vi hiện tại —
tóm tắt vẫn phải hiện đúng một dòng mức ưu tiên khi recap chưa có nó. Test hiện có
(`legacy-flows.test.ts` — "tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'")
là bảo vệ cho điều này; sau khi sửa, test đó **phải còn xanh**.

Mọi khoá `CopyKey` mới phải có mặt ở **cả** `packages/core/examples/tieulinh/copy.ts` và
`packages/core/src/intake/engine/test-copy.fixture.ts` — thiếu một chỗ thì
`CopyCatalog.text()` ném lỗi lúc chạy.

### 4. Rà lại: còn mã hành vi nào của A1-A5, B3, B4 chưa có test khẳng định?

Đặc tả yêu cầu port các ca của legacy: **ưu tiên tiếng Việt; nhãn không lộ tên trường; mặc
định Medium; bằng chứng urgent; 5 kịch bản "xin gấp"; hệ thống một lần (2 ca)**; và phần
tiêu đề (`isInvalidTitle`, `deriveFallbackTitle`) của `multi-incident.test.ts`.

Rà lại và **liệt kê** trong báo cáo: mã nào đã có test khẳng định, mã nào chỉ có code mà
chưa có test. Mã nào còn thiếu thì **bổ sung** (cùng cách: test khẳng định trên đầu ra hệ
thống). Nếu một mã không thể test được vì lý do kỹ thuật, ghi rõ lý do trong báo cáo thay vì
bỏ qua im lặng.

### 5. Báo cáo

Cập nhật `orchestration/report-21.md`: thêm mục **"7. Sửa sau review (vòng 2)"** mô tả từng
test đã bổ sung (file:dòng, tên test), các khoá `CopyKey` mới, bảng đối chiếu mã hành vi ↔
test, và bằng chứng lệnh đã chạy với kết quả thật.

## Tiêu chí chấp nhận

1. **B3**: test ở `packages/core/src/intake/create/create-ticket.test.ts` khẳng định trên
   `title` mà tracker nhận, gồm cả tên người / mã trần / rỗng / fallback không dựng được.
2. **Không còn chuỗi tiếng Việt hardcode trong core** ở ba chỗ nêu ở mục 3; mọi khoá
   `CopyKey` mới có mặt ở cả bản ví dụ lẫn bản test; test "tóm tắt hiện mức ưu tiên bằng
   tiếng Việt, không in 'MEDIUM'" **vẫn xanh**.
3. Bảng đối chiếu mã hành vi ↔ test trong báo cáo đầy đủ cho A1-A5, B3, B4.
4. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
5. `bun run scripts/lint-baseline.ts --base=origin/main` — số lỗi của rule đang tắt **không
   tăng**.

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc. `apps/tieulinh/**` không được sửa (trừ file sổ đối chiểu
  nếu thật sự cần).
- Không dùng `any`, không dùng khoá non-null (`!`) trong code mới; không nới
  `biome.lint-baseline.json`.
- **Vòng này KHÔNG đổi hành vi quan sát được** của engine, trừ việc dời chuỗi hiển thị ra
  `CopyCatalog` (mục 3) — đó là sửa *cách lấy chữ*, không phải sửa *kết quả*. Nếu phát hiện hành
  vi sai khác, **không tự sửa** — ghi vào báo cáo mục "còn dở" và báo coordinator. Sửa hành vi
  cần một đặc tả riêng.
- Test đặt cạnh file nguồn (`foo.ts` -> `foo.test.ts`). Test khẳng định trên **đầu ra của hệ
  thống**, không trên chuỗi mà chính test tự dựng ra. Test không gọi dịch vụ thật.
- Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`; nhãn không lộ tên trường kỹ thuật.

## Ownership

Được sửa: `packages/core/src/intake/**`, `packages/core/CHANGELOG.md` (nếu có thay đổi API
công khai — vòng này không có), `packages/core/docs/**`, `apps/tieulinh/receptionist-gap-register.test.ts`
(nếu thật sự cần), `docs/**`, `orchestration/report-21.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.

## Báo cáo

Cập nhật `orchestration/report-21.md` như mục 4 ở trên.

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 7 / issue #21 - bổ sung test xong" \
  --body "<3 câu: đã bổ sung test gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-21.md --json
```
