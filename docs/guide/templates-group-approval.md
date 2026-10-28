# Mẫu: Phê Duyệt Trực Tiếp Trong Nhóm Telegram (In-Group Approval)

Mẫu thiết kế (Template) này giúp các bot xây dựng trên `@vuihoc/bot-core` triển khai tính năng đón tiếp và phê duyệt người dùng (giáo viên, cộng tác viên, khách hàng) **trực tiếp qua nhóm Telegram**, thay thế hoàn toàn web dashboard quản trị cồng kềnh.

Mã nguồn mẫu nằm tại: `packages/core/templates/group-approval/`.

---

## 1. Kiến Trúc & Luồng Vận Hành

```
[Người dùng Mới] ──(1) Gửi Form Đăng Ký──> [Bot Tiếp Nhận]
                                                    │
                                           (2) Lưu Pending
                                                    │
                                                    ▼
[Nhóm Telegram Quản Lý (Topic Duyệt)] <──(3) Bắn Thẻ Duyệt + Nút Inline
                 │
      (4) Bấm [✅ Duyệt]
                 │
                 ▼
[Cập nhật Thẻ Duyệt: Xoá nút + Ghi @username Người Duyệt]
                 │
                 ▼
[Bot Tự Động Bắn Tin Chào Mừng + Tài Liệu về Chat Riêng Người Dùng]
```

---

## 2. Định Dạng Thẻ Duyệt Trong Nhóm Telegram

Thẻ duyệt được gửi vào topic duyệt của nhóm phụ trách với cấu trúc chuẩn:

```text
📋 T26_Phan_Thị_Phương_Thảo_Toán_TH

• Mã GV: T26
• Tên GV: Phan Thị Phương Thảo
• Môn: Toán | Cấp học: TH
• Telegram: @TE_MinhDN3
• Thời gian: 12:01:03 28/10/2026

🔘 [✅ Duyệt Giáo Viên]   🔘 [❌ Từ Chối]
```

### Xử lý Khi Bấm Nút:
1. **Lấy `@username` người bấm**: Dùng API `getChatMember` để lấy chính xác username Telegram của người vừa bấm nút (hoặc fallback về họ tên).
2. **Cập nhật đè tin nhắn (Edit In-Place)**: Gọi `editMessageText` để ghi đè tin nhắn cũ trong nhóm:
   ```text
   ✅ Đã duyệt: T26_Phan_Thị_Phương_Thảo_Toán_TH
   Người duyệt: @TE_MinhDN3
   ```
   hoặc khi từ chối:
   ```text
   ❌ Đã từ chối: T26_Phan_Thị_Phương_Thảo_Toán_TH
   Người từ chối: @TE_MinhDN3
   ```
3. **Triệt tiêu nút bấm**: Truyền `reply_markup: { inline_keyboard: [] }` để nút bấm biến mất hoàn toàn, chống bấm đúp hay tranh chấp duyệt.

---

## 3. Mã Nguồn Mẫu Sử Dụng

Sử dụng trực tiếp các hàm tiện ích từ template:

```ts no-check
import {
  buildApprovalCardText,
  buildApprovalKeyboard,
  formatApprovedGroupText,
  formatRejectedGroupText,
} from "../templates/group-approval";

// 1. Sinh thẻ duyệt
const text = buildApprovalCardText({
  userId: "7272500242",
  nameCode: "T26",
  fullName: "Phan Thị Phương Thảo",
  subject: "Toán",
  level: "TH",
  username: "TE_MinhDN3",
});
const keyboard = buildApprovalKeyboard("7272500242", "T26");

// 2. Gửi vào nhóm/topic duyệt qua Telegram Bot API
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: "-1000000000001",
    message_thread_id: 5,
    text,
    reply_markup: keyboard,
  }),
});
```

---

## 4. Tương Lai: Chuyển Từ Template Lên Thư Viện Lõi

Hiện tại tính năng này được giữ ở dạng **Template độc lập** (`packages/core/templates/group-approval/`) để các đội dự án dùng thử thực tế. Sau một thời gian vận hành ổn định, nếu không phải sửa đổi nhiều và có từ 2 bot trở lên cùng sử dụng, mẫu này sẽ được xem xét chuẩn hoá và tích hợp chính thức vào thư viện lõi.
