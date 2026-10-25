# ADR-0008: Một luồng chat, mọi lần ghi vào ticket đã có phải được người báo xác nhận

Ngày: 28/09/2026. Chốt với user qua buổi hỏi–đáp sau vụ TECH-795 → TECH-975.

## Bối cảnh

Người báo chỉ có một luồng chat với Tiểu Linh, nhưng thường có nhiều việc cùng lúc. Đo trên dữ liệu
thật: 27% người báo từng có ≥ 2 ticket mở cùng lúc (có người 12), 39% tin nhắn tới khi người báo đang
có ticket khác còn mở, người báo nhắn trung bình 4–5 lượt cho một sự cố. Sau khi bot chuyển câu hỏi
của kỹ thuật, khoảng 1/3 ca theo dõi được người báo trả lời bằng tin thường và bot mở nhầm tờ khai
mới (TECH-795 → TECH-975). Không hãng helpdesk lớn nào để AI tự gán tin vào một trong nhiều ticket
mở; họ hoặc chặn (Intercom: 1 hội thoại mở/kênh) hoặc gộp sau (Zendesk/Freshdesk/Help Scout). Topic
trong chat riêng của bot Telegram (Bot API 9.3) còn quá mới và đang lỗi.

Bản vá trước (9cac832…e986ba3) để LLM tự gắn tin vào ticket cũ khi "chắc" — user bác: nhét nhầm sự cố
mới vào ticket cũ là lỗi tệ nhất (sự cố chìm), và người báo phải chịu trách nhiệm cho điều mình gửi.

## Quyết định

1. **Một luồng chat.** Có cú pháp rõ ràng, không bắt buộc:
   - `/new …` — ép mở sự cố mới (tờ khai đang dở được gác lại, nhắc sau như luồng "Sự cố mới").
     Nhắn thường vẫn mở sự cố mới như cũ.
   - `bổ sung TECH-XXXX …` / `sửa TECH-XXXX …` — thêm hoặc sửa ticket đã có.
   - `TECH-XXXX` (hỏi tình trạng) — tra cứu.
2. **Không bao giờ lặng lẽ ghi vào ticket đã có.** Mọi lần bổ sung / sửa / gộp đều hiện rõ *ticket
   nào + nội dung sẽ ghi* kèm nút xác nhận; người báo bấm mới ghi, không bấm thì thôi. (Reply thẳng
   vào tin bot chuyển từ ticket vẫn ghi ngay: chính người báo đã chỉ định ticket bằng thao tác reply.)
3. **Tin không lệnh, không mã** thuộc tờ khai đang dở hoặc mở sự cố mới. Riêng khi kỹ thuật vừa hỏi
   (≤ 72 giờ, không có tờ khai dở) thì *gợi ý* nút "Bổ sung TECH-X" / "Sự cố mới"; LLM chỉ dùng để
   bỏ gợi ý khi tin rõ ràng là lỗi khác chủ đề — không bao giờ tự gắn.
4. **Ticket của người báo** = binding cùng chat (gồm cả ticket bot cũ) hoặc mô tả ticket có Telegram
   ID của người đó.
5. **Sửa** (`sửa TECH-X …`) sửa thẳng tiêu đề / trường "Thông tin sự cố" / câu trong mô tả sau khi
   người báo xác nhận bản xem trước; Tiểu Linh ghi comment "cũ → mới" để giữ dấu vết.
6. **Quyền:** bổ sung/sửa chỉ ticket của mình. Tra cứu ticket của mình thấy đủ (tiêu đề, trạng thái,
   người xử lý, trao đổi gần nhất); ticket người khác chỉ thấy trạng thái và người xử lý.
7. **Sửa sai:**
   - Người báo: ngay sau khi bot tạo nhầm ticket X, nhắn "cái này bổ sung cho TECH-Y" → xem trước →
     xác nhận → nội dung X chép sang Y, X ghi chú trùng và **bot tự chuyển X sang Canceled** (ticket
     rác do chính bot sinh, không phải đóng việc của người xử lý — ADR-0006 vẫn giữ).
   - Kỹ thuật: comment trên X tuyên bố X trùng Y (LLM đọc, vd "Báo trùng TECH-943 => Hủy TECH-944")
     → bot chép nội dung X sang Y, nối link, huỷ X nếu chưa huỷ.
8. Tinh thần "người báo chịu trách nhiệm" giữ nguyên: xác nhận khi tạo ticket, hỏi gặng đủ dữ kiện
   kỹ thuật (tech-review), xác nhận "Đã ổn" khi xử lý xong, và giờ thêm xác nhận khi ghi vào ticket cũ.

## Hệ quả

- `/new` trùng lệnh reset phiên của OpenClaw và bị nuốt trước khi tới agent → plugin `xac-nhan-xong`
  bắt `/new` ở `before_dispatch`, báo worker đặt cờ "ép sự cố mới" cho chat; pipeline đọc cờ.
- Cần một thông báo hướng dẫn cú pháp gửi tới người dùng (gửi hàng loạt cần user duyệt nội dung).

## Bổ sung 30/09/2026 — không có ngoại lệ "bot chắc chắn"

Sự cố TECH-1013: tin sau khi bot vừa tạo ticket (có ảnh, hoặc LLM đoán "bổ sung") bị ghi thẳng vào ticket đó,
rồi câu "ticket mới ạ" ghi tiếp — vì khối "tài liệu đã tạo" còn đường `appendFollowUp` không qua xác nhận.

Nguyên tắc chốt: **mọi lần ghi vào Itsaplan do tin nhắn của người báo (comment, sửa, nâng mức, chuyển/huỷ ticket) đều phải qua
bản xem trước + một lần bấm nút, kể cả khi bot hiểu rõ ý là "bổ sung"**. Bot hiểu ý xong vẫn hỏi lại bằng nút.
- Tin sau khi tạo ticket (không nhắc mã): "➕ Bổ sung vào TECH-X" / "Sự cố mới"; chỉ ghi khi bấm nút đầu.
- Gõ chữ "ticket mới ạ", "phụ huynh khác"… trong lúc chờ bấm hoặc ngay sau khi tạo = "Sự cố mới".
- Tool `escalate_issue` (tự nâng Urgent + ghi comment lên ticket bất kỳ) gỡ khỏi Tiểu Linh cùng skill `escalate-issue`;
  giục gấp đi qua `intake_step`, xác nhận xong thì nâng mức nếu có lý do (quy tắc 29/09).
- Còn ghi tự động (không do tin người báo): tạo ticket sau khi bấm "đúng rồi", Related Tickets/link do bộ tra + chốt ticket
  tương tự, thông báo trạng thái, huỷ ticket trùng do kỹ thuật tuyên bố (quyết định 10c).
