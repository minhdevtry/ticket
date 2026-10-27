# Đặc tả Worker 2: Kiểm toán và tối ưu năng lực Bot OP (@vhops_bot) trên @vuihoc/bot-core v0.9.0

## Context & Vai trò
- Bạn là Kỹ sư Trưởng Hệ thống (Staff Systems Engineer) phụ trách kiểm toán Bot OP.
- Thư mục repo: `~/Documents/operationbot` (nhánh `master`, vừa nâng cấp lên `@vuihoc/bot-core` v0.9.0).
- Bot OP (`@vhops_bot`) là bot phục vụ vận hành thực tế cho 2 nhóm nghiệp vụ: Sales (tư vấn tuyển sinh) và Quản lý lớp.
- Mục tiêu: Rà soát kiểm toán kỹ lưỡng các module nâng cao để đảm bảo độ mượt mà tối đa, không để phát sinh lỗi tiềm ẩn.

---

## 1. Nhiệm vụ Kiểm toán Cụ thể

### Nhiệm vụ 1: Kiểm định Bộ điều khiển BatchLLM (`lib/batchllm.ts`)
- Xác nhận cấu hình kết nối tới Gateway `opencode-railway` cổng 8090 (`http://127.0.0.1:8090`).
- Kiểm tra cơ chế AIMD thích ứng concurrency (Additive Increase / Multiplicative Decrease):
  + Khi 8 request thành công liên tiếp ➔ tăng concurrency.
  + Khi gặp lỗi 429, 400 quá tải hoặc 5xx ➔ giảm concurrency (nhân hệ số 0.7) và ghi nhận mốc trần.
- Kiểm tra cơ chế Dead strike: Đánh dấu model chết khi gặp lỗi không thể phục hồi ("Model is unavailable"), failover tự động sang model khác.
- Chạy toàn bộ bộ test `bun test lib/batchllm.test.ts` (đảm bảo 100% test pass).

### Nhiệm vụ 2: Chạy Benchmark Phân loại Harness2 (`scripts/harness2_benchmark.ts`)
- Chạy bộ kiểm chuẩn Harness2 đa luồng.
- Đo đạc và ghi nhận các chỉ số:
  + Độ trễ xử lý (p50, p90, p99).
  + Tỷ lệ thành công và độ chính xác phân luồng nghiệp vụ (Sales vs Quản lý lớp).
  + Hành vi khi gateway bị nghẽn hoặc có rate limit.

### Nhiệm vụ 3: Rà soát Cơ chế Tương tác 2 Chiều (Itsaplan ➔ Telegram)
- Soát luồng nhận webhook Itsaplan tại `bot/main.ts` và cơ chế phát thông báo về Telegram.
- Đối chiếu với chuẩn `NotificationDispatcher` của core (`@vuihoc/bot-core`):
  + Xử lý lọc mã HTML (`stripCommentHtml` / `decodeHtmlEntities`).
  + Cơ chế gắn thẻ comment (`#noibo`, `#internal`, `#nhac_nho`) để tránh spam.
  + Lưu routing tin nhắn (`message_routes`) để khi người dùng ấn nút hoặc reply Telegram thì bot chuyển đúng về comment Itsaplan.
  + Cơ chế chống echo: Bỏ qua comment do chính bot sinh ra.
- Đưa ra đề xuất cải tiến cụ thể để luồng 2 chiều của OP đạt chuẩn mượt mà như Tiểu Linh.

---

## 2. Tiêu chí Chấp nhận (Acceptance Criteria)

- [ ] Toàn bộ 456 unit tests trong `operationbot` giữ vững 100% pass (`bun test`).
- [ ] Chạy thành công `scripts/verify_all.sh` với đủ 9/9 cổng kiểm định xanh (typecheck, lint, catalog, skill prompt, E2E non-live).
- [ ] Báo cáo kiểm chuẩn Harness2 có số liệu thực tế đo đạc qua gateway cổng 8090.
- [ ] Đề xuất nâng cấp luồng 2 chiều rõ ràng, không phá vỡ logic nghiệp vụ Sales / Quản lý lớp.
- [ ] Xuất bản báo cáo chi tiết vào `docs/audit-op-bot-v09.md` trong worktree của `operationbot`.
- [ ] Báo cáo `worker_done` khi hoàn tất.
