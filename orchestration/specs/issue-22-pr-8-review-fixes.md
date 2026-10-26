# Đặc tả sửa: PR 8 của RFC 0002 — bổ sung test ngoại lệ B6 và nối liền /new (issue #22)

## Context

Repo: `minhdevtry/ticket`. Đây là **vòng sửa thứ hai** của PR 8 (issue #22) — chuỗi lễ tân
`docs/rfc/0002-receptionist.md` mục 5.

Nhánh: `minhdevtry/feat-pr-8-park`, base: `origin/main` (đã có PR 1-7 của RFC 0002).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker.
- `AGENTS.md` và `CODING_STANDARDS.md` (đặc biệt mục 7: test phải chứng minh).
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 1.5 (dòng B6, A12).

**Bối cảnh.** Vòng implement đã xong, đã qua verify + docs:check (EXIT=0) và qua review
trục đặc tả. Coordinator đã tự tái hiện và xác nhận: `extractLabelledIdentifiers` của core
khớp legacy **100%** trên 24 tổ hợp; ba ca "không mất dữ liệu" khẳng định thật; core không
hardcode tên miền; sổ đối chiểu khớp (`ported` 87, `deferred` 291).

Vòng sửa này **không đổi hành vi**, chỉ bổ sung test còn thiếu.

## Việc cần làm

### 1. (Chính) Thiếu test cho ngoại lệ B6

RFC 0002 mục 1.5 dòng B6 nói rõ: **"không áp dụng khi đang trả lời câu hỏi dữ kiện hay
mô tả"**. Code đã cài đặt ngoại lệ này (`packages/core/src/intake/engine/engine.ts`
`detectPark`, qua `answeringTechQuestion` và `answeringDescription`), nhưng **không test nào
kiểm chứng** — reviewer đặc tả đã xác nhận, và coordinator cũng đã grep lại: không có ca test
nào dựng tình huống tờ khai đang hỏi `__tech` (câu hỏi kỹ thuật) hoặc `short_description`
(câu hỏi mô tả) mà người dùng gửi một lời báo trọn vẹn.

Đây là nhánh dễ gác nhầm nhất của PR 8, nên **thiếu test ở đây là khoảng trống thật**.

**Cần làm.** Thêm test ở `packages/core/src/intake/engine/pr8-park.test.ts`:

1. Tờ khai đang hỏi `short_description` (chỉ có ảnh, hoặc người báo gửi ảnh) → người dùng
   gửi tiếp một lời báo trọn vẹn (đủ triệu chứng) → **không** bị gác; lượt đó được xử lý
   như câu trả lời bổ sung.
2. Tờ khai đang hỏi câu hỏi kỹ thuật (`__tech`, tức `TECH_INFO_FIELD`) → tin mới là lời
   báo trọn vẹn → **không** bị gác.
3. Ngược lại (để chứng minh test thật sự phân biệt được): tờ khai đang hỏi một trường dữ
   kiện **khác** (không phải `__tech`/`short_description`) và tin mới là lời báo trọn vẹn →
   **có** bị gác.

Ca (3) là quan trọng: nếu không có nó, một bản cài đặt luôn gác cũng xanh.

Test khẳng định trên **đầu ra của engine** (`out.outcome` là `"parked"` hay không), không
trên trạng thái nội bộ.

### 2. (Nhẹ) Thiếu test nối liền `/new` với đường resume

A12 quy định: `/new` ép sự cố mới, gác tờ khai đang dở; nút "Tiếp tục sự cố đang chờ" đưa
tờ khai gác trở lại. Hiện có **hai** ca rời rạc:
- `/new` chỉ kiểm tới bước gác (`parkedDocId` được đặt) — `engine.test.ts`.
- Nút resume được kiểm ở ngữ cảnh park, không phải ngữ cảnh `/new` — `pr8-park.test.ts`.

**Cần làm.** Thêm **một** ca chạy xuyên suốt: `forceNew` (tức `/new`) → tạo ticket của sự cố
mới → nhận tin nhắc kèm nút "Tiếp tục sự cố đang chờ" → bấm nút đó → tờ khai cũ được đưa
trở lại thành tờ khai đang mở, **giữ nguyên dữ liệu** (khẳng định trên `rawText`/`title`/
`values` của tờ khai cũ, so trước/sau).

### 3. Báo cáo phải khớp code thật

