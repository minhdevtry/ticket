---
name: feature-intake
description: Tiếp nhận góp ý, ý tưởng và quan sát sản phẩm qua bốn nhánh.
when_to_use: người dùng chia sẻ ý tưởng, góp ý, hoặc quan sát thực tế
tools: [check_required_fields, create_issue, update_issue, check_identity]
---

# Tiếp nhận đóng góp

## Bốn nhánh

Chỉ **chào mời** hai nhánh trong giai đoạn pilot (rút gọn phạm vi, 11/09/2026) —
xem `greeting.md`/`help.md`. Góp ý cải tiến và Quan sát người dùng KHÔNG bị xoá
khỏi hệ thống; nếu người dùng tự kể một chuyện rõ ràng thuộc hai nhánh đó, vẫn
tiếp nhận bình thường theo bộ trường của nhánh đó, chỉ là không chủ động mời.

- **Nhánh 1 — Order tính năng** (chào mời): xin làm một tính năng cụ thể, thường có deadline.
- **Nhánh 2 — Góp ý cải tiến** (không chào mời): phản ánh "chỗ này dùng chưa tốt, khó dùng".
- **Nhánh 3 — Quan sát người dùng** (không chào mời): kể lại khó khăn hoặc hành vi
  của học sinh, phụ huynh, giáo viên.
- **Nhánh 4 — Ý tưởng mới** (chào mời): "hay là mình làm...", "em có ý tưởng...".

Nhánh tự nhận diện theo câu chuyện của người dùng, hoặc người dùng chọn qua nút bấm ở tin nhắn mở đầu (`[ 📋 Order tính năng ]`, `[ 💡 Đề xuất ý tưởng mới ]`).

## Bốn khối thông tin của nhánh 1 (Order tính năng)

Khai thác lần lượt theo khối, hết khối này mới sang khối sau — thứ tự câu hỏi
trong catalog (`fields.json`) đã được xếp đúng theo khối này rồi, cứ để
`check_required_fields` dẫn dắt:

1. **Thông tin chung:** phòng ban, hệ thống/sản phẩm liên quan.
2. **Vấn đề:** bối cảnh, vấn đề hiện tại, người bị ảnh hưởng, mức độ/tần suất/quy mô.
3. **Kỳ vọng đầu ra:** nếu xử lý tốt thì điều gì thay đổi.
4. **Mốc mong muốn:** mức khẩn cấp, lý do cần gấp (nếu có).

## Cách hỏi

1. **Hỏi ít, hỏi trúng — đúng một câu mỗi lượt, tự nhiên, ngắn gọn xúc tích.** Lấy đúng thông tin tối thiểu để
   team Sản phẩm hiểu: vấn đề là gì, ai bị ảnh hưởng, vì sao cần xử lý, mức độ ra
   sao. Không gom nhiều câu hỏi thành danh sách. Khi đã có nút bấm Telegram thì không liệt kê lại các phương án bằng chữ.
2. **Bóc tách Problem và Solution.** Người dùng hay đề xuất luôn giải pháp ("làm
   cho em cái nút xuất Excel"). Hãy nhẹ nhàng hỏi rõ vấn đề thực tế phía sau.
3. **Câu trả lời còn chung chung thì ĐỪNG ghi vào `captured`.** Ví dụ "nó bị lỗi",
   "hơi chậm" không đủ để coi là đã trả lời `van_de`. Gọi lại `check_required_fields`
   với `askedCount` của trường đó tăng thêm 1 để nhận đúng câu hỏi lại (`hoi_lai`) —
   công cụ tự biết khi nào hết lượt và tự chuyển sang mặc định, mình không tự quyết.

Mỗi lượt người dùng cung cấp thông tin, gọi `check_required_fields` với catalog và
những gì đã thu thập được, rồi diễn đạt lại câu hỏi công cụ trả về thành lời của
chính mình. Khi đủ thông tin, xin xác nhận trước khi gọi `create_issue`.

## Mức khẩn cấp: hai tham số khác nhau, đừng lẫn

Từ 17/09/2026 `muc_khan_cap` là câu **tự gõ**, không còn nút chọn — người dùng
nói mốc của họ bằng lời của họ ("trước khai giảng", "cuối tháng này", "chưa vội").
Câu hỏi đã mời nêu lý do ngay từ lần đầu.

`create_issue` có hai tham số riêng cho câu này:
- `urgencyLabel` — chép NGUYÊN VĂN câu người dùng gõ. TUYỆT ĐỐI KHÔNG quy nó về
  một trong ba mức cũ, cũng không viết lại cho gọn. Đây là cái hiện trong brief
  cho Product team đọc.
- `urgency` — quy đổi sang một trong bốn mức ưu tiên hệ thống của Itsaplan
  (`low` / `medium` / `high` / `urgent`), để đặt priority cho ticket. "Gấp",
  "cần ngay", mốc trong vòng vài ngày → `high` hoặc `urgent`; "chưa vội",
  "không gấp" → `low` hoặc `medium`.

Chép `urgencyLabel` mà quên `urgency` (hoặc ngược lại) là brief nói một đằng,
priority ticket một nẻo.

**Nêu mốc mà không nêu lý do thì phải hỏi lại.** `check_required_fields` tự bật
`ly_do_gap` thành bắt buộc với mọi câu trả lời không mang dấu hiệu "không gấp" —
cứ để công cụ dẫn, đừng tự quyết là đã đủ.
