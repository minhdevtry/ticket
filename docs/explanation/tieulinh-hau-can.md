# Tiểu Linh mới: hậu cần

`apps/tieulinh` là bản viết lại nửa **hậu cần** của Tiểu Linh trên bot kit ([Bot kit](/explanation/bot-kit)). Bản legacy (`apps/tieulinh-legacy`) vẫn là mốc tham chiếu đóng băng ([Bản legacy và bản mới](/explanation/tieulinh-legacy)); trang này giải thích hành vi nào được mang sang, hành vi nào đổi và vì sao. Cách chạy: [Chạy Tiểu Linh 2 (hậu cần) với TECH2](/how-to/run-tieulinh-hau-can).

## Phạm vi

Hậu cần là mọi việc xảy ra SAU khi ticket đã nằm trên itsaplan: trả lời khi người xử lý gọi bot, báo người báo khi ticket đổi trạng thái hay có comment mới, nhắc quá hạn, phát hiện ticket trùng. Lễ tân (nhận sự cố qua chat, hỏi thêm, tạo ticket) chưa làm: hậu cần tự chạy được vì nó chỉ cần biết "ticket này gắn với chat nào", thông tin mà lễ tân sẽ ghi vào kho liên kết.

Bot khai báo trên `tech.TECH2` (đổi bằng `TIEULINH_TEAM`/`TIEULINH_PROJECT`, chạy thật là `tech.TECH`), agent `tieulinh2` (tên đọc từ `TIEULINH_AGENT`; đổi agent phải đổi cả `ITSAPLAN_AGENT_KEY` sang key của chính agent đó, nên không chỉ là một biến), LLM qua `ctx.llm` (MiniMax qua cấu hình `LLM_*`), kho bền trong `BOT_DATA_DIR`.

## Bảng hành vi: legacy sang mới

| Hành vi | Legacy | Mới | ADR |
|---|---|---|---|
| Khoá dự án | `ITSAPLAN_PROJECT_KEY`, lọc ở nhiều chỗ | `tracker` của `defineBot`; engine lọc theo `projectId` | 0001 |
| @mention | `AgentRunnerService` + agent OpenClaw, chỉ chuyển lời | `on.mention`: chuyển lời như legacy **và** (MỚI) LLM `runAgentLoop` với ba tool chỉ đọc trả lời đúng luồng comment | 0006 |
| Chuyển mention về người báo | forward Telegram, dedupe theo nội dung 60 giây | chuyển qua `ChannelPort`; khoá bền (`ctx.keys`) theo comment (luật) hoặc theo run (mention); luật bỏ comment gắn thẻ agent nên người báo chỉ nhận một tin | |
| Comment tới người báo | `NotificationDispatcher` | cùng dispatcher của core; chính sách `all\|mention`, `#noibo`, chống echo; ảnh/video/`attachments`, link nội bộ viết lại, HTML entities như legacy | |
| Resolved | báo + nút "Đã ổn" | `TicketClosure` của core: báo + nút, không đổi cột | 0006 |
| Người báo bấm "Đã ổn" | ghi comment | `inbound` -> `TicketClosure.recordReporterOk`: ghi đúng một comment, không đóng ticket | 0006 |
| Người báo trả lời tự do vào tin thông báo | ghi comment (`recordReporterReply`) | cùng đường `inbound`; ghi một comment, từ chối khi ticket đã hoàn tất/huỷ | 0006 |
| Done / mở lại | báo, gỡ nút cũ | như nhau | 0006 |
| Người báo nhắn chat yêu cầu huỷ hoặc đóng ticket của mình | xem trước + nút xác nhận, bấm xong bot chuyển cột Canceled/Done | **chưa làm**: là việc của lễ tân, thuộc PR 12 của [RFC 0002](/rfc/0002-receptionist) | 0006, 0008 |
| Quá hạn SLA | bảng `sla_trackers`, quét theo chu kỳ | cron `backoffice.schedule`, quét không trạng thái, chỉ đánh dấu khi đã giao được | |
| Ticket trùng | LLM phán khi người xử lý nhắc mã ticket anh em, gộp tự động | cùng tín hiệu; mặc định chỉ gợi ý; gộp kiểu legacy sau cờ, mặc định tắt, và chỉ khi comment là của người xử lý được giao | 0006, 0010 |
| Mô tả ticket | nguyên văn người báo | bot không bao giờ sửa mô tả | 0010 |
| Nạp tri thức KG/Onyx, `related-curator`, ingest | có | chưa làm | 0007 |

## Quyết định đáng nói

**Bot không bao giờ tự đóng ticket; hậu cần không đổi cột nào.** ADR-0006 (bản 10/10) có hai nửa, và trang này từng chỉ ghi nửa đầu:

1. Bot không tự quyết đóng hay huỷ. Người xử lý giữ quyền chuyển cột; "người báo bấm Đã ổn" chỉ để lại một comment cho người xử lý tham khảo; không có hẹn giờ đóng, và luật dùng `closeAfter` bị cấm trong app này. `backoffice.reporter` vẫn được khai (ticket đã liên kết chat thì người comment trên itsaplan không phải người báo; chưa liên kết thì coi mọi người là người báo, thận trọng) làm điểm cắm cho luật sau này, nhưng hiện chưa luật nào dùng nó.
2. Khi **chính người báo** nhắn yêu cầu huỷ hoặc đóng ticket của mình và tự bấm xác nhận (nút "Hủy ..." hoặc "Đóng ..." kèm "Giữ lại"), bot **chuyển cột** giúp họ: Canceled nếu chưa có chuyên viên xử lý, Done nếu đã có. Người báo là người quyết định; bot không bao giờ làm việc này vì tự thấy ticket nên đóng.

