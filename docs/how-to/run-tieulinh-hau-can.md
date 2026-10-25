# Chạy Tiểu Linh 2 (hậu cần) với TECH2

Việc cần làm: chạy bot hậu cần `apps/tieulinh` trên dự án `tech.TECH2` với agent `tieulinh2`, ở chế độ bóng (không gửi tin thật cho ai). Bot làm gì và vì sao: [Tiểu Linh mới: hậu cần](/explanation/tieulinh-hau-can).

## 1. Chuẩn bị trên itsaplan

- Dự án `TECH2` trong team `tech`, và một agent có username `tieulinh2` là thành viên của nó (key của agent, không phải key người).
- Webhook của dự án trỏ về địa chỉ bot nghe, có đủ `issue.state_changed` và `comment.created` (hoặc để bot tự đăng ký, xem `BOT_WEBHOOK_AUTO_REGISTER` ở [Cấu hình và biến môi trường](/reference/config-env)).

## 2. Đặt biến môi trường

Tối thiểu (mọi giá trị dưới đây là ví dụ, secret thật đẩy qua SSH, xem [Deploy và đẩy secret qua SSH](/how-to/deploy)):

```bash
# bot kit
ITSAPLAN_BASE_URL=https://itsaplan.example.com
ITSAPLAN_AGENT_KEY=...                 # key của agent tieulinh2
BOT_DATA_DIR=/var/lib/tieulinh2         # bắt buộc, đường dẫn tuyệt đối
BOT_WEBHOOK_PORT=3110                   # luật chạy trên webhook
ITSAPLAN_WEBHOOK_SECRET=whsec_...       # bắt buộc nếu BOT_WEBHOOK_HOST ngoài loopback
LLM_BASE_URL=http://127.0.0.1:18999     # MiniMax qua proxy giữ key
LLM_API_KEY=proxy-injects-the-real-key
LLM_MODEL=MiniMax-M3.1-Flash

# riêng Tiểu Linh 2 (đều tuỳ chọn)
TIEULINH_TEAM=tech
TIEULINH_PROJECT=TECH2                  # chạy thật: TECH
TIEULINH_AGENT=tieulinh2                # username của agent, khớp user của ITSAPLAN_AGENT_KEY
ITSAPLAN_WEB_URL=https://itsaplan.example.com   # để cảnh báo SLA có link ticket
TIEULINH_SANDBOX_CHAT=-1000000000001    # gắn ticket chưa liên kết vào chat thử
```

Không đặt `TELEGRAM_BOT_TOKEN`: bot dùng kênh nhật ký, không có tin nào ra ngoài. Danh sách đủ các biến và mặc định: [Tiểu Linh mới](/reference/config-env). Thiếu hoặc sai biến thì bot dừng ngay với một `ConfigError` liệt kê hết chỗ sai.

## 3. Chạy

```bash
bun run apps/tieulinh/main.ts
```

Bot đọc thêm file `.env` ở thư mục chạy (biến trong môi trường thắng file). Thư mục dữ liệu `BOT_DATA_DIR` được tạo mode 0700 với:

| File | Nội dung |
|---|---|
| `tieulinh.sqlite` | kho của bot kit: ledger run, khoá chống trùng (cả dấu "đã chuyển comment" và "đã nhắc SLA"), mốc cron |
| `tieulinh-app.sqlite` | liên kết ticket-người báo, tuyến tin, trạng thái vòng đời, mốc theo dõi SLA |
| `tieulinh-channel.jsonl` | nhật ký kênh: mọi tin bot muốn gửi người báo và mọi cảnh báo trực ca |

## 4. Kiểm tra

1. Gọi `@tieulinh2` trên một ticket TECH2: bot trả lời trong luồng comment; nếu ticket có liên kết (hoặc đặt `TIEULINH_SANDBOX_CHAT`) thì lời nhắn xuất hiện trong nhật ký.
2. Kéo ticket sang Resolved: nhật ký có một bản ghi `state` với `withReporterOkButton: true`; ticket **vẫn ở Resolved**.
3. Để một ticket chưa giao quá hạn: nhật ký có bản ghi `alert`, đúng một lần.
4. Giả lập người báo (kênh nhật ký, không cần Telegram): `curl -s -X POST http://127.0.0.1:3110/internal/reporter-ok -H 'content-type: application/json' -d '{"issueId":123,"chatId":"-1000000000001","userName":"An"}'` ghi đúng một comment "đã ổn" lên ticket; `/internal/reporter-reply` với `replyToMessageId` là `messageId` của một bản ghi `state` trong nhật ký ghi comment trả lời tự do.

