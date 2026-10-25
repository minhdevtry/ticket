# Tiểu Linh mới (`@vuihoc/tieulinh`): hậu cần

Nửa **hậu cần** (back office) của Tiểu Linh, viết lại bằng bot kit (`defineBot`/`createBot` của `@vuihoc/bot-core`). Nó thay phần worker của [`apps/tieulinh-legacy`](../tieulinh-legacy) và là ví dụ mẫu cho một bot thật: file ở đây chỉ chứa nghiệp vụ và khai báo, thứ gì dùng chung được đã nằm ở `packages/core`. Nửa **lễ tân** (nhận sự cố qua chat, tạo ticket, huỷ/đóng ticket theo yêu cầu người báo) chưa làm; thiết kế ở [RFC 0002](../../docs/rfc/0002-receptionist.md).

Tiểu Linh 2 (TL2) chạy trên dự án `tech.TECH2` với agent `tieulinh2`. Đổi sang `tech.TECH` là đổi `TIEULINH_PROJECT` (và `TIEULINH_TEAM` nếu cần); đổi tên agent là đổi `TIEULINH_AGENT` **và** dùng key của agent mới (`ITSAPLAN_AGENT_KEY`): hai thứ phải khớp nhau, nên không phải mọi thay đổi chỉ là một biến. Tài liệu đầy đủ (tiếng Việt): [Tiểu Linh mới: hậu cần](../../docs/explanation/tieulinh-hau-can.md), [Chạy Tiểu Linh 2](../../docs/how-to/run-tieulinh-hau-can.md), [biến môi trường](../../docs/reference/config-env.md).

## Bot làm gì

| Sự kiện | Handler | Hành vi |
|---|---|---|
| Ai đó `@tieulinh2` trên ticket | `mention.ts` | Chuyển lời nhắn về người báo qua kênh (đường duy nhất cho comment có gắn thẻ agent); LLM (chỉ đọc: `get_issue`, `get_comments`, `search_issues`) trả lời trên ticket, đúng luồng comment. **Câu trả lời của LLM là tính năng MỚI so với legacy** (legacy chỉ chuyển lời, không trả lời). |
| `issue.state_changed` | `closure` (core `TicketClosure`) | Sang Resolved: báo người báo kèm nút "Đã ổn". Sang Done/Canceled/mở lại: báo và gỡ nút cũ. Hậu cần **không chuyển cột nào** (xem ADR-0006 bên dưới). |
| `comment.created` | `forward.ts` | Comment của người xử lý tới người báo (`all` hoặc `mention`; bỏ `#noibo`, bỏ comment của bot, bỏ comment gắn thẻ agent vì đã đi đường `mention`). Ảnh, video, `attachments`, link ảnh nội bộ và HTML entities xử lý ở dispatcher của core như legacy. |
| `comment.created` nhắc mã ticket anh em | `duplicates.ts` | LLM phán có phải tuyên bố trùng không; mặc định để một comment gợi ý. `TIEULINH_DUPLICATE_MERGE=true` bật gộp kiểu legacy, nhưng chỉ khi comment là của người xử lý được giao ticket (comment của người khác chỉ ra gợi ý; comment của bot/admin/onyx bị bỏ qua). |
| Cron `TIEULINH_SLA_CRON` | `sla.ts` | Ticket chưa giao, chưa bắt đầu, quá hạn theo ưu tiên (1/2/4/24 giờ) thì báo trực ca (kèm link nếu có `ITSAPLAN_WEB_URL`), mỗi ticket một lần và CHỈ khi kênh đã giao được. |
| Người báo bấm "👍 Đã ổn" / trả lời tự do vào tin thông báo | `inbound` (core `createReporterInbound`) | Chỉ ghi MỘT comment cho người xử lý (ADR-0006), không đổi cột; trả lời khi ticket đã hoàn tất/huỷ thì bot từ chối và hướng dẫn tạo ticket mới. Xem "Tin vào của người báo". |

