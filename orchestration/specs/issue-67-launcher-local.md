# Đặc tả: Issue #67 — Bộ launcher cục bộ tl2-local chạy trọn gói Tiểu Linh 2 trên máy dev

## Context

Repo: `minhdevtry/ticket`. Đây là Issue #67, ticket thứ 2 trong chuỗi triển khai Tiểu Linh 2 cục bộ và kiểm thử trọn gói E2E.
- **Tiền đề**: Issue #66 (Script đồng bộ project `TECH2` trên server Itsaplan nội bộ).
- **Mục tiêu**: Xây dựng bộ launcher duy nhất `deploy/dev/tl2-local.sh` (và npm script `bun run dev:tieulinh2`) để khởi động, giám sát và dừng trọn gói cả Lễ tân (OpenClaw gateway) và Hậu cần (`apps/tieulinh`) cục bộ trên máy dev, kết nối trực tiếp với Itsaplan `TECH2`.
- **Nguyên tắc cốt lõi đã chốt trong `/grilling`**:
  - Khai tử hoàn toàn Colab. Toàn bộ chạy trực tiếp trên máy dev này.
  - Tuyệt đối không can thiệp vào project `TECH` production; bot chỉ kết nối với `tech/TECH2`.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `deploy/dev/tl2-shadow.sh` (tham khảo cơ chế quản lý PID, log, stop an toàn của máy dev).
- `apps/tieulinh/` (cách khởi chạy app hậu cần bằng `bun run start` hoặc `defineBot`).

---

## Problem Statement

Trước đây:
- Hệ thống bị phân tán: script máy dev (`tl2-shadow.sh`) chỉ bật proxy/relay rồi dùng SSH gọi sang Colab (`cup-tieulinh.sh`, `cup-openclaw.sh`).
- Việc chạy qua Colab gây ra độ trễ cao, phụ thuộc vào đường truyền SSH `-R`/`-L`, và thường xuyên bị đứt kết nối hoặc mất VM.
- Khi người dùng muốn chạy thử Tiểu Linh 2 cục bộ để kiểm tra toàn trình, không có một lệnh duy nhất nào bật đầy đủ cả 2 nửa: Lễ tân (tiếp nhận đơn qua Telegram/OpenClaw) và Hậu cần (nhận webhook và xử lý vòng đời ticket).

---

## Solution

Xây dựng script `deploy/dev/tl2-local.sh`:
1. **Kiến trúc cục bộ (Local Architecture)**:
   - Chạy trực tiếp cả 2 dịch vụ trên máy dev:
     - **Dịch vụ 1: Lễ tân (OpenClaw Gateway + Pack Receptionist)**: Khởi chạy OpenClaw với cấu hình adapter và pack MCP lễ tân, lắng nghe cổng loopback (ví dụ `18796`).
     - **Dịch vụ 2: Hậu cần (`apps/tieulinh`)**: Khởi chạy tiến trình hậu cần (`bun run --cwd apps/tieulinh start` hoặc script runner tương ứng), mở server webhook loopback (mặc định cổng `3120`) và cổng health (`3121`).
2. **Cấu hình môi trường (`env`)**:
   - Tự động nạp cấu hình từ `~/.config/ticket/tieulinh2.env` hoặc các biến môi trường:
     - `ITSAPLAN_BASE_URL`: trỏ về server Itsaplan nội bộ.
     - `ITSAPLAN_PROJECT_KEY`: bắt buộc là `TECH2`.
     - `ITSAPLAN_TEAM`: `TECH`.
   - Chặn an toàn: Nếu phát hiện `ITSAPLAN_PROJECT_KEY=TECH` (production), script lập tức từ chối khởi động để bảo vệ hệ thống thật.
