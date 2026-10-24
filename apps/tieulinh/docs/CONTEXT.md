# Tiểu Linh

Bot Telegram tiếp nhận sự cố kỹ thuật của VUIHOC, biến tin nhắn của người báo thành ticket trên Itsaplan và theo ticket tới lúc đóng.

## Người và bot

**Bot tiếp nhận**:
Bot Telegram phỏng vấn người báo rồi tạo ticket. Hiện có **Tiểu Linh** (sự cố kỹ thuật).
_Tránh_: agent, assistant (khi nói về vai trò nghiệp vụ)

**Người báo**:
Người nhắn cho bot tiếp nhận để báo một sự cố; là người duy nhất được xác nhận tóm tắt.
_Tránh_: user, khách, requester, reporter

**Người xử lý**:
Người của đội Kỹ thuật hoặc Product nhận ticket và làm việc trên Itsaplan.
_Tránh_: kỹ thuật viên (khi nói chung cho cả Product), assignee

## Tiếp nhận

**Tờ khai**:
Toàn bộ thông tin bot đang gom cho một sự cố hay yêu cầu trong một chat, từ tin đầu tiên tới lúc thành ticket, bị huỷ hoặc hết hạn.
_Tránh_: bản nháp, draft, DraftSession, session, phiên

**Nhánh**:
Loại tờ khai quyết định trường nào bắt buộc, trường nào nên hỏi (vd app di động, web, thanh toán, gia sư).
_Tránh_: variant, branch, productKey

**Trường bắt buộc**:
Trường thiếu thì không tạo ticket.
_Tránh_: required field (khi lẫn với trường nên hỏi)

**Trường nên hỏi**:
Trường bot hỏi một lượt cho đủ hồ sơ; người báo không có thì vẫn tạo ticket.
_Tránh_: optional, nen_hoi (khi viết văn)

**Xác nhận tóm tắt**:
Người báo đồng ý với bản tóm tắt tờ khai; chỉ sau bước này ticket mới được tạo. Bot không bao giờ tự xác nhận thay người báo.
_Tránh_: confirm, userConfirmed, "đúng rồi" (khi nói về khái niệm)

**Mức ưu tiên**:
Một trong Thấp, Trung bình, Cao, Khẩn cấp; suy từ bằng chứng ưu tiên theo bảng luật, không do bot hay người báo tự đặt.
_Tránh_: urgency, muc_khan_cap, độ gấp

**Bằng chứng ưu tiên**:
Các sự thật về sự cố quyết định mức ưu tiên: phạm vi ảnh hưởng (một người, một nhóm, toàn hệ thống), có chặn học, có chặn giao dịch, có mất dữ liệu, có cách làm tạm.
_Tránh_: evidence, priority matrix

**Hệ thống**:
Hệ thống nội bộ nơi sự cố xảy ra, thuộc danh mục đóng (vd CRM_Vuihoc, DUO_Vuihoc, TUTOR_Vuihoc).
_Tránh_: system label, app (khi ý là hệ thống)

**Sản phẩm**:
Sản phẩm kinh doanh mà sự cố hay yêu cầu liên quan (vd Duo, Tự học, Gia sư); khác với hệ thống.

**Tài khoản học sinh**:
Tài khoản hoặc số điện thoại phụ huynh dùng để tra học sinh bị ảnh hưởng.
_Tránh_: studentId, student_account (khi viết văn)

**Mã khách hàng**:
Mã định danh nội bộ trong CRM/ERP; không bao giờ là số điện thoại.
_Tránh_: customer ID khi đang nói về SĐT

**Phòng ban người báo**:
Bộ phận nơi người báo làm việc (Vận hành, CSKH, Sale…).
_Tránh_: department, dept, phong_ban (khi viết văn)

## Ticket và vòng đời

**Ticket**:
Bản ghi trên Itsaplan được tạo từ một tờ khai đã xác nhận tóm tắt.
_Tránh_: issue, vé, yêu cầu (khi ý là bản ghi trên Itsaplan)

**Dự án**:
Không gian ticket trên Itsaplan: TECH (Tiểu Linh chạy thật), TECHTEST (Tiểu Linh thử).
_Tránh_: project (khi viết văn), workspace