Nửa 2 là việc của **lễ tân** (nó đi qua hội thoại chat và bước xem trước, theo ADR-0008), và lễ tân chưa có trong Tiểu Linh 2. Nó sẽ vào ở PR 12 của [RFC 0002](/rfc/0002-receptionist) (quyết định của chủ, mục 8). Vì vậy hôm nay, ở Tiểu Linh 2 (chỉ hậu cần), không có đường nào làm bot đổi cột, và bản legacy (`apps/tieulinh-legacy`) vẫn là nơi duy nhất đang làm nửa 2.

**Phát hiện trùng đi theo comment của người.** Brief ban đầu nghĩ tới phát hiện lúc tạo ticket. Legacy không làm vậy: tín hiệu là người xử lý nhắc mã ticket anh em trong một comment, rồi LLM xác nhận comment đó tuyên bố trùng chứ không chỉ tham chiếu. Bản mới giữ nguyên tín hiệu (dò lúc tạo ticket cần truy hồi ticket liên quan, tức KG/Onyx, đang ngoài phạm vi) và thêm một chốt: `evidence` LLM trả về phải là đoạn trích thật từ comment, không thì coi như không trùng. Mặc định bot chỉ để một comment gợi ý. Cờ `TIEULINH_DUPLICATE_MERGE=true` bật hành vi legacy (chép mô tả nguyên văn sang ticket đích, nối link, huỷ ticket trùng) vì nó là việc duy nhất bot tự huỷ ticket.

**Ticket liên quan chỉ là gợi ý.** ADR-0007: tri thức "ticket tương tự" chỉ học từ người xử lý. Tool `search_issues` của mention là tìm văn bản; system prompt dặn model không khẳng định trùng hay cùng nguyên nhân.

**Ghi từ chat cần xác nhận.** ADR-0008 áp cho lễ tân. Hậu cần chỉ ghi comment của bot (gắn dấu bot, chống trùng bằng khoá) và, sau cờ, thao tác gộp.

**SLA không còn bảng theo dõi.** Mỗi nhịp cron đọc ticket của dự án và chọn ticket chưa giao, còn ở cột chưa bắt đầu, tạo sau `sla:since` (mốc ghi một lần lúc app khởi tạo) và đã quá hạn theo ưu tiên (urgent 1h, high 2h, medium 4h, low 24h, không rõ là medium). Mỗi ticket nhắc một lần, và chỉ được đánh dấu khi kênh đã giao cảnh báo (kênh ném lỗi hay chưa có chat trực ca thì nhịp sau thử lại; có `TELEGRAM_BOT_TOKEN` thì bắt buộc có chat trực ca). Danh sách ticket đọc theo từng cột chờ và cửa sổ ngày tạo, vì itsaplan sắp theo `updatedAt` giảm dần và chỉ có `limit` tối đa 500 chứ không có `page`: cửa sổ nào đầy thì chia đôi, nên không có trần số ticket. Không có bảng cần đồng bộ nên ticket đổi ưu tiên hay được giao giữa chừng tự đúng; đổi lại ticket tạo trước mốc bắt đầu theo dõi không bao giờ bị nhắc.

## Kênh gửi tin và chế độ bóng

**Tin vào.** Nút "Đã ổn" và trả lời tự do của người báo vào bot qua `backoffice.inbound` của kit (cùng server webhook với luật): `POST /internal/reporter-ok` và `/internal/reporter-reply` (chỉ loopback, cho plugin Telegram cùng máy như legacy) và `POST /telegram-webhook` (Telegram gọi thẳng, kiểm `TELEGRAM_WEBHOOK_SECRET`). Cả ba chỉ ghi comment. Chế độ Telegram được kiểm bằng Telegram giả, chưa chạy với bot thật, nên chưa coi là sẵn sàng cho production.

Nghiệp vụ nói chuyện với người báo qua `ChannelPort`, có hai hiện thực: Telegram thật (`TelegramNotifyChannel`, chỉ bật khi có `TELEGRAM_BOT_TOKEN`) và nhật ký JSONL (`LogChannel`, mode 0600). TL2 chạy với nhật ký: mọi thứ bot sẽ nói với người báo nằm trong `BOT_DATA_DIR/tieulinh-channel.jsonl` để người soát, không tin nào ra ngoài. Ticket tạo thẳng trên itsaplan không có liên kết chat nên mặc định bị bỏ qua; đặt `TIEULINH_SANDBOX_CHAT` để gắn chúng vào một chat thử và nhìn được đầu ra.

## Thành phần dùng chung đã vào core

Những gì không riêng Tiểu Linh được đưa vào `packages/core` (xem `packages/core/CHANGELOG.md`): `TicketClosure` và `TicketStateStore`, `LogChannel`, `ChannelPort.sendAlert`, `RuleContext.llm`, `openPrivateDb`, phần mở rộng của `FakeItsaplan`, `ctx.keys` (khoá chống trùng bền), `ScopedTracker.link`, `backoffice.inbound` và `createReporterInbound`, bộ lọc của `listIssues`, phần chuyển media/entities của dispatcher. App chỉ còn nghiệp vụ và khai báo.

## Việc để lại

Chạy thử chế độ Telegram với bot thật, lễ tân (kể cả việc huỷ/đóng ticket theo yêu cầu người báo, PR 12 của RFC 0002), nạp tri thức KG/Onyx/Memgraph, `related-curator`, ingest, gửi media thật, phát hiện trùng lúc tạo ticket. Danh sách đầy đủ ở `apps/tieulinh/README.md`.
