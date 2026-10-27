# Báo cáo thực hiện: Issue #66 — Script đồng bộ cấu hình project TECH2 trên server Itsaplan

## 1. Đã làm gì (theo từng mục của đặc tả)

### Mục 1: Xây dựng script công cụ `scripts/sync-itsaplan-project.ts`
- **Kết nối Itsaplan**: Kết nối qua `ItsaplanClient` với URL và API key từ biến môi trường (`ITSAPLAN_BASE_URL`, `ITSAPLAN_API_KEY`).
- **Giao diện dòng lệnh (CLI)**: Hỗ trợ đầy đủ các tham số theo đặc tả:
  - `--source <key>`: Project nguồn đọc cấu hình (mặc định: `TECH`).
  - `--target <key>`: Project đích đồng bộ sang (mặc định: `TECH2`).
  - `--name <text>`: Tên project đích nếu phải tạo mới (mặc định: `"Tech Sandbox"`).
  - `--team <slug>`: Team slug trên Itsaplan (mặc định: `tech`).
  - `--dry-run`: Cờ kiểm tra và in kế hoạch thay đổi, tuyệt đối không gửi mutation lên server.
  - `--help`, `-h`: Hiển thị hướng dẫn sử dụng.
- **Cơ chế an toàn (Safety Rails)**:
  - Source `TECH` tuyệt đối **READ-ONLY 100%**: Chỉ gọi `GET /projects/:sourceKey`, không bao giờ gửi bất kỳ mutation nào (`POST`, `PATCH`, `PUT`, `DELETE`) lên project nguồn.
  - Chặn ngay lập tức nếu `--target` trùng với `--source` (không phân biệt hoa/thường) với thông báo lỗi: `Target project cannot be identical to source project`.
  - Kiểm tra biến môi trường `ITSAPLAN_BASE_URL` và `ITSAPLAN_API_KEY`, hướng dẫn thiết lập rõ ràng và thoát với mã lỗi 1 nếu thiếu.
- **Kiểm tra & Khởi tạo Project**:
  - Đọc project nguồn `getProject(sourceKey)`.
  - Kiểm tra project đích `getProject(targetKey)`. Nếu chưa tồn tại (404), gọi `createProject({ key: targetKey, name: targetName, preset: "empty" })` (hoặc log kế hoạch tạo nếu `--dry-run`).
- **Đồng bộ Cột Trạng thái (Columns)**:
  - Đọc danh sách cột của source, sắp xếp theo thứ tự `position`.
  - Đối chiếu với cột hiện có trên target (so khớp không phân biệt hoa thường theo `name.trim().toLowerCase()`):
    - Cột chưa có: gọi `createColumn(targetKey, { name, stateType, color, position })`.
    - Cột đã có nhưng khác `stateType` hoặc `color`: gọi `updateColumn(targetKey, columnId, patch)`.
  - Sắp xếp thứ tự các cột trạng thái (`reorderColumns`) khớp thứ tự nguồn; chỉ gọi mutation khi thứ tự thực tế trên target bị lệch.
- **Đồng bộ Nhãn (Labels)**:
  - Đọc danh sách nhãn của source.
  - So khớp với nhãn hiện có trên target, tạo nhãn thiếu qua `createLabel(targetKey, { name, color })`.
- **Tính luỹ kế (Idempotent)**:
  - Khi target đã có đủ cột/nhãn và đúng cấu hình/thứ tự, script thực hiện 0 mutation.
  - Log chi tiết từng bước thực hiện và tổng kết số lượng tài nguyên đã tạo/cập nhật.

### Mục 2: Cập nhật `package.json`
- Bổ sung npm script: `"itsaplan:sync-project": "bun run scripts/sync-itsaplan-project.ts"`.
- Bổ sung `scripts/sync-itsaplan-project.test.ts` vào npm script `"test:scripts"` để tự động chạy trong pipeline `bun run verify`.

### Mục 3: Viết bộ kiểm thử toàn diện `scripts/sync-itsaplan-project.test.ts`
- Sử dụng mock HTTP server bằng `Bun.serve({ hostname: "127.0.0.1", port: 0 })`.
- Kiểm thử đầy đủ 11 ca kiểm thử:
  1. Ca 1: Target chưa tồn tại -> tạo project và tạo đủ 5 cột, 3 nhãn.
  2. Ca 2: Target đã tồn tại một phần -> chỉ bổ sung cột/nhãn thiếu, cập nhật cột lệch `stateType`/`color`, không gọi tạo project.
  3. Ca 3: Target đã đồng nhất -> không thực hiện bất kỳ mutation nào (0 POST/PATCH/PUT/DELETE, 100% idempotent).
  4. Ca 4: Cờ `--dry-run` -> không gửi bất kỳ POST/PATCH/PUT/DELETE nào (100% GET).
  5. Ca 5: Target trùng với Source -> chặn an toàn ngay lập tức, không gửi mutation.
  6. Ca 6: Source không tồn tại -> ném lỗi rõ ràng.
  7. Ca 7: Reorder cột khi thứ tự cột trên target bị đảo.
  8. Ca 8: CLI `parseArgs` hỗ trợ đầy đủ các dạng cờ `--source`, `--target`, `--name`, `--team`, `--dry-run`, `-h`.
  9. Ca 9: CLI `runCli` báo lỗi thoát 1 khi thiếu biến môi trường.
  10. Ca 10: CLI `runCli` xử lý cờ `--help` thành công thoát 0.
  11. Ca 11: CLI `runCli` chạy trọn vẹn với mock client ở chế độ dry-run thoát 0.
