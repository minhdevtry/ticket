# Bảo mật repo công khai

Repo `minhdevtry/ticket` công khai trên GitHub. Mọi thứ đã push coi như đã lộ vĩnh viễn, kể cả khi xoá sau đó. Trang này giải thích vì sao và cách repo tự bảo vệ. Quy tắc đầy đủ ở [SECURITY.md](https://github.com/minhdevtry/ticket/blob/main/SECURITY.md).

## Vì sao công khai

Chủ dự án muốn code nằm công khai và được quản lý bài bản (ADR-0002 trong [chỉ mục ADR](/explanation/adr-index)). Nghiệp vụ được để công khai: catalog sản phẩm, quy tắc ưu tiên, persona. Cái bị loại bỏ là dữ liệu định danh người và hạ tầng. Repo bắt đầu từ một bản snapshot đã làm sạch, không mang lịch sử git cũ sang vì lịch sử đó chứa IP LAN, host nội bộ, chat ID, handle và số điện thoại.

## Không bao giờ commit

- **Secret**: token Telegram, API key itsaplan, LLM hay Onyx, mật khẩu DB, webhook secret, private key. Dùng `.env` (đã gitignore) và đẩy lên máy chạy qua SSH ([Deploy và đẩy secret qua SSH](/how-to/deploy), ADR-0003).
- **Hạ tầng nội bộ**: IP LAN hay Tailscale, hostname nội bộ, cổng dịch vụ nội bộ ngoài loopback.
- **Dữ liệu người thật**: số điện thoại, chat ID Telegram, tên hay handle nhân sự, nội dung ticket thật, file DB hay SQLite.

Fixture và ví dụ dùng dữ liệu giả: số điện thoại `0900000000` tới `0900000999`, chat ID `-1000000000001` trở đi, host `*.example.com`, IP `10.0.0.x`. Quy ước này áp dụng cả cho **docs**: mọi ví dụ trong site này dùng giá trị giả.

## Lớp bảo vệ

| Lớp | Bắt cái gì | Chạy ở đâu |
|---|---|---|
| `bun run scan` (`scripts/scan-public.ts`) | IP nội bộ, host nội bộ, email công ty, chat ID, số điện thoại, đường dẫn home. Quét cả docs. | CI (`verify`) và `bun run verify` |
| `.scan-denylist` (gitignore, chỉ ở máy maintainer) | Tên hay handle thật mà không cần công khai chúng | Máy maintainer |
| gitleaks | Secret trong toàn bộ lịch sử | CI (`secrets`) |

Repo không kèm license: công khai để xem, tác giả giữ toàn quyền.

## Lỡ commit secret

1. Thu hồi hoặc đổi secret ngay. Đừng chỉ xoá commit.
2. Báo maintainer để xử lý lịch sử nếu cần.

Lỗ hổng bảo mật báo cho maintainer qua GitHub, không mở issue công khai.
