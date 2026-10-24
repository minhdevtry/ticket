---
name: confirm-before-create
description: Use when an agent has gathered sufficient issue details and is preparing to persist a new record to the tracker
tools: [create_issue]
---

# Xác Nhận Trước Khi Tạo (Confirm Before Create)

## Overview

Nguyên tắc an toàn bắt buộc: Dừng lại xin người dùng xác nhận bản tóm tắt trước khi chính thức ghi nhận bản ghi mới lên tracker Itsaplan.

## When to Use

- Sau khi đã thu thập đủ thông tin sự cố hoặc yêu cầu đóng góp.
- Khi chuẩn bị gọi thao tác tạo bản ghi trên tracker.

## When NOT to Use

- Khi người dùng đang bổ sung thông tin cho ticket đang xử lý -> Gọi `update_issue`.
- Khi người dùng chỉ tra cứu thông tin -> Gọi `get_issue`.

## Quy Trình Xác Nhận 2 Bước

1. **Bước 1 — Tóm tắt và dừng lại chờ (userConfirmed = false):**
   - Gọi `create_issue` với `userConfirmed: false`.
   - Gửi nguyên văn bản tóm tắt công cụ trả về, và **luôn thêm một câu mời xác nhận ở cuối** — nút bấm không phải lúc nào cũng hiện ra trên Telegram (phụ thuộc plugin), nên người dùng cần biết cả hai cách:
     `"Anh/chị bấm nút xác nhận bên dưới hoặc nhắn 'Xác nhận' / 'Đúng rồi' giúp em nhé ạ."`
   - Không chèn thêm các icon trang trí thừa thãi.
   - **DỪNG LẠI VÀ CHỜ** người dùng phản hồi. Tuyệt đối không tự xác nhận thay người dùng.

2. **Bước 2 — Xử lý quyết định của người dùng:**
   - **Người dùng đồng ý** (bấm nút xác nhận hoặc nhắn "đúng rồi", "ok gửi đi", "chuẩn rồi", "tạo đi em"):
     Gọi `create_issue` với `userConfirmed: true`.
   - **Người dùng muốn chỉnh sửa / bổ sung (nhắn trực tiếp thông tin sửa):**
     Tiếp nhận thông tin mới, cập nhật lại dữ liệu, phát lại bản tóm tắt mới và tiếp tục chờ xác nhận.

## Common Mistakes

- **Bỏ qua bước chờ:** Vừa gửi tóm tắt xong lập tức gọi `userConfirmed: true` trong cùng một lượt.
- **Tự tiện diễn đạt lại:** Sửa đổi câu chữ hoặc thêm bớt các trường dữ liệu so với bản tóm tắt của công cụ.