Đọc nhật ký trong code (cùng định dạng test của app dùng):

```ts check
import { readChannelLog } from "@vuihoc/bot-core/intake";

const records = readChannelLog("/var/lib/tieulinh2/tieulinh-channel.jsonl");
const alerts = records.filter((r) => r.kind === "alert");
console.log(`${records.length} bản ghi, ${alerts.length} cảnh báo trực ca`);
```

Hoặc chỉ cần `jq 'select(.kind=="alert")' /var/lib/tieulinh2/tieulinh-channel.jsonl`.

## Chạy chế độ bóng trên Colab (không secret)

Cách đang dùng để thử TL2 với TECH2: app chạy trên VM Colab, mọi secret ở lại máy dev. Các bước thật (chuẩn bị Colab, webhook TECH2 qua relay, `cup-tieulinh.sh`, smoke, gỡ) nằm ở [Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2#chay-app-hau-can-tren-colab). Khác với chạy trực tiếp ở trên:

- `ITSAPLAN_BASE_URL` và `LLM_BASE_URL` trỏ cổng loopback của hai proxy (`ssh -R`); `ITSAPLAN_AGENT_KEY` và `LLM_API_KEY` chỉ là giá trị giả, proxy gắn khoá thật. Proxy itsaplan chỉ cho đúng các route `agent-runs` và vài route đọc/ghi trong TECH2.
- Webhook đi itsaplan, relay trên dev (kiểm chữ ký `ITSAPLAN_WEBHOOK_SECRET`, secret không lên Colab), `ssh -L`, rồi vào server webhook loopback của app. Vì vậy app không đặt `ITSAPLAN_WEBHOOK_SECRET`.
- Agent phải bật `triggerOnMention` trên itsaplan, nếu không `@tieulinh2` không tạo run.
- Kho dữ liệu nằm trên Colab và mất khi VM bị thu hồi; `TIEULINH_SANDBOX_CHAT` là chat giả, kênh vẫn chỉ ghi nhật ký.
- Bot bỏ qua sự kiện do chính một agent gây ra: khi thử, đổi cột và comment bằng khoá của người, không dùng khoá `tieulinh2`.

## 5. Chuyển sang gửi thật và sang TECH

- Gửi Telegram thật: đặt `TELEGRAM_BOT_TOKEN` **và** `TIEULINH_ONCALL_CHAT_ID` (thiếu một trong hai thì bot dừng với `ConfigError`: cảnh báo SLA không được nuốt im). Cần liên kết ticket-chat thật, tức lễ tân (chưa làm), hoặc `TIEULINH_SANDBOX_CHAT` cho chat thử. Để nút "Đã ổn" và trả lời tự do của người báo có người nghe: giữ `BOT_WEBHOOK_PORT`, rồi hoặc `setWebhook` của Telegram trỏ tới `/telegram-webhook` với `secret_token` bằng `TELEGRAM_WEBHOOK_SECRET` (bắt buộc nếu nghe ngoài loopback), hoặc để plugin Telegram cùng máy gọi `/internal/reporter-ok` và `/internal/reporter-reply` (chỉ loopback). Chế độ Telegram mới được kiểm bằng Telegram giả, chưa chạy với bot thật: thử trên một chat riêng trước.
- Đổi dự án: `TIEULINH_PROJECT=TECH`. Không có gì khác phải sửa trong code; kho dữ liệu nên dùng thư mục riêng cho mỗi dự án.

## Test không cần mạng

```bash
bun run --cwd apps/tieulinh test
```

Test dùng `FakeItsaplan` (dự án TECH2), `FakeLlm` và đồng hồ giả, nên chạy cả kịch bản cron SLA mà không chờ.
