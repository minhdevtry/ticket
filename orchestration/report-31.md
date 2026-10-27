# Báo cáo thực hiện: PR 17 của RFC 0002 — runbook shadow, canary và hoàn nguyên lễ tân (issue #31)

## 1. Đã làm gì (theo từng mục của đặc tả)

### Mục 1: Mở rộng script triển khai Colab `deploy/colab/cup-tieulinh.sh`
- Bổ sung tuỳ chọn `--role <all|backoffice|receptionist>` (mặc định giữ `backoffice` để đảm bảo 100% tương thích ngược).
- Khi `--role receptionist` hoặc `--role all`:
  - Tự động kiểm tra môi trường Node 24 (`/opt/node24/bin/node`), OpenClaw (`/opt/oc/bin/openclaw`) và Bun trên máy Colab.
  - Khởi chạy runner lễ tân thông qua `tools/tl2-shadow/colab/tieulinh-run.ts` và `tools/tl2-shadow/colab/bootstrap.ts`.
- Mở rộng các thao tác vận hành theo role:
  - `status`: kiểm tra trạng thái dịch vụ của từng role (hoặc cả hai với `all`).
  - `stop`: dừng an toàn tiến trình của từng role (hoặc cả hai với `all`).
  - `logs`: theo dõi nhật ký thời gian thực của hậu cần (`tieulinh.out`), lễ tân (`gateway.out`) hoặc cả hai.
- Hỗ trợ cờ `--dry-run` xuất lệnh SSH và tham số `tieulinh-run --role <role>` chính xác.
- Cập nhật trợ giúp `deploy/colab/cup-tieulinh.sh --help` hiển thị đầy đủ tuỳ chọn role cho lễ tân.
- Giữ nguyên cơ chế an toàn: bộ lọc archive chặn các file giống secret/database (`secret_re`), proxy SSH an toàn qua máy dev.

### Mục 2: Mở rộng runner Colab `tools/tl2-shadow/colab/tieulinh-run.ts`
- Bổ sung kiểu `BotRole = "all" | "backoffice" | "receptionist"` và tuỳ chọn `role?: BotRole` trong `RunOpts`.
- Mở rộng xử lý lệnh `stop`: dừng tiến trình `apps/tieulinh` (role backoffice) và/hoặc `gateway.pid` (role receptionist) thông qua `stopProcess`.
- Mở rộng xử lý lệnh `status`: kiểm tra sức khoẻ webhook/healthz hậu cần (cổng 3121) và kiểm tra sức khoẻ gateway OpenClaw lễ tân (`GET /v1/models` cổng 18796 với Bearer token từ `gateway.token`).
- Mở rộng khởi chạy (action `up`): hỗ trợ khởi chạy `apps/tieulinh/main.ts` (hậu cần) và khởi chạy `bootstrap.ts` (lễ tân OpenClaw gateway + MCP server).
- Xuất các hàm kiểm tra và dừng tiến trình an toàn: `stopProcess`, `healthyGateway`.

### Mục 3: Biên soạn Runbook Canary & Hoàn nguyên (`docs/how-to/receptionist-canary-rollback.md`)
- Soạn thảo tài liệu vận hành hoàn chỉnh với cấu trúc 5 phần:
  1. **Nguyên tắc an toàn**: Tiểu Linh 1 là nguồn sự thật production (đóng băng); TL2 shadow/canary tuyệt đối không gửi tin ra ngoài ngoài danh sách được duyệt; không chia sẻ file tờ khai SQLite; dùng chung binding tương thích dạng legacy; thời gian hoàn nguyên < 1 phút.
  2. **Cấu hình Canary theo Chat ID (`CANARY_CHATS`)**: khai báo biến môi trường, cơ chế định tuyến 2 chiều (cho chat thuộc danh sách) vs 1 chiều (shadow thuần log cặp `pairs.jsonl`), cấu hình plugin `shadow-forwarder` trên `openclaw.json`.
  3. **Kịch bản Hoàn nguyên Khẩn cấp (< 1 phút)**: điều kiện kích hoạt hoàn nguyên (lỗi S0, lỗi model 500/timeout, khiếu nại người dùng/trực ca); quy trình 3 bước tức thì (hạ cờ canary < 15s, dừng an toàn trên Colab < 30s, kiểm tra xác nhận sau hoàn nguyên < 15s).
  4. **Xử lý sự cố thường gặp (Troubleshooting)**: Colab bị thu hồi / rớt SSH tunnel (khôi phục trong 30s); quota LLM / rate limit (fallback model ID qua proxy không cần sửa code); lệch dữ liệu binding giữa TL1 và TL2 (kiểm tra `TIEULINH_BINDING_DB` và schema legacy).
  5. **Danh mục kiểm tra sẵn sàng (Readiness Checklist)**: 6 tiêu chí bắt buộc trước khi kích hoạt canary trên production.
