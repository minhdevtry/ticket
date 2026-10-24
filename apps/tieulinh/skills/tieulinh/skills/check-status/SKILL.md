---
name: check-status
description: Use when a user asks about ticket progress, resolution status, technician comments, or mentions a specific ticket identifier
tools: [get_issue, check_identity]
---

# Tra Cứu Tiến Độ (Check Status)

## Overview

Tra cứu trạng thái xử lý, người tiếp nhận và lịch sử trao đổi của ticket kỹ thuật trên Itsaplan, ưu tiên ticket gần nhất mà hai bên vừa trao đổi.

## When to Use

- Người dùng hỏi tiến độ: "ticket của anh xử lý đến đâu rồi em?", "sự cố phòng 5511 xong chưa?", "sắp sửa xong chưa em?".
- (Người dùng nêu mã ticket cụ thể, vd `TECH-42` → KHÔNG dùng skill này: gọi `intake_step` với nguyên văn tin — tool tra cứu và tự giới hạn ticket của người khác chỉ thấy trạng thái.)

## When NOT to Use

- Người dùng đang mô tả sự cố kỹ thuật mới phát sinh -> Dùng skill `incident-intake`.
- Người dùng giục giã gấp gáp do lớp học sắp bắt đầu hoặc trễ giờ nghiêm trọng -> Chuyển nguyên văn vào `intake_step` (không tự ghi, không tự hứa nâng mức).

## Core Workflow

1. **Xác định mã ticket:**
   - Nếu người dùng nêu rõ mã: Dùng trực tiếp mã đó (`identifier`).
   - Nếu người dùng không nêu mã: Gọi `check_identity` (truyền `telegramUserId`/`chatId`) để lấy `latestTicket`.
2. **Gọi công cụ tra cứu:**
   - Gọi `get_issue` với `identifier` (hoặc truyền `chatId` để công cụ tự động đối soát ticket gần nhất).
3. **Phản hồi người dùng:**
   - Trả lời bằng nội dung tóm tắt trạng thái ngắn gọn, tinh tế từ `humanSummary`.
   - Nếu ticket ở trạng thái **Đã xử lý (chờ duyệt)**: Hướng dẫn người dùng kiểm tra lại lớp học/hệ thống và bấm xác nhận hoàn tất.
   - Nếu kỹ thuật viên có lời nhắn cần thông tin bổ sung: Nhẹ nhàng đề xuất người dùng cung cấp để cập nhật giúp.

## Tiêu Chuẩn Thông Báo & Thẩm Mỹ

- **Không lạm dụng icon:** Tránh rải các biểu tượng thừa (như 🎫, 📥, ⏳, ⚙️). Sử dụng văn phong gãy gọn, tinh tế và dễ đọc.
- **Trung thực tuyệt đối:** Không tự bịa trạng thái, không tự đoán thời điểm hoàn thành nếu tracker chưa có cập nhật.

## Common Mistakes

- **Hỏi lại mã ticket:** Người dùng vừa tạo ticket xong hỏi "sao rồi em", lại hỏi ngược lại "anh cho em xin mã ticket" thay vì tự động tra cứu ticket gần nhất.
- **Bịa thông tin:** Không có phản hồi từ kỹ thuật viên nhưng tự trấn an là "chắc sắp xong rồi anh".
