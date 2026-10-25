# Bản legacy và bản mới của Tiểu Linh

Repo có hai chỗ dành cho Tiểu Linh, và chúng có vai khác nhau.

| | `apps/tieulinh-legacy` | `apps/tieulinh` (app mới) |
|---|---|---|
| Trạng thái | Có trong repo, tên package `@vuihoc/tieulinh-legacy` | Có trong repo, tên package `@vuihoc/tieulinh`: mới có nửa hậu cần, lễ tân chưa làm ([Tiểu Linh mới: hậu cần](/explanation/tieulinh-hau-can)) |
| Cách viết | Code app hiện tại, dùng `@vuihoc/bot-core` qua adapter | Xây bằng `defineBot` ([Bot kit](/explanation/bot-kit)) |
| Hành vi | Đóng băng: bằng production ngày 2026-10-20 và tương thích itsaplan v1.8 | Làm mới từng phần, phải đối chiếu được với bản legacy |
| Thay đổi cho phép | Chỉ sửa lỗi nghiêm trọng | Mọi tính năng mới |

## Vì sao đóng băng

Chạy bóng so một bản mới với một bản chuẩn. Chuẩn mà cứ đổi thì kết quả so sánh vô nghĩa, nên bản legacy giữ nguyên hành vi và đóng vai bản tham chiếu. Khi bản mới đạt mức tương đương đã thoả thuận qua shadow, bản mới thay bản legacy ở production.

## Với người đóng góp

- Sửa lỗi nghiêm trọng của bản đang chạy: làm ở `apps/tieulinh-legacy`, commit với scope `tieulinh-legacy`, giữ hành vi còn lại.
- Tính năng mới: không làm ở bản legacy. Làm ở `apps/tieulinh`; thứ dùng chung được đặt ở `packages/core`, không chép vào app.
- Công cụ chạy bóng ([Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2)) đóng gói skills, MCP và plugin `shadow-forwarder` từ `apps/tieulinh-legacy`.
- Bản legacy từng mang tên `apps/tieulinh` / `@vuihoc/tieulinh`; tên đó nay thuộc app mới. Nhật ký và ADR cũ vẫn nhắc tên cũ vì chúng ghi lại lịch sử.
