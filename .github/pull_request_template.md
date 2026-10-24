## Mục đích

<!-- Thay đổi gì, vì sao. Link ticket/ADR nếu có. -->

## Kiểm tra

- [ ] `bun run verify` pass (lint, typecheck, test, scan)
- [ ] Không có secret, IP nội bộ, chat ID, số điện thoại hay tên người thật (repo công khai)
- [ ] Đổi hành vi hoặc API công khai → đã cập nhật `docs/` (và `CHANGELOG` của package nếu là API) trong cùng PR; mẫu code trong docs có cờ `check` hoặc `run`
- [ ] Nếu PR là refactor thuần hoặc chỉ sửa test: xin gắn nhãn `no-docs` (không dùng để né việc cập nhật docs)
- [ ] `bun run docs:check` pass nếu có đổi docs hoặc API
