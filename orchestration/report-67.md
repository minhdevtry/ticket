# Báo cáo thực hiện: Issue #67 — Bộ launcher cục bộ tl2-local chạy trọn gói Tiểu Linh 2 trên máy dev

## 1. Đã làm gì (theo từng mục của đặc tả)

### Mục 1: Xây dựng script launcher `deploy/dev/tl2-local.sh`
- **Kiến trúc cục bộ (Local Architecture)**:
  - Khai tử hoàn toàn Colab, chạy trực tiếp cả 2 dịch vụ trên máy dev:
    - **Lễ tân (Receptionist)**: OpenClaw Gateway mang pack MCP lễ tân (`apps/tieulinh-legacy/mcp/tieulinh/index.ts`), lắng nghe loopback cổng `18796` (cấu hình qua `RECEPTIONIST_PORT`). Tự động đồng bộ skills từ `apps/tieulinh-legacy/skills/` vào workspace và sinh cấu hình `openclaw.json` (chuẩn OpenClaw `agents.list`).
    - **Hậu cần (Backoffice)**: Chạy app `apps/tieulinh` (`main.ts`) bằng Bun, mở loopback webhook server cổng `3120` (`BOT_WEBHOOK_PORT`) và health server cổng `3121` (`BOT_HEALTH_PORT`).
- **Nạp cấu hình môi trường an toàn**:
  - Tự động nạp biến môi trường từ `~/.config/ticket/tieulinh2.env` và `~/.config/ticket/minimax.env` (hỗ trợ ghi đè qua biến môi trường hoặc file chỉ định qua `TL2_ENV_FILE`, `TL2_MINIMAX_ENV_FILE`).
  - Mặc định: `ITSAPLAN_PROJECT_KEY=TECH2`, `ITSAPLAN_TEAM=tech`.
  - Kết nối trực tiếp vào Itsaplan `TECH2` và LLM (MiniMax).
- **Chốt chặn an toàn (Safety Guard)**:
  - Kiểm tra nghiêm ngặt `ITSAPLAN_PROJECT_KEY` và `TIEULINH_PROJECT`.
  - Nếu phát hiện cấu hình trỏ vào `TECH` hoặc `tech` (production), script lập tức từ chối khởi động và thoát với mã lỗi 1 kèm cảnh báo: `[CẢNH BÁO AN TOÀN] Từ chối khởi động: Phát hiện cấu hình trỏ vào project production 'TECH'. Bộ launcher chỉ cho phép chạy trên TECH2 để bảo vệ dữ liệu thật!`.
  - Bắt buộc `ITSAPLAN_PROJECT_KEY` phải là `TECH2`; nếu là project lạ khác thì từ chối khởi động với lỗi cấu hình rõ ràng.
- **Quản lý tiến trình (PID & Runtime)**:
  - Quản lý PID cô lập trong `~/.local/share/tl2-local/run/` (`receptionist.pid`, `backoffice.pid`), nhật ký trong `logs/` (`receptionist.log`, `backoffice.log`), dữ liệu bền trong `data/` và `receptionist/`. Hỗ trợ đổi đường dẫn qua `TL2_LOCAL_DIR`.
  - Thiết lập quyền `umask 077` và `chmod 700` bảo vệ dữ liệu.
  - Hỗ trợ đầy đủ các lệnh:
    - `start [service]`: Kiểm tra cổng, kiểm tra PID, khởi động nền với `nohup`, thăm dò `/healthz` (hậu cần) và `/v1/models` (lễ tân) sống mới báo thành công.
    - `stop [service]`: Gửi `SIGTERM`, đợi tiến trình thoát an toàn, fallback `SIGKILL` sau timeout, dọn file PID.
    - `restart [service]`: Thực hiện `stop` rồi `start`.
    - `status [service]`: Báo trạng thái hoạt động (chạy kèm PID và cổng/health, hoặc "chưa chạy"). Thoát 0 khi chưa có tiến trình chạy.
    - `logs [service]`: Xem log của dịch vụ (mặc định tail 50 dòng).
  - Hỗ trợ cờ `--dry-run`: In toàn bộ kế hoạch khởi động/dừng mà không tạo file PID hay spawn tiến trình.
  - Hỗ trợ `-h`, `--help`: In hướng dẫn sử dụng chi tiết.

### Mục 2: Cập nhật `package.json`
- Bổ sung npm script: `"dev:tieulinh2": "deploy/dev/tl2-local.sh"`.
- Bổ sung `deploy/dev/tl2-local.test.ts` vào npm script `"test:scripts"` để tự động chạy trong pipeline `bun run verify`.

