# Bản legacy và bản mới của Tiểu Linh

Repo có hai chỗ dành cho Tiểu Linh, và chúng có vai khác nhau.

| | `apps/tieulinh-legacy` | App mới, thư mục dự kiến apps/tieulinh (đang thiết kế) |
|---|---|---|
| Trạng thái | Có trong repo, tên package `@vuihoc/tieulinh-legacy` | Chưa có trong repo |
| Cách viết | Code app hiện tại, dùng `@vuihoc/bot-core` qua adapter | Xây bằng `defineBot` ([Bot kit](/explanation/bot-kit)) |
| Hành vi | Đóng băng: bằng production ngày 2026-10-20 và tương thích itsaplan v1.8 | Làm mới từng phần, phải đối chiếu được với bản legacy |
| Thay đổi cho phép | Chỉ sửa lỗi nghiêm trọng | Mọi tính năng mới |

## Vì sao đóng băng

Chạy bóng so một bản mới với một bản chuẩn. Chuẩn mà cứ đổi thì kết quả so sánh vô nghĩa, nên bản legacy giữ nguyên hành vi và đóng vai bản tham chiếu. Khi bản mới đạt mức tương đương đã thoả thuận qua shadow, bản mới thay bản legacy ở production.

## Với người đóng góp

- Sửa lỗi nghiêm trọng của bản đang chạy: làm ở `apps/tieulinh-legacy`, commit với scope `tieulinh-legacy`, giữ hành vi còn lại.
- Tính năng mới: không làm ở bản legacy. Làm ở app mới khi nó có trong repo.
- Công cụ chạy bóng ([Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2)) đóng gói skills, MCP và plugin `shadow-forwarder` từ `apps/tieulinh-legacy`.
- Đường dẫn và tên package cũ (apps/tieulinh, `@vuihoc/tieulinh`) đã đổi; nhật ký và ADR cũ vẫn nhắc tên cũ vì chúng ghi lại lịch sử.
