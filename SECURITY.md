# Bảo mật và vệ sinh repo công khai

Repo này công khai. Mọi thứ đã push coi như đã lộ vĩnh viễn, kể cả khi xoá sau đó.

## Không bao giờ commit

- Secret: token Telegram, API key itsaplan/LLM/Onyx, mật khẩu DB, webhook secret, private key. Dùng `.env` (đã gitignore) và đẩy lên máy chạy qua SSH.
- Hạ tầng nội bộ: IP LAN/Tailscale, hostname nội bộ, cổng dịch vụ nội bộ ngoài loopback.
- Dữ liệu người thật: số điện thoại, chat ID Telegram, tên/handle nhân sự, nội dung ticket thật của khách hàng, file DB/SQLite.

Fixture dùng dữ liệu giả: số điện thoại `0900000000`–`0900000999`, chat ID `-1000000000001`…, host `*.example.com`, IP `10.0.0.x`.

## Lớp bảo vệ

- `bun run scan` (`scripts/scan-public.ts`): chặn IP nội bộ, host nội bộ, email công ty, chat ID, số điện thoại, đường dẫn home. Chạy trong CI.
- `.scan-denylist` (gitignore, chỉ ở máy maintainer): danh sách tên/handle thật để scanner chặn mà không phải công khai chúng.
- gitleaks trong CI quét secret trên toàn bộ lịch sử.

## Lỡ commit secret

1. Thu hồi/đổi secret ngay. Đừng chỉ xoá commit.
2. Báo maintainer để xử lý lịch sử nếu cần.

## Báo lỗ hổng

Liên hệ maintainer qua GitHub (không mở issue công khai cho lỗ hổng).
