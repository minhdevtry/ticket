# Ngữ cảnh: Tiểu Linh mới (hậu cần)

`apps/tieulinh` là app hậu cần của Tiểu Linh 2, viết bằng bot kit trên dự án `tech.TECH2` với agent `tieulinh2`. Nó sở hữu nghiệp vụ sau khi ticket đã tồn tại và câu chữ tiếng Việt gửi người báo; nó không sở hữu lễ tân (chưa làm) và không tự đổi cột ticket nào.

## Terms

| Term | Meaning | Avoid |
| --- | --- | --- |
| `người báo` | Người gửi tin báo sự cố qua kênh chat; ticket gắn với chat của họ là "ticket của người báo". | khách hàng, người dùng, end user, reporter |
| `người xử lý` | Người (hoặc agent) làm việc trên ticket trong itsaplan; bot gắn thẻ họ khi cần, và chỉ họ giữ quyền chuyển cột. | chuyên viên, kỹ thuật viên, nhân viên, staff |
| `hậu cần` | Vai của bot làm việc SAU khi ticket đã nằm trên itsaplan: trả lời mention, báo khi ticket đổi trạng thái, chuyển comment, nhắc quá hạn, gợi ý ticket trùng. | vận hành, chăm sóc khách hàng, tác vụ nội bộ |
| `lễ tân` | Vai nhận sự cố qua chat, hỏi cho đủ, xác nhận rồi tạo ticket; trong app này chưa làm, thiết kế ở RFC 0002. | reception, tổng đài, intake |
| `vòng đời ticket` | Trạng thái mà bot biết: `open`, `resolved` (đã xử lý), `done` (hoàn tất), `canceled`; bot báo theo nhóm trạng thái, và gỡ nút cũ khi ticket đóng lại. | status, state, trạng thái issue, workflow |
| `nút "Đã ổn"` | Nút trong tin thông báo cho người báo xác nhận ticket đã ổn; cú bấm chỉ ghi MỘT comment, không đổi cột. | nút xác nhận, nút OK, nút hoàn tất |
| `trả lời tự do` | Người báo trả lời thẳng vào tin thông báo; nội dung trở thành một comment trên ticket, không đổi cột, và bị từ chối khi ticket đã hoàn tất hoặc huỷ. | reply thường, comment tự do, tin nhắn |
| `ticket trùng` | Khai báo trùng do người xử lý nhắc mã ticket anh em trong comment; LLM phán, cần `evidence` là trích đoạn thật trong comment, mặc định bot chỉ để một comment gợi ý. | duplicate issue, ticket lặp, phản chiếu |
| `ticket liên quan` | Kết quả tìm văn bản gợi ý "có liên quan"; là gợi ý, không phải kết luận trùng hay cùng nguyên nhân. | similar ticket, ticket tương tự, KG, ticket trùng |
| `quá hạn SLA` | Ticket chưa giao, còn ở cột chưa bắt đầu và quá hạn theo ưu tiên (1/2/4/24 giờ); mỗi ticket chỉ nhắc một lần. | hết hạn, deadline, tuổi ticket |
| `báo trực ca` | Tin cảnh báo gửi tới chat trực ca khi có ticket quá hạn; chỉ được đánh dấu "đã nhắc" khi kênh đã giao được cảnh báo. | cảnh báo, alert, escalation, nhắc hậu |
| `kênh gửi tin` | Đường bot nói với người báo (`ChannelPort`): Telegram thật khi có token, còn lại là kênh nhật ký. Kênh thuộc harness, không thuộc bot. | transport, notifier, notification channel |
| `kênh nhật ký` | Kênh JSONL trong `BOT_DATA_DIR` (file 0600, thư mục 0700) dùng khi chưa gửi tin thật; TL2 chạy ở chế độ này nên tin không ra ngoài. | log channel, file log, chế độ offline |
| `liên kết chat` | Bản ghi nối ticket với chat và người báo; nhờ đó hậu cần biết nhắn ai, và tin của người báo về sau tìm được ticket. | map chat, bảng tra ticket, quan hệ chat |
| `chống ghi trùng` | Khoá bền đánh dấu việc đã làm (theo comment hoặc theo run) để không gửi lại tin hay ghi lại comment. | idempotency, dedupe, chống trùng lặp |
| `sổ đối chiếu` | Bảng test mỗi dòng là một test của bản legacy và trỏ tới test mới có thật; sổ giữ sổ khỏi nói dối, không giữ hành vi. | báo cáo độ phủ, gap analysis, bảng đối chiếu hành vi |
