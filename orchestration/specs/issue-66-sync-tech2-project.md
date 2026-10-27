# Đặc tả: Issue #66 — Script đồng bộ cấu hình project TECH2 trên server Itsaplan

## Context

Repo: `minhdevtry/ticket`. Đây là Issue #66, ticket đầu tiên trong chuỗi 3 ticket triển khai Tiểu Linh 2 cục bộ và kiểm thử trọn gói E2E.
- **Tiền đề**: Issue #31 (PR 17 — Hoàn tất runbook shadow, canary và kịch bản hoàn nguyên).
- **Mục tiêu**: Xây dựng script công cụ tự động hóa việc kiểm tra, khởi tạo và sao chép cấu hình từ project `TECH` (production) sang project `TECH2` (sandbox thử nghiệm) nằm trong cùng Team `TECH` trên server Itsaplan nội bộ.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `packages/core/src/itsaplan/client.ts` (`ItsaplanClient`, `ItsaplanProject`, `ProjectColumn`, `ItsaplanLabel`).
- `packages/core/src/itsaplan/fake-server.test.ts` (mẫu kiểm thử với server mock Bun.serve).

---

## Problem Statement

Hiện tại, Tiểu Linh 2 chuẩn bị được đưa vào chạy thử nghiệm trọn gói cục bộ trên máy dev và kiểm thử với Itsaplan thật trên server nội bộ:
- Project `TECH` là dự án tiếp nhận sự cố kỹ thuật thật đang chạy production của Tiểu Linh 1, có cấu hình cột trạng thái, nhãn (labels), trường bắt buộc và quy tắc ưu tiên đã được chuẩn hoá qua nhiều tháng vận hành.
- Để thử nghiệm Tiểu Linh 2 độc lập mà không làm bẩn hoặc nhiễu dữ liệu của `TECH`, ta cần project `TECH2` làm sandbox.
- Nếu tạo `TECH2` thủ công bằng tay trên giao diện web, rất dễ bị lệch tên cột trạng thái, sai `stateType` (backlog, unstarted, started, completed, canceled), thiếu nhãn hoặc lệch vị trí cột, dẫn đến bot chạy thử nghiệm gặp lỗi không tương thích.

---

## Solution

Xây dựng script công cụ `scripts/sync-itsaplan-project.ts`:
1. **Kết nối**: Sử dụng `ItsaplanClient` của `@vuihoc/bot-core/itsaplan` với cấu hình URL và API key từ biến môi trường (`ITSAPLAN_BASE_URL`, `ITSAPLAN_API_KEY`).
2. **Kiểm tra & Khởi tạo Project**:
   - Gọi `getProject(sourceKey)` (mặc định `"TECH"`).
   - Kiểm tra `getProject(targetKey)` (mặc định `"TECH2"`). Nếu chưa tồn tại (nhận 404), gọi `createProject({ key: targetKey, name: "Tech Sandbox", preset: "empty" })`.
3. **Đồng bộ Cột Trạng thái (Columns)**:
   - Đọc danh sách cột của `sourceKey` (`columns`).
   - Đối chiếu với cột hiện có của `targetKey`:
     - Nếu cột chưa có trên target: gọi `createColumn(targetKey, { name, stateType, color, position })`.
     - Nếu cột đã có nhưng khác `stateType` hoặc `color`: gọi `updateColumn(targetKey, columnId, patch)`.
   - Giữ nguyên thứ tự các cột trạng thái (`reorderColumns`).
4. **Đồng bộ Nhãn (Labels)**:
   - Đọc danh sách nhãn của `sourceKey` (`labels`).
   - Tạo các nhãn còn thiếu trên `targetKey` qua `createLabel(targetKey, { name, color })`.
5. **Cơ chế an toàn (Safety Rails)**:
   - `--source` **TUYỆT ĐỐI CHỈ ĐỌC (READ-ONLY)**: Không bao giờ gọi bất kỳ phương thức ghi nào (`create*`, `update*`, `delete*`) lên project nguồn.
   - Hỗ trợ cờ `--dry-run`: In ra toàn bộ danh sách các thao tác sẽ thực hiện (cột sẽ tạo, nhãn sẽ thêm) mà không thực thi HTTP mutation.
   - Tính luỹ kế (Idempotent): Chạy nhiều lần cho cùng kết quả, không tạo trùng lặp cột hay nhãn.

