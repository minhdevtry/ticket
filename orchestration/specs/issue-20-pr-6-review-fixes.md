# Đặc tả sửa: PR 6 của RFC 0002 — sửa finding của hai reviewer (issue #20)

## Context

Repo: `minhdevtry/ticket`. Đây là **vòng sửa thứ hai** của PR 6 (issue #20) — chuỗi lễ tân
`docs/rfc/0002-receptionist.md` mục 5.

Nhánh: `minhdevtry/feat-pr-6-shadow-replay`, base: `origin/main` (đã merge PR 1-5).
Commit hiện có: `9a18eb4` (phần implement của PR 6).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 4.3 (ba tầng), 4.4 (phân lớp S0/S1/S2), 4.5 (chỉ số M0-M4).
- Báo cáo hiện tại: `orchestration/report-20.md`.

**Hai báo cáo reviewer đã có** (coordinator đã tự kiểm chứng lại từng điểm, không tin lời kể):

- `/tmp/review-20/standards-report.md` — trục chuẩn hoá code.
- `/tmp/review-20/spec-report.md` — trục đúng với đặc tả.

## Ownership

**Được sửa:**

- `tools/tl2-shadow/**`
- `packages/core/src/intake/**`
- `packages/core/src/testing/**`
- `packages/core/CHANGELOG.md`
- `packages/core/docs/**`
- `docs/**`
- `orchestration/report-20.md`
- `orchestration/specs/issue-20-pr-6-review-fixes.md` (file này)

**Không được sửa:** `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`, `apps/tieulinh/**`.

## Việc cần làm

Có **4 nhóm việc** dưới đây. Làm hết, theo thứ tự 1 → 4.

### 1. (Nặng) M3 phụ thuộc thứ tự duyệt và gom chung trường qua các chat

**Vấn đề.** Trong `calculateMetrics` (`tools/tl2-shadow/receptionist-replay.ts`, khoảng dòng
655-720), vòng lặp `for (const p of pairs)` vừa **thu thập** `tl1AskedFields` vừa **kiểm tra**
`!tl1AskedFields.has(f2)` trong cùng một lượt. Nếu TL2 hỏi trường F ở lượt 1 nhưng TL1 hỏi F ở
lượt 2, thì F bị tính nhầm là "TL2 hỏi thừa". Ngoài ra `tl1AskedFields` và `tl2AskedFields` là
`Set` dùng chung cho **toàn bộ** cặp trong file, nên trường của chat A lẫn vào chat B.

**Coordinator đã tái hiện:**
```
thuận: extra = 0.5  |  đảo: extra = 0
```
(cùng bộ cặp, chỉ đảo thứ tự → kết quả khác nhau. Đây là lỗi, không phải đặc tính.)

**Cần làm.**

1. Tách thành **hai lượt duyệt**:
   - Lượt 1: thu thập `tl1AskedFields` và `tl2AskedFields` **theo từng `chatId`**.
   - Lượt 2: tính `extraQuestionRate` và Jaccard **trên tập trường của chính chat đó**.
2. Một cuộc hội thoại = một `chatId`. Jaccard và tỉ lệ hỏi thừa phải tính **theo từng chat**, rồi
   mới gộp lại (đơn giản và rõ ràng: tính theo chat, lấy trung bình gọn cho báo cáo, và **in ra
   chi tiết từng chat** trong bảng chỉ số).
3. Số câu hỏi mà TL2 hỏi mà TL1 **không hỏi** phải so với tập trường TL1 hỏi **trong cùng chat**,
   tính cả trường TL1 hỏi ở lượt sau.
4. **Bằng chứng bắt buộc**: một test chứng minh đảo thứ tự cặp **không** đổi kết quả, và một test
   chứng minh trường của chat A không lẫn vào chat B. Test phải **thất bại** với code hiện tại.

### 2. (Trung bình) M2 thiếu trường, và S0 thiếu quy tắc

#### 2a. M2 phải đối chiếu đủ trường

RFC 0002 mục 4.5 định nghĩa M2 = "Ở lúc xác nhận, khớp chính xác **hệ thống, sản phẩm, bộ phận,
mức ưu tiên, định danh, số tệp**". Hiện tại `classifyDiff` (khoảng dòng 276-305) chỉ so `s.system`
và `s.reportingDept`, bỏ qua `priority`, `product`, `customerId`/`studentAccount`,
`attachmentCount` — dù `readTl1Summary` đã trích xuất đủ.

**Cần làm.** So đủ các trường theo RFC. Trường nào lệch thì phân lớp theo RFC 4.4:

- Mức ưu tiên, hệ thống, sản phẩm, bộ phận, định danh khác ở lúc xác nhận → **S1**
  (mã `ticket_field_mismatch`).
- Số tệp khác → **S1** (mã riêng, ví dụ `attachment_count_mismatch`).

Giá trị so sánh phải lấy từ `tl1.summary` và từ **tờ khai TL2** (`context.draft?.record?.values`).
Chuẩn hoá so sánh: bỏ khoảng trắng thừa, so không phân biệt hoa thường, và với `attachmentCount`
so bằng **số**.

**Lưu ý bộ khóa trường của TL2.** Trường trong tờ khai TL2 lấy từ `record.values`. Tên khóa phải
đúng với tên trong `packages/core/src/intake/draft/types.ts` và `gate/`. Trước khi viết, **grep
xem tên khóa thật** (`he_thong`, `bo_phan`, `muc_uu_tien`, ...) — đừng đoán. Nếu một trường TL1 có
mà tờ khai TL2 không có giá trị, thì coi là **chưa so được** (không tính là lệch, cũng không tính
là khớp) — ghi rõ trong báo cáo.

#### 2b. S0: bổ sung quy tắc còn thiếu

RFC 0002 mục 4.4 liệt kê S0 gồm: *"TL2 ghi vào ticket đã có khi TL1 chỉ hỏi; tạo ticket khi
người dùng chưa xác nhận; mất chữ người báo khỏi `rawText`; lộ phong bì kênh hoặc token `noop`
vào ticket; **đè định danh**; **huỷ/đóng ticket không phải của người báo**"*.

Hiện tại `classifyDiff` (khoảng dòng 173-230) chỉ có 4 quy tắc S0. Còn thiếu:

1. **Đè định danh** (mã `identifier_overwritten`): TL2 ghi đè định danh của ticket đã có.
2. **Huỷ/đóng ticket không phải của người báo** (mã `foreign_ticket_closed`): TL2 huỷ hoặc
   đóng ticket không thuộc người đang báo.
3. **Ghi vào ticket đã có khi TL1 chỉ hỏi** (mã `existing_ticket_write`): RFC nêu rõ đây là S0.
   Hiện tại dòng ~175 chỉ kiểm tra `tl2.outcome === "created"`, nên khi TL2 thực thi
   `action_done` (ghi vào ticket cũ) mà TL1 chỉ hỏi, lệch rơi xuống **S1** `action_mismatch` —
   sai theo RFC. Phải chặn ở S0.

**Cách phát hiện.** Dùng những gì `classifyDiff` **đã có** trong đầu vào:
`tl2.outcome` (có `action_done`, `action_canceled`, `closed_refusal`, `already_created`),
`tl2.createdTicket`, `context.draft` (có `issueIdentifier`, `issueId`), và
`tl1.summary`.

- `action_done` khi TL1 chỉ hỏi → S0 `existing_ticket_write`.
- `action_canceled` / `closed_refusal` khi định danh trong tờ khai **khác** định danh người báo
  đang theo dõi → S0 `foreign_ticket_closed`.
- `action_done` mà định danh đích **khác** `draft.issueIdentifier` → S0 `identifier_overwritten`.

Nếu một quy tắc **không quan sát được** từ đầu vào hiện có (ví dụ PR 11 chưa làm), thì:
**không bịa** — ghi rõ trong báo cáo là quy tắc nào chưa quan sát được và vì sao, để PR sau
làm. Đây là câu trả lời được chấp nhận; bịa quy tắc thì không.

**Mỗi quy tắc S0 mới phải có test** với tên test nêu rõ mã lệch (theo `CODING_STANDARDS.md` mục 7:
test phải chứng minh, không tự khẳng định).

#### 2c. M1: công thức tổng và bảng chi tiết phải khớp

`calculateMetrics` hiện mâu thuẫn: bảng theo action đếm `branch_mismatch` và
`ticket_field_mismatch` là **khớp** (dòng ~665), nhưng công thức tổng lại **trừ toàn bộ** `s1`
trừ `asked_other_field` (dòng ~713).

**Coordinator đã tái hiện:** 4 cặp, tất cả S1 →
`M1 tổng = 0.25` nhưng `rate theo action = 0.75`.

**Cần làm.** M1 theo RFC 4.5 = "tỉ lệ lượt TL2 cho **cùng lớp `action`** với TL1". Tức là M1 đo
**lớp hành động**, không đo mức độ giống nội dung. Vậy:

- `asked_other_field` (hỏi trường khác) → vẫn **cùng lớp action** → tính là khớp.
- `ticket_field_mismatch` (cùng hành động, khác giá trị) → vẫn **cùng lớp action** → khớp.
- `branch_mismatch`, `action_mismatch` → **khác lớp action** → không khớp.
- S0 → không khớp (và đếm riêng vào M0).

Sửa cho **một** công thức duy nhất, và bảng chi tiết theo action dùng **cùng** công thức đó.
Thêm test chứng minh tổng và chi tiết khớp nhau.

### 3. (Nhẹ) Vài điểm code và báo cáo

#### 3a. Nhánh `custom` của oracle không dùng

`packages/core/src/intake/engine/oracle.ts` định nghĩa `action: "custom"` với
`Object.assign(updated, decision.override)` (khoảng dòng 49-52 và 142-145). Không chỗ nào dùng,
và nó mở đường cho việc ghi đè tùy ý trạng thái tờ khai — tức là có thể phá bất biến.

**Cần làm: bỏ hẳn nhánh `custom`.** Không thay bằng hẳn khác. Nếu thấy cần, ghi lại trong báo cáo
là PR nào.

#### 3b. Báo cáo không khớp code thật

`orchestration/report-20.md` có ba chỗ sai so với code:

1. Dòng ~30 (mục 1.5) liệt kê S0 gồm "đè định danh" — nhưng code **không có** quy tắc này
   (xem 2b). Sau khi sửa 2b thì câu này mới đúng; nếu quy tắc nào chưa làm được thì phải bỏ
   khỏi danh sách và ghi vào mục "còn dở".
2. Dòng ~170 (mục 4, `compare.test.ts`) liệt kê test "Thoát mã 1 khi M0 > 0" — **không có test
   nào như vậy**; `compare.test.ts` chỉ có test mức hàm. Báo cáo nói quá.
3. Mục 3.5 ghi `bun run docs:snippets && bun run docs:refs`, nhưng **tiêu chí chấp nhận yêu cầu
   `bun run docs:check`** (gồm cả build site). Báo cáo phải ghi lệnh đã chạy **thật**, kèm kết
   quả thật.

**Cần làm.** Thêm test CLI thật cho điều kiện chặn: chạy `compare.ts --metrics` trên một cặp
có M0 > 0 và khẳng định **mã thoát khác 0**; và trên cặp M0 = 0 thì mã thoát 0. Test được spawn
tiến trình thật (`Bun.spawn` / `child_process`), không chỉ gọi hàm. Sau đó sửa lại báo cáo cho
khớp với code thật.

### 4. (Nhẹ) Import xuyên package trong `tools/tl2-shadow`

`tools/tl2-shadow/receptionist-replay.ts` và `classify-tl1.ts` import thẳng vào
`../../packages/core/src/...` (tới cả file fixture test `catalog.fixture.ts` và
`test-copy.fixture.ts`) thay vì qua subpath công khai `@vuihoc/bot-core/intake`.

`AGENTS.md` quy định: `packages/core` được import **qua subpath**. Cả hai app đã làm đúng.

**Cần làm.** Chuyển sang subpath công khai `@vuihoc/bot-core/intake`.

**Hai chỗ cần xử lý riêng:**

1. **Fixture của core.** `engineTestCatalog` và `TEST_COPY` nằm trong `packages/core/src/intake/engine/`
   và **không** nằm trong subpath công khai. Không được import file nội bộ qua đường dẫn tương
   đối. Cách làm đúng: **xuất chúng ra subpath công khai** (ví dụ thêm vào
   `packages/core/src/intake/index.ts` hoặc một subpath test riêng) rồi import qua subpath.
   Nếu xuất ra subpath công khai thì phải ghi `packages/core/CHANGELOG.md` (API công khai mới).
2. **Dependency của `tools/tl2-shadow`.** Package này hiện **không** khai báo dependency nào.
   Để import `@vuihoc/bot-core/intake` thì phải thêm `"@vuihoc/bot-core": "workspace:*"` vào
   `tools/tl2-shadow/package.json` và cập nhật `bun.lock`.

**Về `bun.lock`:** đặc tả gốc của PR 6 cấm sửa `bun.lock`, nhưng ở vòng sửa này thay đổi đó là
**bắt buộc** để import qua subpath. Coordinator cho phép sửa `bun.lock` **đúng một lần** cho
việc thêm dependency trên, và **không được** nâng cấp phiên bản dependency nào khác. Sau khi
`bun install`, kiểm tra `git diff bun.lock` — nếu có dòng nào đổi ngoài việc thêm
`@vuihoc/bot-core` vào workspace `tools/tl2-shadow` thì **hoàn nguyên** và báo lại. Nếu
`bun install` kéo theo thay đổi hàng loạt, hãy dừng và báo coordinator thay vì commit.

## Tiêu chí chấp nhận

1. **M3 ổn định theo thứ tự.** Test chứng minh đảo thứ tự cặp không đổi kết quả; test chứng
   minh trường không lẫn giữa các chat. Cả hai test **thất bại** với code trước khi sửa.
2. **M2 đối chiếu đủ 6 trường** theo RFC 4.5, có test cho từng trường lệch, phân lớp S1 đúng.
3. **S0 bổ sung** các quy tắc còn thiếu ở mục 2b, mỗi quy tắc có test mang mã lệch. Quy tắc
   nào không quan sát được thì **ghi rõ** trong báo cáo, không bịa.
4. **M1 tổng và bảng chi tiết khớp nhau**, có test.
5. **Nhánh `custom` của oracle đã bỏ** khỏi mã và khỏi test.
6. **Test CLI thật** cho `compare.ts --metrics`: M0 > 0 → mã thoát khác 0; M0 = 0 → mã thoát 0.
7. **Import trong `tools/tl2-shadow` qua subpath công khai**, không còn đường dẫn tương đối vào
   `packages/core/src/`. Dependency khai báo đúng, `bun.lock` chỉ đổi đúng một chỗ.
8. **`orchestration/report-20.md` khớp code thật** — không còn mục nào mô tả hành vi chưa có.
9. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0, `bun run scan` sạch.
10. `packages/core/CHANGELOG.md` có ghi mục cho các thay đổi API công khai của vòng sửa này
    (ít nhất là phần xuất fixture ra subpath).

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc. `apps/tieulinh/**` không được sửa.
- Không dùng `any`, không dùng khoá non-null (`!`) trong code mới; **không nới**
  `biome.lint-baseline.json` (chạy `bun run lint:baseline --base=origin/main` để chứng minh số lỗi
  không tăng).
- Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`; nhãn không lộ tên trường kỹ thuật.
- Logic tất định ở tool và engine; không nhét quyết định vào prompt.
- Mọi file cặp bóng, kho đệm và log: thư mục 0700, file 0600. ADR-0005 giữ nguyên.
- Không đụng secret.
- **Không commit, không push, không mở PR.** Coordinator sẽ commit và push.

## Báo cáo

Cập nhật `orchestration/report-20.md` — thêm mục **"6. Sửa sau review"** mô tả:
từng finding đã sửa ở đâu (file:dòng), từng finding **không** sửa được thì vì sao và thuộc PR
nào, và bằng chứng lệnh đã chạy với kết quả thật.

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 6 / issue #21 - sửa finding review xong" \
  --body "<3 câu: đã sửa gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-20.md --json
```