3. **Thao tác điều khiển chuẩn**:
   - `start`: Kiểm tra cổng, khởi động nền 2 tiến trình, ghi file PID vào `~/.local/share/tl2-local/run/`, kiểm tra `/healthz` sống mới báo thành công.
   - `status`: Kiểm tra PID và cổng mạng của từng dịch vụ, in thông tin rõ ràng.
   - `stop`: Gửi tín hiệu dừng an toàn (SIGTERM -> SIGKILL sau timeout), dọn dẹp file PID.
   - `restart`: Thực hiện `stop` rồi `start`.
   - `logs`: Xem hoặc theo dõi (`tail -f`) nhật ký hoạt động của cả 2 dịch vụ.
4. **NPM Script**:
   - Bổ sung vào `package.json`: `"dev:tieulinh2": "deploy/dev/tl2-local.sh"` để nhà phát triển có thể gõ `bun run dev:tieulinh2 start|status|stop`.

---

## User Stories

1. **As a developer**, I want to run `bun run dev:tieulinh2 start` and have both the receptionist and backoffice running locally within 5 seconds, so that I can immediately test tickets without touching Colab.
2. **As an operator**, I want `deploy/dev/tl2-local.sh status` to show whether both services are healthy and which ports they occupy.
3. **As a safety-conscious engineer**, I want the launcher to hard-fail if `ITSAPLAN_PROJECT_KEY` points to `TECH`, so that local testing can never accidentally process production tickets.

---

## Implementation Decisions

### 1. Phân định thư mục và tệp tin
- `deploy/dev/tl2-local.sh`: Script bash thực thi chính (cấp quyền `chmod +x`).
- `deploy/dev/tl2-local.test.ts`: Bộ test kiểm tra các cờ CLI (`--help`, `status` khi chưa chạy, chặn an toàn khi trỏ vào `TECH`).
- Thư mục runtime: `~/.local/share/tl2-local/` (`run/` chứa `.pid`, `logs/` chứa `.log`).
- `package.json`: Thêm `"dev:tieulinh2": "deploy/dev/tl2-local.sh"`.

### 2. Giao diện dòng lệnh (CLI Signature)
```bash
deploy/dev/tl2-local.sh <start|stop|restart|status|logs> [service]

Options:
  start          Khởi động các dịch vụ cục bộ
  stop           Dừng các dịch vụ
  restart        Khởi động lại
  status         Kiểm tra trạng thái hoạt động
  logs           Xem log (mặc định tail 50 dòng)
```

---

## Testing Decisions

1. **Unit Test CLI (`deploy/dev/tl2-local.test.ts`)**:
   - Kiểm tra cú pháp script: `bash -n deploy/dev/tl2-local.sh`.
   - Kiểm tra lệnh `status` khi không có tiến trình chạy -> trả về mã 0 và thông báo rõ ràng "chưa chạy".
   - Kiểm tra chốt an toàn: Chạy với `ITSAPLAN_PROJECT_KEY=TECH` -> thoát với mã lỗi 1 và cảnh báo bảo vệ production.
2. **Kiểm định toàn cục**:
   - `bun run test:scripts` và `bun run verify` pass hoàn toàn.
   - `bun run scan` sạch 100%.

---

## Ranh giới & Điều cấm (Worker Constraints)

- **Chỉ sửa trong**: `deploy/dev/tl2-local.sh`, `deploy/dev/tl2-local.test.ts`, `package.json`.
- **CẤM**:
  - Không sửa mã nguồn trong `packages/core/src/` hay `apps/tieulinh/`.
  - Không import mã legacy `apps/tieulinh-legacy/**`.
  - Không commit, không push.
  - Không hardcode secret hay IP nội bộ vào script hoặc test.

---

## Tiêu chí chấp nhận (Acceptance Criteria)

- [ ] Script `deploy/dev/tl2-local.sh` hoàn thiện, hỗ trợ đầy đủ `start`, `stop`, `restart`, `status`, `logs`.
- [ ] Chốt chặn an toàn: Từ chối khởi động nếu project trỏ vào `TECH` production.
- [ ] Bộ test `deploy/dev/tl2-local.test.ts` pass 100%.
- [ ] Lệnh `bun run dev:tieulinh2` được định nghĩa trong `package.json`.
- [ ] `bun run verify` và `bun run scan` sạch 100%.
