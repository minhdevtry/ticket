# Ngữ cảnh: Tiểu Linh legacy (bản tham chiếu đóng băng)

`apps/tieulinh-legacy` là bản Tiểu Linh đang chạy thật, đóng băng làm mốc so sánh: hành vi của nó = production và là chân lý cho mọi lần chạy bóng. Nó sở hữu lễ tân đầy đủ trong `pipeline.ts` cùng toàn bộ chữ, catalog và luật ưu tiên riêng; tính năng mới không làm ở đây mà làm ở `apps/tieulinh`.

## Terms

| Term | Meaning | Avoid |
| --- | --- | --- |
| `bản tham chiếu đóng băng` | Bản app được giữ nguyên hành vi để làm chuẩn so sánh; chỉ sửa lỗi nghiêm trọng. | bản cũ, bản production, mốc cũ, code chết |
| `lễ tân` | Hội thoại tiếp nhận của legacy: một lượt hội thoại = một lời gọi `step` trên `IntakeStepPipeline` (3.348 dòng), bọc thành tool MCP `intake_step`. | reception, tổng đài, chatbot, pipeline |
| `tờ khai` | Trạng thái lượt tiếp nhận đang dở (`IntakeDocument`), lưu ở SQLite cục bộ (`intake_documents`); hết hạn sau 24 giờ thì tin mới mở tờ khai mới. | ticket, phiếu, form, intake document (chỉ là tên kiểu trong code) |
| `hợp đồng intake_step` | Hợp đồng tool MCP của legacy: trả `action`, `voiceText`, `buttonsShown`, `agentInstruction`. Persona và skill của OpenClaw phụ thuộc tên `action`, nên hợp đồng này phải giữ nguyên ở mọi harness. | tool API, MCP contract, giao diện tool |
| `phong bì kênh` | Vỏ kênh (OpenClaw) bọc tin đến; phải bỏ khỏi tin trước mọi xử lý, không bao giờ lọt vào ticket. | envelope, wrapper, metadata, định dạng tin |
| `binding` | Bản ghi nối ticket với chat, người báo và tuyến tin nhắn; cơ sở để xác định ticket của chính chat và để hậu cần báo người báo. | liên kết, mapping, quan hệ, cache |
| `định danh` | Mã có nhãn (Code, Mã KH, Mã HS, UID/SID/CID, mã CRM) chỉ tính khi cùng lớp; tên người, số điện thoại, tài khoản, URL, mã phiếu không bao giờ là định danh. | mã KH, ID, mã định danh, khóa |
| `gác tờ khai` | Khi tin mới mang định danh khác tờ khai đang mở, tờ khai cũ được gác lại và bot hỏi "Sự cố mới" hay "Bổ sung"; có nút đưa tờ khai gác trở lại. | park, treo, giữ tờ khai, tạm dừng |
| `tách báo cáo` | Khi một tin chứa nhiều sự cố, bot hỏi "Tách N ticket / Gộp 1 ticket"; chọn tách thì xếp hàng tạo lần lượt, ảnh gắn cho mọi ticket và bật cờ ảnh mơ hồ. | split, tách ticket, tách issue, chia nhỏ |
| `soát thông tin` | Bước hỏi thêm thông tin kỹ thuật: theo danh sách cố định hoặc theo LLM "con mắt kỹ thuật viên", hỏi một lượt, mọi câu trả lời đều đi tiếp. | tech review, checklist, hỏi thêm, duyệt thông tin |
| `mức ưu tiên` | Mức xin gấp của ticket, chốt bằng bằng chứng theo bảng luật (sàn nâng, trần chặn, sàn thắng khi bằng); chữ hiển thị bằng tiếng Việt, không in `MEDIUM`. | priority, mức gấp, P1, mức độ |
| `nút bấm` | Hợp đồng nút `{ text, callbackData }`, `callbackData` tối đa 64 byte UTF-8; nút bị khoá sau khi bấm, thu gọn còn đúng nút đã chọn. | button, callback, inline keyboard, nút xác nhận |
| `token nội bộ` | Token callback nội bộ (`noop`) bị nuốt và trả `answerCallbackQuery`; tin rỗng hoặc tin chỉ chứa token nội bộ không kèm ảnh bị bỏ. | noop, token ẩn, token giả |
| `plugin` | Mảnh harness của legacy: `iris-tuong-tac` (gắn nút, dọn chữ, khoá nút) và `xac-nhan-xong` (nút "Đã ổn", trả lời tự do, `/new`). | extension, add-on, hook, adapter |
| `workspace OpenClaw` | Nơi persona và skill của bot được đồng bộ vào, bằng `openclaw/sync-workspace.ts`; prose dùng chung nằm ở `packages/core/prose/`. | workspace, thư mục skill, prompt folder |
| `bản ghi vàng` | Fixture ghi lại kịch bản vào và ra của lễ tân legacy để bản mới so được từng lượt; dữ liệu tổng hợp, ghi lặp lại cho kết quả giống nhau. | golden file, snapshot, bản ghi test, log hội thoại |
