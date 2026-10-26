# Đặc tả: PR 9 của RFC 0002 — tách báo cáo nhiều sự cố (issue #23)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 9 của chuỗi lễ tân (`docs/rfc/0002-receptionist.md` mục 5),
issue #23. PR 1-8 đã merge (sổ đối chiểu, bản ghi vàng, kho binding, draft v2 + chuẩn hoá đầu
vào, bộ trích xuất + heuristic tiếng Việt, replay bóng + chỉ số M0-M4, hỏi bổ sung theo luật,
gác tờ khai khi có sự cố mới).

Đây là PR **lớn nhất** chuỗi: RFC 0002 mục 1.5 ghi cột "Khoảng trống" của B7 là **"Toàn bộ"**.

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker: kiểm base, ranh giới
  sửa, cấm, chất lượng code, test, bằng chứng, báo cáo, cách gửi `worker_done`.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 1.5 (dòng **B7**), mục 2.1 (ranh giới máy trạng thái, ba
  cổng LLM và đường lùi tất định), mục 5 (hàng PR 9).
- `docs/adr/0008-ticket-existing-write.md` — bất biến khi ghi vào ticket đã có.

**Quyết định của chủ liên quan** (đã ghi ở issue #20): `/telegram-webhook` và `ChannelSpec` giữ
nguyên như hôm nay. Không mở rộng phạm vi sang kênh.

## Target

- `packages/core/src/intake/split/` hoặc `packages/core/src/intake/engine/` — bộ tách, câu hỏi
  tách/gộp, xử lý phủ định, hỏi lại một lần, hàng đợi tạo ticket, `mediaAmbiguous`, gói tin
  hỗn hợp `createdIssue` + `nextDraft`.
- `packages/core/src/intake/draft/` — trạng thái chờ quyết định tách nếu cần.
- `packages/core/src/intake/create/` — đường tạo ticket có hàng đợi (nhiều ticket từ một tin).
- Test tương ứng; `packages/core/CHANGELOG.md`; `packages/core/docs/parity/ENGINE.md`; sổ đối
  chiểu `apps/tieulinh/receptionist-gap-register.test.ts`; `docs/`.

## Change

Theo RFC 0002 mục 1.5 dòng B7:

- **B7 — Tách báo cáo nhiều học sinh/sự cố trong một tin.** Nguyên văn yêu cầu:
  1. Hỏi **"Tách N ticket / Gộp 1 ticket"**.
  2. Hiểu **phủ định** ("không tách"), và **"thôi/khỏi" trần** là gộp.
  3. Trả lời **không rõ** thì hỏi lại **ĐÚNG MỘT LẦN** rồi **mặc định gộp**; **không bao giờ
     rơi nội dung**.
  4. Chọn tách thì **xếp hàng**, tạo **lần lượt**, **kế thừa bộ phận**.
  5. **Ảnh không chia mù** — gắn mọi ảnh cho mọi ticket, bật `mediaAmbiguous` để mô tả nói rõ.
  6. Gói tin hỗn hợp `createdIssue` + `nextDraft`.

**Bối cảnh đã có sẵn trong core (đã kiểm tra, đừng tin bảng RFC cũ):**

- `packages/core/src/intake/engine/text.ts` đã có `foldButton`, `mentionedIdentifiers`,
  `saysNewIncident` (từ PR 8).
- `packages/core/src/intake/extractor/heuristics.ts` đã có `extractLabelledIdentifiers`,
  `extractBlockInfo`, `isPersonNameOnly`, `deriveFallbackTitle`, `residualProse` (từ PR 8).
- `packages/core/src/intake/engine/engine.ts` đã có `detectPark` / `resolvePark` (PR 8) và
  `pendingSplit` trong trạng thái tờ khai.

**Còn phải làm:** bộ tách, câu hỏi, phủ định, hỏi lại một lần, hàng đợi, `mediaAmbiguous`,
gói hỗn hợp.

**Bộ tách phải port từ legacy** `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts`
`splitMultiIncidentReport` (và `extractBlockInfo` nếu chưa có — PR 8 đã có thì dùng lại,
**đừng chép lại**). Giữ nguyên hành vi, gồm các quy tắc dễ rơi:

- Tin ngắn hơn 30 ký tự → không tách.
- Có dấu hiệu "ví dụ" (`Vdu:`, `ví dụ`, `dưới đây là 2 HS`, `các HS`) → **một** sự cố hệ thống
  kèm ví dụ, **không** tách.
- Không có mô tả lỗi nào → không tách.
- Tách theo **hai dòng trống trở lên**; nếu chưa đủ thì thử tách theo **mẫu mở đầu khối mới**
  (số thứ tự `1.`/`2.`, `**Tên**`, `Code:`, mã CRM trần).
- Chỉ tách theo định danh **KHÁCH HÀNG / HỌC SINH có nhãn** — SĐT không tạo việc tách.
- Khối phải có **câu chữ riêng**, không chỉ là dòng tên người; khối không có câu chữ chỉ được
  tính khi có mã khách hàng hoặc mã đơn.
- Câu chữ chỉ là tên người → không tính.

## Tiêu chí chấp nhận

1. **Mọi test tách xanh, kể cả đối kháng** (`split-adversarial.test.ts`); **không có đường nào
   làm rơi chữ hay ảnh** — mọi nhánh (tách / gộp / trả lời không rõ / hủy) đều giữ nguyên
   nội dung.
2. Port được các ca của legacy:
   - `multi-incident.test.ts` (17 ca).
   - `split-adversarial.test.ts` (10 ca).
   - flow phần tách.
3. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
4. `packages/core/CHANGELOG.md` có mục cho PR 9; sổ đối chiểu và `ENGINE.md` khớp.
5. Cập nhật bảng khoảng trống ở `docs/rfc/0002-receptionist.md` mục 1.5 cho dòng B7 (chỉ sửa
   bảng, không sửa phần thiết kế).

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc.
- Không dùng `any`, không dùng khoá non-null trong code mới; không nới `biome.lint-baseline.json`.
- **Core không hardcode tên sản phẩm, tên công ty hay tên hệ thống của một app.** Dữ liệu miền đi
  qua tham số. (Xem cách PR 7 làm: cờ vai trò trung tính `FieldRole` trong catalog, không so
  chuỗi tên trường.)
- **Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`; nhãn không lộ tên trường kỹ thuật.**
  Core giữ **logic**, app giữ **chữ**.
- Logic tất định ở engine; không nhét quyết định vào prompt. Mọi cổng LLM giữ đường lùi tất định.
- Bất biến: không ghi vào ticket đã có khi chưa có bấm nút khớp nhãn (ADR-0008), không tự xác
  nhận, mô tả ticket nguyên văn (ADR-0010), không đè định danh, một lượt một khoá chat.
- Không đụng `/telegram-webhook` và `ChannelSpec`.

## Ownership

Được sửa: `packages/core/src/intake/**`, `packages/core/CHANGELOG.md`,
`packages/core/docs/**`, `apps/tieulinh/receptionist-gap-register.test.ts`, `docs/**`
(trong đó gồm `docs/rfc/0002-receptionist.md` mục 1.5 — chỉ sửa bảng khoảng trống),
`orchestration/report-23.md`, `orchestration/specs/issue-23-pr-9-split.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`, `apps/tieulinh/**` (trừ file sổ đối
chiểu nêu trên).

## Báo cáo

Ghi `orchestration/report-23.md`: đã làm gì, file nào đổi, lệnh đã chạy và kết quả thật, test
nào thêm/port, còn dở gì (và phần đó thuộc PR nào). Nếu có quy tắc nào của B7 **không** làm
được, ghi rõ vì sao thay vì bỏ qua im lặng.

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 9 / issue #23 xong" \
  --body "<3 câu: đã làm gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-23.md --json
```
