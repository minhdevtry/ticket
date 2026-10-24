# LỘ TRÌNH PHÁT TRIỂN TIẾP THEO (ROADMAP)

Tài liệu này ghi lại kiến trúc và thiết kế cho 2 giai đoạn tiếp theo của hệ sinh thái Agent tại VUIHOC:
1. **Giai đoạn 2: Tự động hóa đánh giá chất lượng hội thoại Intake (Prompt & Tool-Call Evals)**
2. **Giai đoạn 3: Hệ thống Execution Agent xử lý ticket phía sau Itsaplan (OpenClaw / MCP Execution)**

---

## 1. Giai đoạn 2: Đánh giá chất lượng Intake (Intake Evals)

### Bối cảnh & Mục tiêu
Khi số lượng bot intake tăng lên (Tiểu Linh, HR, CSKH, Finance...), việc đảm bảo từng bot phỏng vấn đúng taxonomy, trích xuất đủ trường, không hallucinate và không vi phạm bản sắc trở thành bài toán sống còn.
Xây dựng pipeline CI/CD đánh giá tự động dựa trên tập dữ liệu mẫu (Golden Conversation Datasets) độc lập framework:

### Các Scorers / Evals cần triển khai
1. **`taxonomyCompletenessScorer` (Độ đầy đủ trường)**:
   - **Mục tiêu**: Đo lường xem bot có dừng phỏng vấn khi chưa đủ các trường `bat_buoc` hay không.
   - **Cách thức**: Đối chiếu giữa dữ liệu truyền vào tool `create_issue` với danh sách trường `bat_buoc` trong catalog.
   - **Điểm số**: Tỷ lệ `[Số trường bắt buộc đã thu thập / Tổng số trường bắt buộc]`.

2. **`toolCallAppropriatenessScorer` (Tính chuẩn xác khi gọi Tool)**:
   - **Mục tiêu**: Kiểm tra bot có gọi đúng tool ở từng giai đoạn:
     - Đang hỏi thông tin: chỉ gọi `check_required_fields` hoặc `validate_fields`, không gọi `create_issue` sớm.
     - Sau khi người dùng xác nhận: bắt buộc gọi `create_issue`.
     - Tra cứu tiến độ: gọi `get_issue` hoặc tra cứu qua MCP tracker.

3. **`personaComplianceScorer` (Tuân thủ bản sắc & Giới hạn)**:
   - **Mục tiêu**: Kiểm tra các quy tắc cấm:
     - Không nghĩ thành tiếng trước tool call.
     - Không để lộ tên trường nội bộ của database.
     - Độ dài câu trả lời tuân thủ quy định của từng bot (ví dụ: Tiểu Linh $\le 4$ dòng).

---

## 2. Giai đoạn 3: Execution Agent phía sau Itsaplan (MCP + General-purpose Agent)

### Bối cảnh & Phân tầng hệ thống
```
                     [ Người dùng Telegram ]
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │     INTAKE AGENT (OpenClaw + MCP Stdio)      │
         │  - Nhẹ, phản hồi ngay lập tức, ít tốn RAM    │
         │  - Xác định thông tin theo bảng tiêu chuẩn   │
         │  - Tạo ticket chuẩn trên Itsaplan            │
         └──────────────────────┬───────────────────────┘
                                │ Webhook
                                ▼
         ┌──────────────────────────────────────────────┐
         │            ITSAPLAN TRACKER                  │
         │  - Issue ID, Project, Labels, Description    │
         └──────────────────────┬───────────────────────┘
                                │ Event: issue.created / state_changed
                                ▼
         ┌──────────────────────────────────────────────┐
         │     EXECUTION AGENT (Back Office)            │
         │  - Powered by Claude / GPT                   │
         │  - Kết nối công cụ qua MCP chuẩn             │
         │  - File system, Terminal, Git, DB            │
         └──────────────────────────────────────────────┘
```

### Thiết kế Execution Agent qua chuẩn MCP
1. **Kết nối MCP Server**:
   Execution Agent sử dụng client MCP chuẩn để kết nối tới các MCP Server chuyên trách:
   - **MCP Filesystem**: Đọc mã nguồn repo cần sửa lỗi.
   - **MCP Terminal / Bash**: Chạy test runner, build check trong sandbox cách ly.
   - **MCP Git / GitHub**: Tạo branch, commit, push và mở Pull Request.
   - **MCP Itsaplan**: Đọc chi tiết issue, cập nhật tiến độ, đăng comment trao đổi.

2. **Cơ chế kích hoạt (Triggering)**:
   - `ItsaplanWebhookServer` (trong `apps/tieulinh/worker/`) nhận event `issue.created` hoặc label `bot-execute` gắn vào ticket.
   - Dispatcher chuyển ticket description đã được Intake Agent chuẩn hóa vào prompt khởi động của Execution Agent.
   - Execution Agent chạy độc lập trong process nền hoặc job queue, hoàn toàn không ảnh hưởng tới latency hay bộ nhớ của Intake Agent.