- Khẳng định 100% không có mutation nào gọi lên source `TECH` ở mọi ca kiểm thử.

---

## 2. File nào đổi

- `scripts/sync-itsaplan-project.ts`: File mới (script đồng bộ chính).
- `scripts/sync-itsaplan-project.test.ts`: File mới (bộ kiểm thử mock Bun.serve).
- `package.json`: Thêm script `"itsaplan:sync-project"` và cập nhật `"test:scripts"`.
- `orchestration/report-66.md`: Báo cáo thực hiện công việc.

---

## 3. Lệnh đã chạy và kết quả thật

### A. Kiểm thử đơn vị script đồng bộ
```bash
bun test scripts/sync-itsaplan-project.test.ts
```
**Kết quả**:
```
 11 pass
 0 fail
 62 expect() calls
Ran 11 tests across 1 file. [55.00ms]
```

### B. Kiểm thử toàn bộ bộ scripts
```bash
bun run test:scripts
```
**Kết quả**:
```
 72 pass
 0 fail
 148 expect() calls
Ran 72 tests across 7 files. [116.00ms]
```

### C. Kiểm tra vệ sinh bảo mật repo công khai
```bash
bun run scan
```
**Kết quả**:
```
$ bun run scripts/scan-public.ts
✓ public-hygiene scan clean
```

### D. Kiểm tra chất lượng mã nguồn (Biome & Baseline)
```bash
bun x @biomejs/biome check scripts/sync-itsaplan-project.ts scripts/sync-itsaplan-project.test.ts
bun run lint:baseline
```
**Kết quả**:
```
Checked 2 files in 13ms. No fixes applied.
ok   style/noNonNullAssertion: 413 lỗi (cho phép tối đa 418)
ok   suspicious/noExplicitAny: 779 lỗi (cho phép tối đa 780)
Số lỗi của các rule đang tắt không tăng.
```
(Code mới không chứa `any`, không chứa non-null assertion `!`, không chứa unchecked cast).

### E. Quy trình kiểm tra toàn diện của repo
```bash
bun run verify
```
**Kết quả**:
```
$ bun run lint && bun run lint:baseline && bun run check && bun run test && bun run test:scripts && bun run scan && bun run docs:snippets && bun run docs:refs
[lint + lint:baseline: PASS]
[check: PASS cho tất cả các workspace packages/*, apps/*, tools/*]
[test: PASS cho tất cả packages core, tieulinh, tieulinh-legacy, tl2-shadow]
[test:scripts: 72 pass, 0 fail]
[scan: ✓ public-hygiene scan clean]
[docs:snippets: Mẫu code: 26 ts check, 14 ts run, 2 ts no-check]
[docs:refs: Docs khớp code: 47 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar]
```

---

## 4. Test nào thêm, test nào port

### Test thêm mới (`scripts/sync-itsaplan-project.test.ts`):
- `Ca 1: Target chưa tồn tại -> tạo project, tạo đủ cột và nhãn`
- `Ca 2: Target đã tồn tại một phần -> chỉ tạo bổ sung cột/nhãn thiếu và sửa cột lệch`
- `Ca 3: Target đã đồng nhất -> không thực hiện mutation thừa (idempotent)`
- `Ca 4: Cờ --dry-run -> không gửi bất kỳ POST/PATCH/PUT/DELETE nào`
- `Ca 5: Target trùng với Source -> chặn an toàn ngay lập tức`
- `Ca 6: Dự án nguồn không tồn tại -> báo lỗi rõ ràng`
- `Ca 7: Reorder cột khi thứ tự cột trên target bị đảo`
- `CLI: parseArgs hỗ trợ các định dạng cờ`
- `CLI: runCli xử lý thiếu biến môi trường`
- `CLI: runCli xử lý cờ --help thành công`
- `CLI: runCli chạy trọn vẹn với customClient`

### Test port:
Không có (đây là script công cụ mới của Issue #66, không liên quan đến porting legacy).

---

## 5. Còn dở gì, và phần đó thuộc PR nào

- **Không còn tồn đọng**: Mọi yêu cầu trong đặc tả `orchestration/specs/issue-66-sync-tech2-project.md` đã được hoàn thành 100%.
- **Bước tiếp theo trong chuỗi ticket triển khai TL2**:
  - Issue kế tiếp: Script khởi tạo dữ liệu mẫu và chạy E2E cục bộ Tiểu Linh 2 trên dự án `TECH2`.
