---
name: incident-intake
description: Use when a user reports a technical issue, system outage, classroom disruption, or software bug, answers a follow-up question, confirms or cancels, sends a screenshot, or adds details to an issue being reported
tools: [intake_step, get_intake_doc, get_similar_tickets, check_identity, register_identity, create_issue]
---

# Tiếp Nhận Sự Cố (Incident Intake)

## Một đường duy nhất: `intake_step`

Mỗi tin nhắn về sự cố — kể cả tin nhắc mã ticket cũ (bổ sung / sửa / tra cứu) và câu trả lời cho kỹ thuật — gọi `intake_step` với `message` là NGUYÊN VĂN tin người dùng, `chatId`, thông tin người báo (`reporterName`, `reporterUsername`, `reporterNameCode`) và `mediaPaths` nếu người dùng gửi ảnh/video. Rồi gửi **nguyên văn `voiceText`**.

Tool tự làm toàn bộ: trích xuất và chuẩn hoá taxonomy, lưu tờ khai `IntakeDocument`, hỏi từng trường còn thiếu (nút chọn tự hiện trên Telegram), đánh giá mức ưu tiên theo bằng chứng, tra ticket tương tự, tóm tắt xin xác nhận, tạo ticket khi người dùng xác nhận, và ghi phần bổ sung thành comment vào ticket đã tạo.

| `action` | Ý nghĩa | Bạn làm gì |
|---|---|---|
| `ask_missing_field` | Còn thiếu thông tin | Gửi `voiceText`, chờ trả lời |
| `confirm_summary` | Đủ thông tin, chờ xác nhận | Gửi `voiceText` (hoặc `displayMarkdown`); nút xác nhận đã có sẵn |
| `ask_new_or_continue` | Tin mới có mã định danh (SĐT, mã HS, mã đơn…) khác sự cố đang chờ xác nhận | Gửi `voiceText`, nút "Sự cố mới" / "Bổ sung sự cố đang chờ" đã có sẵn; KHÔNG tự chọn thay người dùng |
| `ticket_created` | Đã tạo ticket | Gửi `voiceText` kèm mã `issue.identifier`; nếu có tờ khai khác của CHÍNH chat này bị gác lại lúc trước (chọn "Sự cố mới"), `voiceText` sẽ kèm câu nhắc + nút "Tiếp tục sự cố đang chờ" — gửi y nguyên, KHÔNG tự bấm thay người dùng |
| `already_created` | Ticket đã có từ trước (bấm lại nút, cảm ơn…) | Gửi `voiceText`, KHÔNG tạo lại |
| `post_create_update` | Đã ghi bổ sung / sửa vào ticket (người báo đã xác nhận) | Gửi `voiceText` |
| `confirm_ticket_action` | Bản xem trước ghi vào ticket ĐÃ CÓ (bổ sung, sửa, chuyển ticket vừa tạo nhầm) | Gửi `voiceText`; nút xác nhận / "Huỷ" / "Sự cố mới" đã có sẵn; KHÔNG tự bấm thay người dùng |
| `lookup_result` | Kết quả tra cứu ticket theo mã | Gửi `voiceText` |
| `create_failed` | Hệ thống ghi ticket lỗi, tờ khai vẫn giữ | Gửi `voiceText`; người dùng bấm xác nhận lại là thử lại |
| `canceled` / `clarify_intent` / `in_progress` | Đã huỷ / chưa rõ sự cố / đang tạo | Gửi `voiceText`; `canceled` cũng có thể kèm nút "Tiếp tục sự cố đang chờ" như trên |

## Không làm

- **Không gọi `create_issue`** cho sự cố đi qua `intake_step`, kể cả sau `ticket_created` — ra ticket trùng. `create_issue` chỉ là dự phòng khi `intake_step` báo lỗi.
- Không tự thêm câu mời xác nhận, không liệt kê lại lựa chọn đã có trên nút.
- Không tự bịa bộ phận, hệ thống, SĐT, mã khách hàng. Người dùng nói "không biết" thì gửi đúng câu đó vào `intake_step` — tool tự thôi hỏi.
- Không tự ghi vào ticket cũ bằng đường nào khác ngoài `intake_step` — mọi lần ghi phải qua nút xác nhận của người báo (ADR-0008).

## Tra cứu phụ

`get_intake_doc` / `get_similar_tickets` để xem chi tiết tờ khai hoặc ticket tương tự khi cần giải thích — không thay thế `intake_step`.

## When NOT to Use

- Hỏi tiến độ ticket cũ KHÔNG nêu mã → skill `check-status` (có mã thì vẫn `intake_step`).
- Giục gấp (kèm hay không kèm mã ticket) → vẫn `intake_step`: bot hiện bản xem trước + nút, bấm xác nhận mới ghi và nâng mức khi có lý do. Không có tool nào tự nâng mức.
- Ý tưởng / yêu cầu tính năng sản phẩm → bot IRIS.
