# Template: Phê Duyệt Người Dùng Trực Tiếp Trong Nhóm Telegram (In-Group Approval)

Thư mục mẫu này cung cấp giải pháp trọn gói để phê duyệt tài khoản người dùng (giáo viên, cộng tác viên, nhân viên) **trực tiếp qua nhóm hoặc forum topic Telegram**, loại bỏ hoàn toàn sự phụ thuộc vào web dashboard quản trị cồng kềnh.

---

## 1. Lý Do Thiết Kế (Design Rationale)

* **Không cần Web Dashboard**: Thay vì bắt người quản lý (CM, Lead, Admin) phải mở trình duyệt, đăng nhập web dashboard để bấm nút duyệt, toàn bộ yêu cầu đăng ký được bắn thẳng vào nhóm Telegram phụ trách.
* **Xử lý Native trong 1 chạm**: Người duyệt chỉ cần bấm nút `[✅ Duyệt]` ngay trên Telegram điện thoại.
* **Cập nhật tin nhắn tại chỗ (In-Place Edit)**: Khi bấm duyệt/từ chối, bot gọi `editMessageText` để ghi đè thẻ duyệt (hiện rõ `@username` của người vừa bấm) và gỡ bỏ toàn bộ nút bấm để chống bấm đúp hay tranh chấp duyệt.
* **Gửi phản hồi tức thì**: Người được duyệt nhận ngay tin nhắn chào mừng và tài liệu hướng dẫn; người bị từ chối nhận lý do lịch sự.

---

## 2. Các Thành Phần Trong Template

1. `types.ts`: Định nghĩa cấu trúc `PendingRegistration`, `ApprovalTarget`, `ApprovalActionPayload`.
2. `approval-card.ts`:
   - `buildApprovalCardText(reg)`: Sinh văn bản thẻ duyệt gửi vào nhóm Telegram/Topic.
   - `buildApprovalKeyboard(userId, nameCode)`: Sinh inline keyboard với nút duyệt và từ chối.
   - `formatApprovedGroupText(codeLine, approverTag)`: Định dạng tin nhắn sau khi duyệt.
   - `formatRejectedGroupText(codeLine, rejecterTag)`: Định dạng tin nhắn sau khi từ chối.

---

## 3. Quy Trình 4 Bước Tích Hợp Vào Bot Mới

### Bước 1: Tiếp đón người mới & Bắt buộc điền thông tin
Khi người dùng chưa có trong database gửi tin vào bot, bot chặn không cho tạo sự cố và yêu cầu gửi form:
```text
Xin chào thầy/cô!
Thầy/Cô vui lòng cung cấp các thông tin theo mẫu dưới đây:
Mã GV_Tên GV_Môn học (Toán/Tiếng Việt/Tiếng Anh/KHTN)_Cấp học phụ trách (TH/THCS/THPT)

Ví dụ:
T26_Phan_Thị_Phương_Thảo_Toán_TH
```

### Bước 2: Bóc tách thông tin & Lưu trạng thái `pending`
Bot phân tích cú pháp thông tin, lưu vào SQLite với `status: "pending"`, và trả lời:
> *"Dạ em đã nhận thông tin đăng ký của Thầy/Cô và chuyển tới CM phụ trách môn [Môn học] duyệt ạ. Thầy/Cô vui lòng chờ trong giây lát nhé!"*

### Bước 3: Đẩy thẻ duyệt vào Topic của nhóm Telegram
Bot gọi Telegram Bot API gửi vào nhóm kèm 2 nút Inline:
```text
📋 T26_Phan_Thị_Phương_Thảo_Toán_TH

• Mã GV: T26
• Tên GV: Phan Thị Phương Thảo
• Môn: Toán | Cấp học: TH
• Telegram: @Username
• Thời gian: 12:01:03 28/10/2026
```

### Bước 4: Xử lý Callback khi quản lý bấm nút
Khi nhân sự bấm nút `[✅ Duyệt]` hoặc `[❌ Từ Chối]`:
1. Dùng `getChatMember` lấy `@username` thật của người vừa bấm nút.
2. Cập nhật database: `status: "approved"` (hoặc `"rejected"`).
3. Sửa tin nhắn trong nhóm thành:
   `✅ Đã duyệt: T26_Phan_Thị_Phương_Thảo_Toán_TH`
   `Người duyệt: @Username`
   và gỡ bỏ nút bấm (`reply_markup: { inline_keyboard: [] }`).
4. Gửi tin nhắn chào mừng và link Sổ tay về chat riêng của người dùng.
