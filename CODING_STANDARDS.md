# CODING_STANDARDS.md

Quy tắc cần **phán đoán**, tức là không có công cụ nào kiểm thay được. Quy tắc máy kiểm được nằm ở `bun run verify` (lint, kiểu, test, `scan`, kiểm docs) và ở CI; đừng viết lại ở đây.

Ngữ cảnh và thuật ngữ: đọc `GLOSSARY-MAP.md` rồi `GLOSSARY.md` của ngữ cảnh đang sửa. Quyết định đã chốt: đọc `docs/adr/` và `packages/core/docs/adr/`.

## 1. Thay đổi hành vi runtime cần chủ ký

Các thay đổi sau ảnh hưởng người dùng thật hoặc hợp đồng với harness, phải nêu rõ trong PR và cần chủ xác nhận trước khi merge:

- Câu chữ gửi người báo (mọi chuỗi đi qua `CopyCatalog`).
- `agentInstruction`, persona, skill, hay lời nhắc hệ thống mà agent đọc.
- Chính sách ưu tiên, cổng xác nhận, cổng huỷ/đóng (ADR-0006).
- Hợp đồng `intake_step` (`action` của legacy) và hợp đồng MCP.
- Bất biến an toàn: ghi vào ticket đã có (ADR-0008), mô tả ticket nguyên văn (ADR-0010), không tự xác nhận, không ghi đè định danh.

Mọi thay đổi cần ý này phải kèm test mang mã sự cố gốc.

## 2. Logic tất định ở engine, diễn đạt ở prompt

Mọi quyết định nghiệp vụ (gate, ưu tiên, park/split, xác nhận, tra cứu) nằm ở tool và engine, kiểm được bằng test. Prompt chỉ lo diễn đạt. LLM chỉ ở ba cổng có hợp đồng: `extractor`, `TechReviewer`, `CommandInterpreter`; mỗi cổng phải có đường lùi tất định khi lỗi hoặc hết giờ.

Không nhét điều kiện nghiệp vụ vào chuỗi thông báo để "tiết kiệm code". Chữ là hợp đồng với người dùng, logic là hợp đồng với test.

## 3. Nhất quán xuyên file

Khi đổi một hợp đồng ở core, rà và cập nhật **tất cả** những chỗ còn lại đang mô tả nó:

- Bảng ánh xạ và kiểu ở core.
- `packages/core/CHANGELOG.md` (mục "Changed"/"Added").
- Persona và skill của `apps/tieulinh-legacy` nếu chúng dựa vào hợp đồng cũ (legacy đóng băng: không sửa, nhưng phải biết mình vừa làm lệch nó).
- Tài liệu ở `docs/` trong cùng PR.
- Sổ đối chiếu và bản ghi vàng nếu hành vi được đo ở đó.

Bản ghi vàng và sổ đối chiếu là chuẩn: không xoá hay nới lỏng test legacy để làm xanh mà không cập nhật sổ kèm lý do.

## 4. Đặt tên và ngôn ngữ

Dùng đúng từ trong `GLOSSARY.md` của ngữ cảnh, kể cả khi từ đó khó dịch. Không tự đặt từ mới cho khái niệm đã có tên. Tên mới thì thêm vào glossary kèm định nghĩa và "Avoid".

Tên hàm và biến: tiếng Anh, động từ-thành-giờ danh (đọc theo cặp `read`/`write`, `create`/`delete`). Chữ gửi người dùng: tiếng Việt, lấy từ `CopyCatalog`.

## 5. Đường lùi và an toàn

Mọi cổng ra ngoài (tracker, binding, media, hook sau khi tạo) đi qua một cổng duy nhất, và mọi cổng đều có đường lùi tất định khi lỗi. Một lượt, một khoá chat. Không tự xác nhận thay người báo; không ghi vào ticket đã có nếu chưa có cú bấm khớp nhãn nút chính xác.

Lỗi ở một lượt không được làm hỏng các lượt sau: trạng thái phải là bền theo lượt, và phần trăm lệch chỉ đo được khi chạy lại từ trạng thái trước đó.

## 6. Repo công khai

Không secret, không IP/host nội bộ, không số điện thoại, không chat ID, không tên người thật, không đường dẫn `/home/<tên>`. `bun run scan` phải sạch. Thêm mẫu vào `.scan-denylist.d/<tên-agent>.txt` (mỗi agent một file, để hai agent không ghi đè lẫn nhau), không sửa `.scan-denylist` chung.

## 7. PR

Mỗi PR tự kiểm được, không đổi production. Có test và docs đi kèm. Tiêu đề theo Conventional Commits, scope là tên package. PR body theo khuôn của skill `pr`: tóm tắt bằng hình nhỏ nhất nói rõ thay đổi, bằng chứng trước/sau, và mức nguy hiểm khi merge (cửa một chiều hay hai chiều, bán kính ảnh hưởng).