Kênh gửi tin: có `TELEGRAM_BOT_TOKEN` thì Telegram thật (khi đó bắt buộc `TIEULINH_ONCALL_CHAT_ID`), không có thì nhật ký JSONL `BOT_DATA_DIR/tieulinh-channel.jsonl` (mode 0600). TL2 chạy chỉ với kênh nhật ký.

## Tin vào của người báo

Nút "Đã ổn" có đường nhận thật. Bot kit mở một server webhook (`BOT_WEBHOOK_PORT`) và `inbound` của app gắn vào đó:

| Đường | Ai gọi | Ghi chú |
|---|---|---|
| `POST /internal/reporter-ok` `{ issueId, chatId, userName }` | plugin Telegram cùng máy (polling), như legacy | chỉ loopback |
| `POST /internal/reporter-reply` `{ chatId, replyToMessageId, text, senderName }` | cùng plugin, khi người báo trả lời vào một tin | chỉ loopback |
| `POST /telegram-webhook` | chính Telegram (`setWebhook`), `callback_query` và `reply_to_message` | cần `TELEGRAM_WEBHOOK_SECRET` khi nghe ngoài loopback |

Cả ba chỉ ghi comment (kèm escape, chống ghi đôi khi Telegram giao lại) và trả `replyText` để plugin/bot nói lại. Cần cổng webhook: nếu không đặt `BOT_WEBHOOK_PORT` thì nút sẽ không có ai nghe.

**Mức sẵn sàng của chế độ Telegram.** Đường vào, gửi tin, gỡ nút và nói lại được kiểm bằng test với Telegram giả (`inbound.test.ts`), nhưng CHƯA chạy với bot Telegram thật. Hạn chế đã biết: chưa gửi media thật qua Telegram (ảnh/video nối vào văn bản dạng link), chưa có `(cc @người xử lý)` trong comment phản hồi như legacy. TL2 vẫn chạy bằng kênh nhật ký; coi Telegram là chưa sẵn sàng cho production cho tới khi có lần chạy thử thật.

## Chạy

```bash
export ITSAPLAN_BASE_URL=https://itsaplan.example.com ITSAPLAN_AGENT_KEY=...   # key của agent tieulinh2
export BOT_DATA_DIR=/var/lib/tieulinh2
export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=...                          # MiniMax qua proxy
export BOT_WEBHOOK_PORT=3110 ITSAPLAN_WEBHOOK_SECRET=whsec_...                 # luật chạy trên webhook
bun run apps/tieulinh/main.ts
```

