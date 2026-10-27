# Đặc tả Worker 1: Kiểm thử thông luồng E2E toàn diện cho Tiểu Linh Mới trên TECH2 (Parity 100%)

## Context & Vai trò
- Bạn là Kỹ sư Kiểm thử Toàn trình (E2E QA Lead).
- Hệ thống đang chạy cục bộ trên máy dev:
  + OpenClaw Gateway Lễ tân (cổng 18796) kết nối bot Telegram `@test_ticket123_bot`.
  + App Hậu cần (`apps/tieulinh`, webhook :3120, health :3121).
  + Itsaplan server nội bộ: lấy từ `$ITSAPLAN_BASE_URL` (dự án `TECH2`, Team `tech`).
- Sử dụng tài khoản Telegram `TE_MinhDN3` (chat ID lấy từ cấu hình pairing hoặc `ADMIN_IDS`) qua công cụ `~/Downloads/test/telegram-mcp/` hoặc script E2E có sẵn.

---

## 1. Quy tắc Danh tính Bắt buộc (Smart Identity Memory)
- Người dùng `TE_MinhDN3` đã được định danh thuộc phòng ban: **"Vận hành" (OP)**.
- **Ranh giới Agent thông minh**:
  + Trong toàn bộ các cuộc hội thoại tiếp nhận: Bot **TUYỆT ĐỐI KHÔNG ĐƯỢC HỎI LẠI** câu hỏi *"Anh/chị thuộc phòng ban nào?"*.
  + Bot phải tự động hiểu và điền `department: "Vận hành"` từ hồ sơ danh tính có sẵn.
  + **Ngoại lệ duy nhất**: Chỉ khi nào người báo tự khai trong câu nói (ví dụ: *"Báo hộ bên Sale khóa 10"*, *"Hỗ trợ phòng Quản lý lớp"*) thì bot mới ghi nhận phòng ban theo lời tự khai đó.

---

## 2. Danh sách Kịch bản Thông Luồng Bắt buộc (Scenarios)

Chạy kiểm thử thực tế và xác minh đủ 5 kịch bản sau:

### Kịch bản 1: Happy Path (Từ A đến Z)
- Người dùng gửi tin: *"Chào em, phòng Vận hành cần báo sự cố không vào được bài giảng lớp 10"*.
- Bot hỏi trường thiếu kỹ thuật (vd: hệ thống, tài khoản học sinh, mã phòng).
- Người dùng chọn/nhập thông tin.
- Bot hiển thị tóm tắt sự cố kèm nút inline `✅ Đúng rồi, tạo ticket`.
- Người dùng xác nhận ➔ Ticket thật được tạo trên Itsaplan `TECH2`.
- Kiểm tra trực tiếp trên Itsaplan API: Ticket tồn tại, đúng tiêu đề, đúng phòng ban Vận hành, mô tả giữ nguyên văn lời người báo (chuẩn ADR-0010).

### Kịch bản 2: Huỷ bỏ sự cố giữa chừng (D8)
- Đang trong quá trình trao đổi, người dùng nhắn: *"Thôi huỷ đi em, bên anh vào lại được rồi"*.
- Bot xác nhận huỷ tờ khai (`canceled`), dọn dẹp draft, không tạo ticket rác lên `TECH2`.

### Kịch bản 3: Lệnh `/new` và `/reset`
- Gõ `/new` hoặc `/reset` ➔ Bot xác nhận làm mới phiên làm việc (`New session started`), xoá ngữ cảnh cũ để bắt đầu tờ khai mới tinh.

### Kịch bản 4: Cơ chế chống bấm đúp & Khóa nút (`iris-tuong-tac`)
- Khi bot gửi nút bấm inline, người dùng bấm nút ➔ Nút lập tức chuyển trạng thái có dấu tick `✓` và khóa lại, ngăn chặn việc bấm đúp hoặc bão callback lặp.

### Kịch bản 5: Chiều ngược Webhook (Itsaplan ➔ Telegram)
- Chuyển trạng thái ticket vừa tạo trên `TECH2` sang `Resolved` (Đã giải quyết).
- App Hậu cần nhận webhook cổng 3120 ➔ Bắn tin thông báo giải quyết về Telegram người báo kèm nút `Đã ổn` (chuẩn ADR-0006 bản 10/10).

---

## 3. Ranh giới & Điều cấm tuyệt đối (Forbidden)

- **CẤM SỜ VÀO**:
  + Không sờ vào tính năng "Ticket tương tự" (`runSimilarTicketsInBackground`, cổng 8140, vector search).
  + Không sờ vào tính năng "Học thụ động" (`ask-learning`, bảng derived).
  *(Hai tính năng này tạm hoãn có chủ đích, không làm loãng mục tiêu thông luồng).*
- **CẤM GHI VÀO TECH PRODUCTION**: Mọi thao tác tạo và cập nhật ticket chỉ được diễn ra trên `TECH2`. Tuyệt đối không can thiệp vào `TECH`.
- **CẤM TRIỂN KHAI PROD**: Không chạy lệnh deploy hay sửa server prod; chỉ hoàn thành test và lưu báo cáo.

---

## 4. Tiêu chí Chấp nhận (Acceptance Criteria)

- [ ] Quy tắc nhớ danh tính hoạt động: Không bao giờ hỏi lại phòng ban của `TE_MinhDN3`.
- [ ] Vượt qua đủ 5 kịch bản luồng thực tế trên `TECH2`.
- [ ] Kiểm tra ticket thực tế sinh ra trên Itsaplan server với đầy đủ ID, identifier và metadata.
- [ ] Không có lỗi phiên đăng nhập Telegram hay lỗi pairing code.
- [ ] Xuất bản báo cáo chi tiết kèm log đối thoại vào `orchestration/report-e2e-parity.md`.
- [ ] Báo cáo `worker_done` khi hoàn tất.