---

## User Stories

1. **As a devops engineer**, I want to run a single command `bun run scripts/sync-itsaplan-project.ts --source TECH --target TECH2 --dry-run` to inspect all differences between the production and test projects before applying changes.
2. **As an automation agent**, I want the sync script to idempotently create and configure `TECH2` so that the local runner can immediately start testing without manual database preparation.
3. **As a system administrator**, I want a hard read-only guarantee on the source project `TECH`, so that running the sync script can never accidentally modify production columns or tickets.

---

## Implementation Decisions

### 1. Cấu trúc tệp tin
- **Script chính**: `scripts/sync-itsaplan-project.ts`.
- **Kiểm thử tự động**: `scripts/sync-itsaplan-project.test.ts`.
- **Cập nhật `package.json`**: Bổ sung npm script `"itsaplan:sync-project": "bun run scripts/sync-itsaplan-project.ts"`.

### 2. Giao diện dòng lệnh (CLI Signature)
```bash
bun run scripts/sync-itsaplan-project.ts [options]

Options:
  --source <key>     Project nguồn để đọc cấu hình (mặc định: TECH)
  --target <key>     Project đích để đồng bộ sang (mặc định: TECH2)
  --name <text>      Tên của project đích nếu phải tạo mới (mặc định: "Tech Sandbox")
  --dry-run          Chỉ kiểm tra và in báo cáo, không ghi lên server
  --help             Hiển thị hướng dẫn sử dụng
```

### 3. Nguyên tắc bảo vệ dữ liệu sản xuất
- Kiểm tra khoá dự án: Nếu `--target` trùng với `--source`, script lập tức dừng lại với mã lỗi 1 (`Target project cannot be identical to source project`).
- Bắt buộc kiểm tra `ITSAPLAN_BASE_URL` và `ITSAPLAN_API_KEY`. Nếu thiếu, in hướng dẫn rõ ràng và thoát 1.

---

## Testing Decisions

1. **Unit & Mock Integration Test (`scripts/sync-itsaplan-project.test.ts`)**:
   - Dựng mock server bằng `Bun.serve({ port: 0 })` tương tự mẫu trong `packages/core/src/itsaplan/fake-server.test.ts`.
   - Giả lập các ca kiểm thử:
     - Ca 1: Project đích chưa tồn tại -> Script gọi tạo project, tạo đủ cột và nhãn.
     - Ca 2: Project đích đã tồn tại một phần -> Script chỉ tạo các cột và nhãn còn thiếu.
     - Ca 3: Cờ `--dry-run` -> Không có request `POST`/`PATCH` nào được gửi đi.
     - Ca 4: Chặn an toàn khi source trùng target.
2. **Kiểm tra công cục bộ**:
   - `bun test scripts/sync-itsaplan-project.test.ts` pass 100%.
   - `bun run scan` sạch 100% (không chứa IP nội bộ, không secret, không tên người thật).

---

## Ranh giới & Điều cấm (Worker Constraints)

- **Chỉ sửa trong**: `scripts/sync-itsaplan-project.ts`, `scripts/sync-itsaplan-project.test.ts`, `package.json` (chỉ thêm script dòng lệnh).
- **CẤM**:
  - Không sửa mã nguồn trong `packages/core/src/` (tận dụng nguyên vẹn `ItsaplanClient` đã có).
  - Không import mã từ `apps/tieulinh-legacy/**`.
  - Không commit, không push (Coordinator sẽ thực hiện).
  - Không hardcode IP nội bộ hay API key vào trong code hoặc test fixture.

---

## Tiêu chí chấp nhận (Acceptance Criteria)

- [ ] File `scripts/sync-itsaplan-project.ts` hoàn thiện, hỗ trợ `--source`, `--target`, `--dry-run`.
- [ ] Chế độ an toàn: Báo lỗi nếu `--source` trùng `--target`, đảm bảo source là read-only 100%.
- [ ] Bộ test `scripts/sync-itsaplan-project.test.ts` chạy xanh 100% trên `Bun.serve` mock, độ bao phủ các ca biên.
- [ ] `bun run test:scripts` và `bun run verify` pass hoàn toàn.
- [ ] `bun run scan` sạch 100%.