**Liên kết chat**:
Mối nối giữa một ticket và chat của người báo, để bot báo ngược khi ticket thay đổi.
_Tránh_: binding, route

**Tin theo dõi**:
Một tin nhắn bot đã gửi cho người báo về một ticket; người báo trả lời vào tin đó thì nội dung thành comment trên ticket.
_Tránh_: message route, prompt message

**Đã xử lý**:
Người xử lý báo đã làm xong; ticket nằm ở trạng thái này để theo dõi cho tới khi người xử lý tự kiểm tra và chuyển sang hoàn tất.
_Tránh_: Resolved (khi viết văn), completed, chờ duyệt, nghiệm thu

**Hoàn tất**:
Ticket đã đóng. Chỉ người xử lý mới chuyển ticket sang hoàn tất; bot và người báo không bao giờ tự đóng ticket.
_Tránh_: Done (khi viết văn), closed, completed, confirmed, tự đóng

**Phản hồi đã ổn**:
Người báo bấm nút báo rằng sự cố đã xử lý là ổn. Chỉ được ghi thành comment cho người xử lý tham khảo; không đổi trạng thái ticket. Người báo không bấm thì không suy ra điều gì — thấy chưa ổn thì họ tự nhắn lại.
_Tránh_: xác nhận xong, confirm_done, nghiệm thu, duyệt

## Tri thức

**Tri thức ticket**:
Nguyên nhân gốc và cách xử lý rút ra từ một ticket hoàn tất, dùng để gợi ý cho sự cố sau.
_Tránh_: ingest, nạp (khi nói về nội dung thay vì hành động)

**Knowledge Graph (KG)**:
Đồ thị các ticket hoàn tất cùng hệ thống, sản phẩm, nhóm nguyên nhân và tri thức ticket, dùng để tìm ticket tương tự.
_Tránh_: Memgraph (khi nói về khái niệm), graph DB

**Nhóm nguyên nhân**:
Loại cơ chế lỗi thuộc danh mục đóng (vd SIP_TELEPHONY_FAILURE, DATA_SYNC_MISMATCH), gắn cho mỗi ticket trong KG.
_Tránh_: CauseTaxon, taxon (khi viết văn)

**Comment ghim**:
Comment người điều phối TECH (tech lead) ghim trên ticket, ghi Nguyên nhân / Cách khắc phục / Ticket tương tự. Là nguồn chuẩn của tri thức ticket.
_Tránh_: pinned comment, comment chuẩn

**Tín hiệu người**:
Những gì người làm trên ticket: comment ghim, liên kết hay mã Related Tickets người gắn, người gỡ. Gợi ý do bot ghi không phải tín hiệu người.
_Tránh_: human label, nhãn

**Cụm nguyên nhân**:
Nhóm ticket hoàn tất mà người đã xác định là cùng nguyên nhân lỗi, dựng chỉ từ tín hiệu người (ADR-0007).
_Tránh_: cluster, cụm đồ thị, huyết mạch

**Ticket tương tự**:
Ticket hoàn tất cùng cụm nguyên nhân với sự cố đang tiếp nhận. Cùng hệ thống hay sản phẩm thôi thì không phải ticket tương tự. Bot chỉ ghi khi đủ tự tin; không đủ thì không ghi gì.

**Câu hỏi phân biệt**:
Khi sự cố đang tiếp nhận có thể cùng nguyên nhân với ≥ 2 cụm khác nhau (mơ hồ): bot không ghi ticket tương tự nào, thay vào đó nêu một câu hỏi ngắn giúp người xử lý tự phân biệt (vd cần kiểm tra CRM). Câu hỏi này nằm trong **comment gợi ý của bot**, không phải mô tả ticket và không phải câu hỏi hỏi lại người báo (xem ADR-0010).
_Tránh_: disambiguation, câu hỏi làm rõ (khi nói về hội thoại với người báo)
_Tránh_: related ticket, similar ticket (khi viết văn)

**Mô tả ticket vs. gợi ý của bot**:
Mô tả ticket là **lời nguyên văn của người báo** — không có nhận định, tóm tắt hay phỏng đoán của AI lẫn vào. Mọi suy luận kỹ thuật (nguyên nhân đã biết, gợi ý runbook, câu hỏi phân biệt) nằm ở **comment riêng của bot**. Xem ADR-0010.