### Mục 3: Viết bộ kiểm thử toàn diện `deploy/dev/tl2-local.test.ts`
- Sử dụng thư mục tạm riêng biệt qua `TL2_LOCAL_DIR` và `TL2_ENV_FILE` (cô lập 100%, không ảnh hưởng thư mục thật của người dùng).
- Kiểm thử đầy đủ 18 ca kiểm thử:
  1. Cú pháp script bash hợp lệ (`bash -n deploy/dev/tl2-local.sh`).
  2. Hiển thị hướng dẫn `--help` và thoát mã 0.
  3. Lệnh `status` khi chưa có tiến trình chạy trả về mã 0 và thông báo rõ ràng `chưa chạy`.
  4. Lệnh `status` riêng lẻ theo từng dịch vụ (`receptionist`, `backoffice`).
  5. Lệnh `stop` khi chưa có tiến trình chạy trả về mã 0 và thông báo `không chạy`.
  6. Lệnh `stop` riêng lẻ theo từng dịch vụ (`receptionist`, `backoffice`).
  7. Chốt an toàn: Từ chối khi `ITSAPLAN_PROJECT_KEY=TECH` qua env (thoát mã 1, có cảnh báo production).
  8. Chốt an toàn: Từ chối khi chạy lệnh mặc định với `ITSAPLAN_PROJECT_KEY=TECH`.
  9. Chốt an toàn: Từ chối khi `TIEULINH_PROJECT=TECH`.
  10. Chốt an toàn: Từ chối khi file cấu hình `.env` đặt `ITSAPLAN_PROJECT_KEY=TECH`.
  11. Chốt an toàn: Từ chối khi `ITSAPLAN_PROJECT_KEY` khác `TECH2`.
  12. Chế độ `--dry-run`: `start --dry-run` in đầy đủ kế hoạch cho cả 2 dịch vụ, thoát mã 0.
  13. Chế độ `--dry-run`: `start receptionist --dry-run` chỉ in kế hoạch lễ tân.
  14. Chế độ `--dry-run`: `start backoffice --dry-run` chỉ in kế hoạch hậu cần.
  15. Chế độ `--dry-run`: `stop --dry-run` in kế hoạch dừng.
  16. Xử lý tham số lạ: Báo lỗi và thoát mã 2.
  17. Lệnh `logs` khi chưa có log hiển thị thông báo rõ ràng.
  18. Lệnh `logs` theo từng dịch vụ khi chưa có log.

---

## 2. File nào đổi

- `deploy/dev/tl2-local.sh`: File mới (script launcher cục bộ Tiểu Linh 2, chmod +x).
- `deploy/dev/tl2-local.test.ts`: File mới (bộ unit test CLI).
- `package.json`: Thêm script `"dev:tieulinh2"` và cập nhật `"test:scripts"`.
- `orchestration/report-67.md`: Báo cáo thực hiện công việc.

---

## 3. Lệnh đã chạy và kết quả thật

### A. Kiểm thử đơn vị script launcher
```bash
bun test deploy/dev/tl2-local.test.ts
```
**Kết quả**:
```
 18 pass
 0 fail
 54 expect() calls
Ran 18 tests across 1 file. [661.00ms]
```

### B. Kiểm thử bộ scripts
```bash
bun run test:scripts
```
**Kết quả**:
```
 90 pass
 0 fail
 202 expect() calls
Ran 90 tests across 8 files. [596.00ms]
```

### C. Quét an toàn và bảo mật kho công khai
```bash
bun run scan
```
**Kết quả**:
```
✓ public-hygiene scan clean
```

### D. Kiểm tra toàn bộ repo (Verification pipeline)
```bash
bun run verify
```
**Kết quả**:
```
$ bun run lint && bun run lint:baseline && bun run check && bun run test && bun run test:scripts && bun run scan && bun run docs:snippets && bun run docs:refs
$ biome check .
Checked 620 files in 477ms. No fixes applied. Found 111 warnings. Found 53 infos. (exit code: 0)
$ bun run scripts/lint-baseline.ts
ok   style/noNonNullAssertion: 413 lỗi (cho phép tối đa 418)
ok   suspicious/noExplicitAny: 779 lỗi (cho phép tối đa 780)
Số lỗi của các rule đang tắt không tăng.
$ bun run --filter '*' check
@vuihoc/bot-core check: Exited with code 0
@vuihoc/tl2-shadow check: Exited with code 0
@vuihoc/tieulinh check: Exited with code 0
@vuihoc/tieulinh-legacy check: Exited with code 0
$ bun run --filter '*' test
@vuihoc/bot-core test: 1578 pass, 0 fail
@vuihoc/tieulinh test: 177 pass, 0 fail
@vuihoc/tl2-shadow test: 157 pass, 0 fail
@vuihoc/tieulinh-legacy test: 938 pass, 27 skip, 0 fail
$ bun run test:scripts
90 pass, 0 fail
$ bun run scripts/scan-public.ts
✓ public-hygiene scan clean
$ bun run scripts/check-doc-snippets.ts
Mẫu code: 26 `ts check`, 14 `ts run`, 2 `ts no-check`.
$ bun run scripts/check-docs-refs.ts
Docs khớp code: 47 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
```

### E. Kiểm tra tài liệu (Docs check)
```bash
bun run docs:check
```
**Kết quả**:
```
$ vitepress build
build complete in 83.06s.
$ bun run scripts/check-doc-snippets.ts
Mẫu code: 26 `ts check`, 14 `ts run`, 2 `ts no-check`.
$ bun run scripts/check-docs-refs.ts
Docs khớp code: 49 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
```

---

## 4. Test nào thêm, test nào port

- **Test thêm mới**: `deploy/dev/tl2-local.test.ts` (18 ca test kiểm tra cú pháp, `--help`, `status`, `stop`, `start --dry-run`, `stop --dry-run`, chốt an toàn chống `TECH` production, và xử lý cờ lỗi).
- **Test port**: Không (Issue này là launcher dev mới, không thuộc phạm vi port từ legacy).

---

## 5. Còn dở gì, và phần đó thuộc PR nào

- Công việc trong Issue #67 hoàn thành 100%, đáp ứng đầy đủ mọi tiêu chí chấp nhận.
- Bước kế tiếp (chuỗi E2E Tiểu Linh 2 cục bộ): Sử dụng `dev:tieulinh2` để kiểm thử toàn trình tạo ticket và xử lý vòng đời ticket trên `TECH2`.