Chạy thử trên Colab không để secret ở đó (proxy trên dev, webhook qua relay): `deploy/colab/cup-tieulinh.sh`, xem [Chạy bóng Tiểu Linh 2](../../docs/how-to/shadow-tl2.md#chay-app-hau-can-tren-colab).

Test không cần mạng: `bun run --cwd apps/tieulinh test` (itsaplan giả, LLM giả, đồng hồ giả).

## Cấu trúc

| File | Vai trò |
|---|---|
| `bot.ts` | `tieulinhBot(env)`: khai báo `defineBot` (tracker, agent, handler, luật, lịch, `reporter`, `inbound`). |
| `env.ts` | Env riêng của app (`defineEnv`) và kiểm chéo (`TELEGRAM_BOT_TOKEN` cần `TIEULINH_ONCALL_CHAT_ID`). |
| `services.ts` | Kho SQLite của app (`tieulinh-app.sqlite`: liên kết, tuyến tin, trạng thái, mốc SLA), chọn kênh, `TicketClosure`, dispatcher. Dấu "đã làm" nằm ở `ctx.keys` của kit. |
| `mention.ts`, `forward.ts`, `duplicates.ts`, `sla.ts`, `reporter.ts` | Từng nghiệp vụ. |
| `copy.ts` | Mọi câu tiếng Việt gửi người báo. Logic không chứa chuỗi hiển thị. |
| `*.test.ts`, `testkit.ts` | Kịch bản với `FakeItsaplan` + `FakeLlm`; `inbound.test.ts` đi qua server webhook thật; `gap-register.test.ts` là SỔ đối chiếu test legacy của hậu cần và `receptionist-gap-register.test.ts` là sổ của lễ tân (chỉ giữ sổ khỏi nói dối, hành vi được kiểm ở test mà từng dòng trỏ tới). |

## Quyết định bám theo (ADR của Tiểu Linh)

- **0001** một worker một dự án: tracker khoá theo `tech.TECH2`, sự kiện dự án khác bị bỏ.
- **0006** (bản 10/10) bot không bao giờ tự đóng ticket: không hẹn giờ đóng; nút "Đã ổn" chỉ ghi một comment. Bản 10/10 còn một nửa: khi **chính người báo** yêu cầu huỷ hoặc đóng ticket của mình và tự bấm xác nhận thì bot chuyển cột (Canceled/Done). Nửa đó là việc của **lễ tân**, chưa có ở đây và sẽ vào ở PR 12 của [RFC 0002](../../docs/rfc/0002-receptionist.md); hậu cần hôm nay không đổi cột. (Gộp ticket trùng là ngoại lệ có cờ, mặc định TẮT, vì nó huỷ ticket.)
- **0007** ticket tương tự chỉ học từ người: "liên quan" ở đây là kết quả tìm văn bản dùng để gợi ý, không phải kết luận.
- **0008** thao tác ghi từ chat cần xác nhận: bot không tạo/sửa ticket từ chat (lễ tân chưa làm).
- **0010** mô tả ticket là nguyên văn người báo: bot không sửa mô tả; khi gộp, mô tả được chép nguyên văn.

## Lệch so với legacy (cố ý)

- **Phát hiện trùng theo comment, không theo lúc tạo ticket**: giữ đúng tín hiệu của legacy (người xử lý nhắc mã ticket anh em). Dò lúc tạo cần truy hồi ticket liên quan (KG/Onyx), nằm ngoài phạm vi. LLM phải trả `evidence` là đoạn trích có thật trong comment, không thì coi như không trùng.
- **SLA quét không trạng thái**, không còn bảng `sla_trackers`; chỉ tính ticket tạo sau lần đầu app khởi tạo (`sla:since`) để lần chạy đầu không xả cảnh báo cho kho ticket cũ. Đọc danh sách theo cột chờ và cửa sổ ngày tạo (itsaplan fork sắp `updatedAt` giảm dần, chỉ có `limit` tối đa 500, không có `page`; cửa sổ đầy thì chia đôi), nên không có trần 300 ticket. Khác legacy: chỉ đánh dấu "đã nhắc" khi kênh đã giao.
- **Câu trả lời LLM trên `@mention` là mới**: legacy chỉ chuyển lời nhắn.
- **`backoffice.reporter`** (`reporter.ts`): ticket đã liên kết chat thì người comment trên itsaplan không phải người báo; chưa liên kết thì coi mọi người là người báo (thận trọng). Hiện chưa luật nào dùng (ADR-0006 cấm `closeAfter`), giữ làm điểm cắm.

## Việc để lại (follow-up)

- Chạy thử chế độ Telegram với bot thật (hiện mới kiểm bằng Telegram giả); `(cc @người xử lý)` trong comment phản hồi.
- Lễ tân (`defineBot({ receptionist })`): tạo ticket, ghi liên kết người báo vào kho (hiện chỉ test và chế độ sandbox ghi), và huỷ/đóng ticket theo yêu cầu người báo (ADR-0006, PR 12 của RFC 0002). Thiết kế: [RFC 0002](../../docs/rfc/0002-receptionist.md); sổ đối chiếu test lễ tân legacy: `receptionist-gap-register.test.ts`.
- KG/Onyx/Memgraph (nạp tri thức khi ticket hoàn tất), `related-curator` và ticket tương tự, ingest.
- Gửi media thật qua Telegram (hiện ảnh và video nối vào văn bản dạng link).
- Phát hiện trùng lúc tạo ticket (cần truy hồi liên quan).
