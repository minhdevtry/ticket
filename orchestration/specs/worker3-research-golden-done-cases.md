# Đặc tả Worker 3: Nghiên cứu dữ liệu ca Done và Xây dựng Bộ Kiểm chuẩn Vàng (Golden Dataset)

## Context & Vai trò
- Bạn là Kỹ sư Dữ liệu & Nghiên cứu AI (Data & AI Research Engineer).
- Thư mục repo: `~/Documents/ticket` (hoặc worktree riêng).
- Bối cảnh:
  + Trên máy chủ production có Tiểu Linh thật đang phục vụ hàng nghìn giáo viên, CS, điều phối viên.
  + Dữ liệu các ca đã giải quyết (`Done`) chứa đầy đủ các câu từ thực tế, tiếng lóng, ngữ cảnh báo lỗi và cách người dùng phản hồi.
- Mục tiêu: Khai thác kho dữ liệu các ca `Done` này để xây dựng bộ 50 kịch bản kiểm thử vàng (Golden Dataset) ngoại tuyến, phục vụ cho việc đối soát độ thông minh của bot mới.

---

## 1. Nhiệm vụ Cụ thể

### Nhiệm vụ 1: Thu thập và Vệ sinh Dữ liệu (PII Redaction)
- Đọc dữ liệu lịch sử các ca sự cố kỹ thuật đã `Done` từ kho lưu trữ server hoặc file sao lưu cục bộ (dùng SSH lệnh đọc hoặc bản trích xuất).
- **Quy tắc an ninh tối thượng (`SECURITY.md`)**:
  + Bắt buộc chạy lọc dữ liệu (`redact`):
    - Che toàn bộ số điện thoại thật (thay bằng `<phone_number>`).
    - Che mã chat ID, tên người thật (thay bằng `<reporter_name>`).
    - Che IP nội bộ, URL nội bộ, token, secret.
  + Đảm bảo chạy `bun run scan` phải sạch 100%, không vi phạm denylist hay secret patterns.

### Nhiệm vụ 2: Phân tích & Trích xuất 50 Kịch bản Khó (Complex Edge Cases)
- Sử dụng mô hình hoặc script phân tích để chọn lọc ra **50 ca đại diện và thử thách nhất**:
  + 10 ca: Thiếu trường và bổ sung qua nhiều lượt hỏi đáp (Multi-turn clarification).
  + 10 ca: Dùng tiếng lóng, tên viết tắt của giáo viên / CS (như se-care, lms, duo, tutor, crm).
  + 10 ca: Báo nhiều lỗi cùng một lúc hoặc đổi ý giữa chừng (User cancellation / revision).
  + 10 ca: Báo hộ phòng ban khác (khác với phòng ban mặc định của người báo).
  + 10 ca: Báo sự cố khẩn cấp (SLA gấp, đường truyền phòng học, server down).

### Nhiệm vụ 3: Đóng gói Bộ Kiểm Chuẩn Vàng (Golden Fixture)
- Đóng gói 50 ca thành file JSON chuẩn cấu trúc: `docs/research/golden-50-done-cases.json`.
- Viết tài liệu phân tích sâu: `docs/research/golden-dataset-analysis.md`:
  + Thống kê phân bố các loại sự cố phổ biến.
  + Những điểm chatbot cũ hay bị "ngố" (hỏi lại phòng ban, hỏi lặp trường, không hiểu tiếng lóng).
  + Bộ tiêu chí đánh giá độ thông minh cho Agent thế hệ mới.

---

## 2. Ràng buộc & Điều cấm (Forbidden)

- **CẤM SỬA HOẶC TÁC ĐỘNG VÀO PRODUCTION**: Mọi thao tác chỉ là đọc dữ liệu (read-only) hoặc chạy phân tích ngoại tuyến (offline).
- **CẤM LƯU DỮ LIỆU NHẠY CẢM**: Không commit số điện thoại, tên thật, chat ID vào repo công khai.
- **CẤM TRIỂN KHAI VÀO BOT MỚI NGAY**: Đây là tài liệu và dữ liệu nghiên cứu phục vụ tương lai (Phase 2), không được tự ý sửa đổi code runtime của `apps/tieulinh`.

---

## 3. Tiêu chí Chấp nhận (Acceptance Criteria)

- [ ] File `docs/research/golden-50-done-cases.json` được tạo với đủ 50 kịch bản thực tế đã được che sạch PII.
- [ ] Tài liệu `docs/research/golden-dataset-analysis.md` hoàn chỉnh, phân tích sắc bén các ca biên.
- [ ] Chạy `bun run scan` sạch 100%.
- [ ] Xuất bản báo cáo tóm tắt kết quả nghiên cứu và báo cáo `worker_done`.