`orchestration/report-22.md` mục 1 mô tả đã cài đặt ngoại lệ B6, nhưng mục 4 ("Test nào
thêm / port") **không liệt kê test nào cho B6** — và trước khi sửa, đúng là không có test nào.

**Cần làm.** Sau khi bổ sung test ở mục 1 và 2, cập nhật mục 4 của báo cáo để **liệt kê tên
test và file:dòng** của các ca mới (đặc biệt ca ngoại lệ B6 và ca nối liền `/new`).

### 4. (Nhẹ) Chuỗi tiếng Việt hardcode trong core (finding của reviewer chuẩn hoá)

`packages/core/src/intake/engine/engine.ts:788`:

```ts
const title = parked.ticket.title || "sự cố trước đó";
const reminder = this.deps.copy.text("park.reminder", { title });
```

Chuỗi `"sự cố trước đó"` nằm thẳng trong core, nên khi chạy bộ copy tiếng Anh
(`test-copy.fixture.ts`: `"There is also an earlier incident «{title}» waiting to be
confirmed."`) thì tiếng Việt bị chèn vào câu tiếng Anh.

Cách sửa đúng và nhất quán với ngay dòng 752 trong cùng file (đã dùng `""`):

```ts
const title = parked.ticket.title || "";
```

**Ràng buộc:** khi sửa, kiểm tra câu nhắc vẫn đọc được khi **không có** tiêu đề (tờ khai
bị gác mà chưa có tiêu đề). Nếu `park.reminder` với `{title}` rỗng sinh câu rỗng hoặc câu
lạc, thì lấy nhãn từ `CopyCatalog` — **đừng để lại chuỗi tiếng Việt trong core**. Mọi khoá
`CopyKey` mới phải có mặt ở **cả** `packages/core/examples/tieulinh/copy.ts` và
`packages/core/src/intake/engine/test-copy.fixture.ts`.

Cách này **không đổi hành vi quan sát được** với câu chữ tiếng Việt của app — bản ví dụ vẫn
in ra "Còn sự cố «...» anh/chị báo trước đó đang chờ xác nhận ạ." như cũ.

## KHÔNG làm (đã kiểm chứng, không phải finding)

**Nhóm hàm `NEW_INCIDENT_SAID` / `saysNewIncident` / `withTypedDetail` KHÔNG phải là phần làm
thừa.** Reviewer trục đặc tả đã xếp chúng vào "Ngoài phạm vi" (cho là thuộc C2 của PR 10),
nhưng coordinator đã đối chiếu lại legacy:

- `apps/tieulinh-legacy/lib/intake-step/pipeline.ts:1438` — `resolvePendingNewIncident` (nhánh
  **park**: chọn "Sự cố mới" hay "Bổ sung sự cố đang chờ") dùng `saysNewIncident(reply)`.
- Nhánh park đó chính là **B5** của PR này, không phải C2 (C2 là "không bao giờ tự ghi vào
  ticket **đã tạo**", thuộc PR 10).

Vậy `saysNewIncident` là **cần** để port parity của B5 (người báo gõ "ticket mới ạ" thay vì
bấm nút). Worker đã làm đúng. **Không gỡ, không di chuyển.** Nếu báo cáo có nói chỗ này
thì giữ nguyên; không cần sửa.

## Tiêu chí chấp nhận

1. **Test ngoại lệ B6** đủ ba ca (mục 1), trong đó có ca chứng minh **có** gác khi hỏi
   trường dữ kiện khác — để chứng minh test phân biệt được.
2. **Test nối liền `/new` → resume** (mục 2) chạy xuyên suốt và khẳng định tờ khai cũ giữ
   nguyên dữ liệu.
3. **Không còn chuỗi tiếng Việt hardcode** ở `engine.ts:788`; câu nhắc `park.reminder` vẫn
   đọc được khi tờ khai bị gác chưa có tiêu đề; nếu thêm khoá `CopyKey` thì khoá đó có mặt ở
   cả bản ví dụ lẫn bản test.
4. `orchestration/report-22.md` mục 4 liệt kê tên test mới và file:dòng.
5. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
6. `bun run scripts/lint-baseline.ts --base=origin/main` — số lỗi của rule đang tắt **không
   tăng**.

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc. `apps/tieulinh/**` không được sửa (trừ file sổ đối chiểu
  nếu thật sự cần).
- Không dùng `any`, không dùng khoá non-null (`!`) trong code mới; không nới
  `biome.lint-baseline.json`.
- **Vòng này KHÔNG đổi hành vi** của engine. Nếu phát hiện hành vi sai, **không tự sửa** —
  ghi vào báo cáo mục "còn dở" và báo coordinator.
- Test đặt cạnh file nguồn (`foo.ts` -> `foo.test.ts`). Test khẳng định trên **đầu ra của hệ
  thống**. Test không gọi dịch vụ thật.
- Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`; nhãn không lộ tên trường kỹ thuật.

## Ownership

Được sửa: `packages/core/src/intake/**`, `packages/core/CHANGELOG.md` (nếu có thay đổi API
công khai — vòng này không có), `packages/core/docs/**`,
`apps/tieulinh/receptionist-gap-register.test.ts` (nếu thật sự cần), `docs/**`,
`orchestration/report-22.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.

## Báo cáo

Cập nhật `orchestration/report-22.md`: thêm mục **"7. Sửa sau review (vòng 2)"** mô tả các
test đã bổ sung (file:dòng, tên test) và bằng chứng lệnh đã chạy với kết quả thật.

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 8 / issue #22 - bổ sung test xong" \
  --body "<3 câu: đã bổ sung test gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-22.md --json
```
