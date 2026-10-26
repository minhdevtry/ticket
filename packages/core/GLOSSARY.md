# Ngữ cảnh: bot-core

`@vuihoc/bot-core` là thư viện dùng chung cho mọi bot VuiHoc: nó sở hữu thuật ngữ và cơ chế tất định (bot kit, engine tiếp nhận, cổng, kho bền) mà các app chỉ cấu hình và cung cấp dữ liệu. Nó không sở hữu nội dung nghiệp vụ riêng của bot nào (catalog, chữ, luật ưu tiên), không giữ kênh Telegram và không tự chạy vòng agent.

## Terms

| Term | Meaning | Avoid |
| --- | --- | --- |
| `bot` | Một bot VuiHoc là một gói cắm vào harness agent có sẵn: MCP server cộng tool, skill, và các mảnh harness. Không phải tiến trình chạy riêng, không giữ kênh, không tự chạy vòng agent. | bot standalone, tiến trình bot, dịch vụ bot, worker bot |
| `pack` (gói) | Phần bot xuất ra: MCP server và tool, skill (persona, hướng dẫn, tin tĩnh), cùng các mảnh harness (plugin, hook, đồng bộ workspace, mảnh cấu hình). | bundle, plugin bot, gói cài đặt, extension |
| `harness` | Môi trường agent có sẵn mà pack cắm vào; harness sở hữu kênh (Telegram) và vòng agent LLM. OpenClaw là harness dùng hôm nay. | host, runner, adapter (adapter là phần riêng của harness, không phải harness) |
| `lễ tân` (receptionist) | Vai nhận sự cố qua chat: hội thoại tiếp nhận, tóm tắt, xác nhận, tạo ticket. Ở bản mới là pack MCP và skill, không có worker và không có kênh. | concierge, front desk, chatbot, intake bot |
| `hậu cần` (back office) | Vai làm việc trên ticket đã tồn tại: trả lời mention, phản ứng khi ticket đổi cột, chạy lịch, nhắc quá hạn, gợi ý ticket trùng. Trong code là trường `backoffice` của khai báo bot. | trợ lý, admin bot, vận hành, công cụ nội bộ |
| `defineBot` | Hàm khai báo một bot: định danh, `tracker` (team và project), env, rồi đến hai vai `receptionist` và `backoffice`. Thuần: không đọc env, không mạng. | createBot (đó là runtime), bot factory, bot class |
| `createBot` | Hàm dựng runtime hậu cần từ khai báo: worker poll `agent-runs`, webhook, lịch, hẹn giờ, health. Không chạy lễ tân. | defineBot, runBot, startBot |
| `run` | Một việc itsaplan giao cho agent native: bot claim run, giữ lease bằng heartbeat, chạy handler theo trigger, báo kết quả. | task, job, message, lượt chạy |
| `tracker` | Client itsaplan đã khoá vào đúng một dự án; mọi lời gọi đi bằng ref đủ `<team>.<KEY>`, ghi ra ngoài dự án thì ném `OutOfProjectError`. | itsaplan client, api client, issue client, project key |
| `rule` | Quy tắc hậu cần theo mẫu sự kiện → điều kiện → hành động, chạy trên webhook; hành động dựng sẵn nằm trong namespace `actions`. | workflow, automation, hook, điều kiện |
| `cổng` (port) | Interface do thư viện định nghĩa còn app tiêm bản cài đặt: tracker, kênh, đồng hồ, kho lưu, chuỗi hiển thị. Tác dụng ra ngoài của lễ tân chỉ đi qua cổng. | adapter, connector, interface, DI container |
| `catalog` (`FieldCatalog`) | Dữ liệu mô tả trường cần hỏi: nhánh, trường bắt buộc hoặc nên hỏi, câu hỏi, enum, nhãn nút. "Đủ chưa, hỏi gì tiếp" là logic tất định theo catalog, không phải model tự quyết. | form, schema, danh mục sản phẩm, validation rules |
| `tờ khai` (draft) | Trạng thái bền của một lượt tiếp nhận đang dở, lưu ở SQLite cục bộ; nó là cache, không phải nguồn sự thật. | ticket (khi chưa tạo), phiếu, form data, intake document |
| `binding` | Bản ghi nối ticket với chat, người báo và tuyến tin nhắn; nhờ đó hậu cần biết nhắn ai, và lễ tân tra cứu được ticket của chính chat. | liên kết, mapping, cache, quan hệ |
| `bản ghi vàng` (golden record) | Fixture JSON ghi lại kịch bản vào và ra (tin, action, chữ, nút) của engine; test phát lại đầu vào và so đầu ra để so máy-với-máy, không import code của bản cũ. | snapshot test, regression fixture, kỳ vọng, expected output |
| `CopyCatalog` | Tập chuỗi hiển thị của bot, tra theo khoá (`CopyKey`); thư viện không chứa tiếng Việt trong logic, chữ do app cung cấp. | copy, chuỗi, template tin nhắn, i18n |
