# ADR-0002: Repo công khai, lịch sử bắt đầu mới

- Trạng thái: chấp nhận
- Ngày: 2026-10-24

## Bối cảnh

Chủ dự án muốn code nằm công khai trên GitHub và được quản lý bài bản. Mã nguồn gốc (bot-core và Tiểu Linh bản chạy production ngày 20/10/2026) không chứa secret, nhưng cả cây code lẫn lịch sử git chứa IP LAN, host nội bộ, chat ID nhóm, handle và email cá nhân, danh sách nhân sự, cùng số điện thoại trong fixture.

## Quyết định

- Không mang lịch sử git cũ sang. Repo bắt đầu từ một bản snapshot đã làm sạch.
- Fixture dùng dữ liệu giả theo quy ước trong SECURITY.md.
- Nghiệp vụ được để công khai: catalog sản phẩm, quy tắc ưu tiên, persona. Chỉ bỏ dữ liệu định danh người và hạ tầng.
- CI chặn tái phạm bằng `scripts/scan-public.ts` và gitleaks.
- Không kèm license: công khai để xem, tác giả giữ toàn quyền.

## Hệ quả

- Muốn truy vết lịch sử cũ thì xem repo nội bộ gốc (`ticketagent`, `vhitsaplanbot`). Commit nguồn được ghi trong commit import.
- Mọi đóng góp phải qua scan. Tên người thật được chặn qua `.scan-denylist` cục bộ.
