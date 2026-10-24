# Kiến trúc: lễ tân và hậu cần

Một ticket nội bộ có hai đầu. Ở đầu này là người báo, ngồi trong một kênh chat và không muốn học cách dùng tracker. Ở đầu kia là người (hoặc agent) xử lý, ngồi trong itsaplan. Bot đứng ở cả hai đầu, với hai vai khác nhau:

```
 Người báo            Bot                              itsaplan                 Người / agent xử lý
 ─────────        ┌───────────┐                      ┌──────────────┐          ┌──────────────────┐
 kênh chat  ───►  │  LỄ TÂN   │  tạo ticket    ───►  │   ticket     │  ─────►  │     HẬU CẦN      │
            ◄───  │ (intake)  │  ◄─── báo ngược ───  │ (sự thật)    │  trigger │ (agent ngoài,    │
                  └───────────┘      webhook         └──────────────┘          │  rule)           │
                                                                                └──────────────────┘
```

itsaplan nằm giữa và là **nguồn sự thật**. Hai vai không gọi nhau trực tiếp: lễ tân ghi ticket vào itsaplan, hậu cần đọc ticket từ itsaplan. Nhờ vậy mỗi vai thay được độc lập, và mất file SQLite cục bộ không làm mất dữ liệu (xem ADR-0003 của core trong [chỉ mục ADR](/explanation/adr-index)).

## Lễ tân (receptionist)

Vai tiếp nhận: **kênh chat → hội thoại tiếp nhận → xác nhận → tạo ticket itsaplan**, rồi theo ticket tới lúc đóng.

1. **Hội thoại tiếp nhận.** Bot hỏi người báo các trường còn thiếu theo một *catalog* (trường nào bắt buộc, trường nào nên hỏi, hỏi mấy lần thì thôi). Việc "đủ chưa, hỏi gì tiếp" là logic tất định (`evaluateGate`), không phải model tự quyết. Model chỉ diễn đạt câu hỏi và đọc ra các trường từ lời người báo. Xem [Viết catalog tiếp nhận](/how-to/write-catalog).
2. **Xác nhận.** Bot tóm tắt tờ khai và chỉ tạo ticket sau khi **người báo** bấm xác nhận. Bot không bao giờ tự xác nhận thay người báo; có chặn thời gian tối thiểu để model không tự "bấm" ngay trong lượt tóm tắt.
3. **Tạo ticket.** Idempotent: xác nhận lặp lại cho đúng một ticket. Mức ưu tiên suy từ bằng chứng theo bảng luật (sàn và trần), không do bot hay người báo tự đặt.
4. **Báo ngược.** Có comment hoặc đổi trạng thái trên itsaplan thì webhook bắn về worker, worker đẩy về đúng chat. Người báo trả lời vào tin thông báo thì nội dung thành comment trên ticket. Xem [Dựng worker báo ngược](/how-to/notify-worker).

Bot không tự đóng ticket. Người xử lý chuyển ticket sang "đã xử lý"; lúc đó người báo nhận nút "Đã ổn", cú bấm chỉ ghi một comment, không đổi trạng thái. Chỉ người xử lý chuyển sang "hoàn tất".

Trong code, vai này là các tầng `intake`, `worker`, `telegram`, `itsaplan`, `identity` của [`@vuihoc/bot-core`](/reference/entry-points). Tiểu Linh (`apps/tieulinh`) là lễ tân đầu tiên và đang chạy thật.

## Hậu cần (back office)

Vai xử lý ticket **sau khi nó đã tồn tại**. Hậu cần dùng *agent ngoài* gốc của itsaplan (itsaplan-native external agents): agent là một thực thể đăng ký trong itsaplan, itsaplan quyết định lúc nào có việc cho nó, agent nhận việc, làm, rồi báo kết quả. Bot không phải dựng một hệ thống điều phối riêng.

Phần này đã có cài đặt trong bot kit (milestone 1): [Bot kit: defineBot và createBot](/explanation/bot-kit) giải thích cách dùng, [giao thức agent-runs](/reference/agent-runs) mô tả hàng đợi bên dưới, còn [RFC 0001](/rfc/0001-bot-kit) ghi các lựa chọn thiết kế và phần để lại cho milestone 2.

### Trigger

Một việc cho agent (một *run*) được kích hoạt bởi một trong bảy loại trigger:

| Trigger | Ý nghĩa |
|---|---|
| `mention` | Ai đó nhắc (tag) agent trong comment |
| `delegation` | Ticket được giao cho agent |
| `field` | Một trường của ticket đổi giá trị |
| `schedule` | Theo lịch cron tạo trên itsaplan |
| `manual` | Người bấm chạy tay |
| `status` | Ticket vào một cột mà lịch theo dõi trạng thái đang canh |
| `event` | Một sự kiện khác của itsaplan |

Trong bot kit, mỗi loại là một handler trong `backoffice.on`; loại chưa có handler riêng rơi vào `fallback`.

### Rule: sự kiện → điều kiện → hành động

Ngoài run, hành vi hậu cần còn khai báo được bằng rule theo mẫu **sự kiện → điều kiện → hành động**: khi có sự kiện webhook này, nếu điều kiện đúng, thì làm hành động kia (`comment`, `moveTo`, `assign`, `setPriority`). Giống nguyên tắc ở lễ tân, điều gì cần tất định (điều kiện, chuyển trạng thái) nằm ở rule và code, model chỉ lo phần cần phán đoán.

### Vòng đời ticket

Rule và agent vận hành trên vòng đời ticket của itsaplan. Các trạng thái mà bot hiện biết (`TicketLifecycleState` trong code): `open`, `resolved` (đã xử lý), `done` (hoàn tất), `canceled`. Quy tắc đã chốt ở phía lễ tân vẫn giữ: chỉ người xử lý đóng ticket; một hành động hậu cần đổi trạng thái là hành động thật nên phải theo cùng kỷ luật xác nhận của hệ thống.

### Hiện đã có gì

Bot kit gom vòng đời của một worker hậu cần: xin việc (`POST /agent-runs/claim`), giữ lease bằng heartbeat, ghi vết, báo kết quả (`/agent-runs/<id>/result`), thử lại khi lỗi tạm thời, dừng êm, health. Tracker của bot bị khoá vào đúng một dự án nên một handler lỗi không ghi nhầm sang dự án khác. Worker của Tiểu Linh (`AgentRunnerService`) là bản viết tay có trước, chưa chuyển sang bot kit. Chưa có: lịch cron do bot giữ, hẹn giờ bền (`closeAfter`), đăng ký webhook tự động từ rule.

## `defineBot`: một khai báo cho cả hai vai

`defineBot({...})` là chỗ một bot khai báo định danh, dự án (`tracker: { team, project }`), cấu hình env, và các vai: hậu cần (`backoffice`) chạy được từ milestone 1, lễ tân (`receptionist`) mới được kiểm tra hình dạng và sẽ chạy ở milestone 2. Thay vì ghép tay từng port như các bot cũ, người viết chỉ viết phần nghiệp vụ. Hướng dẫn từng bước ở [Dựng bot đầu tiên](/guide/first-bot).

## Nguyên tắc xuyên suốt

- **Logic tất định ở code, model chỉ diễn đạt.** Đủ trường chưa, ưu tiên bao nhiêu, ai được sửa ticket: đều là code có test. Đừng chuyển quyết định nghiệp vụ vào prompt. Phép thử: hai model khác nhau chạy cái này, có buộc phải ra cùng kết quả không? Có thì là tool, không thì là skill (xem [Năm lớp của một bot](/explanation/layers)).
- **itsaplan là nguồn sự thật, SQLite là cache.** Mọi dữ kiện phải sống sót qua việc mất máy thì nằm ở itsaplan.
- **Mọi thứ ra ngoài là port được tiêm.** Tracker, kênh, đồng hồ, kho lưu, chuỗi hiển thị: thư viện định nghĩa interface, bot cung cấp bản cài đặt. Test dùng bản giả, không bao giờ gọi dịch vụ thật.
- **Không có tiếng Việt trong logic thư viện.** Câu chữ nằm trong `CopyCatalog` của bot.
- **Mỗi worker khoá theo đúng một dự án.** itsaplan gửi sự kiện của mọi dự án tới mọi webhook, nên mỗi worker tự bỏ sự kiện không thuộc dự án của mình (ADR-0001 của Tiểu Linh).
- **Code lõi thuần.** Phần MCP server import không kéo theo runtime Telegram hay OpenClaw, để nhị phân biên dịch nhỏ và tự chứa.
- **Mọi lần ghi vào ticket đã có phải được người báo xác nhận** (ADR-0008 của Tiểu Linh): bot xem trước, người báo bấm nút, rồi mới ghi.