- Tuân thủ nghiêm ngặt `SECURITY.md`: không chứa token thật, IP nội bộ; chat ID dùng dạng synthetic `-1000000000001`, `-1000000000002`.

### Mục 4: Cập nhật Chỉ mục Tài liệu & VitePress Config
- Thêm liên kết tới runbook trong bảng chỉ mục `docs/how-to/index.md`.
- Thêm mục vào sidebar `docs/.vitepress/config.ts` dưới nhóm `/how-to/` (đảm bảo không có trang mồ côi).

### Mục 5: Sổ đối chiếu & Changelog
- Cập nhật `packages/core/CHANGELOG.md`: ghi nhận PR 17 hoàn tất toàn bộ chuỗi 17 PR di trú lễ tân của RFC 0002.
- Giữ nguyên sổ đối chiếu test legacy: `total=450 core=61 ported=326 deferred=52 by-design=11` (PR 17 không port thêm test legacy).
- Cập nhật bảng tóm tắt số liệu trong `packages/core/docs/parity/ENGINE.md` khớp với sổ đối chiếu.

### Mục 6: Bổ sung bài kiểm thử tự động
- `tools/tl2-shadow/cup-tieulinh.test.ts`: kiểm thử `--role backoffice`, `--role receptionist`, `--role all` trong dry-run; kiểm thử từ chối `--role` không hợp lệ với exit code 2.
- `tools/tl2-shadow/colab/tieulinh-run.test.ts`: kiểm thử `stopProcess` khi pid file không tồn tại / pid chết; kiểm thử `healthyGateway` khi cổng chưa mở.

---

## 2. Bằng chứng kiểm thử & xác minh

### A. Kiểm thử script deploy và runner
- `bun test tools/tl2-shadow/cup-tieulinh.test.ts tools/tl2-shadow/colab/tieulinh-run.test.ts`:
  - 13 pass, 0 fail (56 expect calls).
- `bash deploy/colab/cup-tieulinh.sh --help`:
  - Hiển thị đầy đủ tuỳ chọn `--role <all|backoffice|receptionist>` và mô tả.

### B. Kiểm tra vệ sinh bảo mật (`scan`)
- `bun run scan`:
  - `✓ public-hygiene scan clean`.

### C. Kiểm tra tài liệu (`docs:check`)
- `bun run docs:snippets`:
  - Mẫu code: 26 `ts check`, 14 `ts run`, 2 `ts no-check`.
- `bun run docs:refs`:
  - Docs khớp code: 49 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar (0 lỗi).
- `bun run docs:build`:
  - Build VitePress hoàn thành thành công.

### D. Toàn bộ quy trình xác minh (`verify`)
- `bun run verify` sạch 100%.

---

## 3. Sổ đối chiếu & Parity

- Sổ đối chiếu `apps/tieulinh/receptionist-gap-register.test.ts`:
  - `total=450 core=61 ported=326 deferred=52 by-design=11`
  - 9 pass, 0 fail, 1241 expect calls.
- Chuỗi di trú lễ tân RFC 0002 (PR 1 đến PR 17) chính thức hoàn tất.

---

## 4. Trạng thái các ràng buộc

- [x] Không commit, không push (theo WORKER-CONTRACT).
- [x] Không làm lộ token, password, IP nội bộ.
- [x] `bun run scan` sạch 100%.
- [x] `bun run docs:check` sạch 100%.
- [x] `bun run verify` sạch 100%.
- [x] Báo cáo đầy đủ tại `orchestration/report-31.md`.
