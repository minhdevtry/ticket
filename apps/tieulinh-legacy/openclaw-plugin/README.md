# Plugin OpenClaw

Nạp qua `~/.openclaw/openclaw.json` (thứ tự quan trọng: `iris-tuong-tac` trước để khoá nút cũ):

```json
"plugins": {
  "load": { "paths": [
    "<repo>/apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac",
    "<repo>/apps/tieulinh-legacy/openclaw-plugin/xac-nhan-xong"
  ] },
  "entries": {
    "iris-tuong-tac": { "enabled": true, "hooks": { "allowConversationAccess": true } },
    "xac-nhan-xong": { "enabled": true, "hooks": { "allowConversationAccess": true } }
  }
}
```

## iris-tuong-tac

Gắn nút bấm Telegram vào tin nhắn ra (đọc `~/.vhbot/iris-nut-bam/<telegramId>.json` do MCP ghi) và
khoá nút sau khi bấm. Dùng chung cho Iris và Tiểu Linh. Nhật ký: `~/.openclaw/iris-tuong-tac.log`.

Chuyển nguyên trạng từ repo `vh-ai/tms` (commit `25bcafe`, 18/09) ngày 24/09 khi thư mục tms bị xoá
khỏi máy — trước đó OpenClaw nạp plugin thẳng từ tms nên xoá tms là gateway chết.

## xac-nhan-xong

Bắt cú bấm "👍 Đã ổn" (`callback_data: reporter_ok:<issueId>`, và `confirm_done:<issueId>` của nút cũ trước
24/09 — do worker gửi khi ticket sang đã xử lý) TRƯỚC khi nó vào LLM, gọi `POST <worker>/internal/reporter-ok`
(worker chỉ nhận localhost) để ghi comment ý kiến người báo, rồi trả nguyên câu worker trả lời. Bấm nút KHÔNG
đóng ticket — chỉ người xử lý chuyển Done (ADR-0006). Tên plugin giữ "xac-nhan-xong" cho khỏi đổi cấu hình
OpenClaw. Nhật ký: `~/.openclaw/xac-nhan-xong.log`.

Cũng bắt luôn phản hồi tự do — người báo không bấm nút mà nhắn thẳng vào tin thông báo (vd "chưa ổn ạ, vẫn lỗi
y như cũ" — spec C4). Webhook mode có `update.message.reply_to_message` để nhận diện việc này
(`worker/telegram-handler.ts`), nhưng bot chạy qua OpenClaw polling thì không — tin rơi thẳng vào LLM và bị
hiểu nhầm thành sự cố mới, mất phản hồi (đo 28/09/2026). Plugin đọc `reply_to_id` trong phong bì OpenClaw kèm
theo tin, gọi `POST <worker>/internal/reporter-reply` (`{ chatId, replyToMessageId, text, senderName }`); worker
tự tra tin đó có phải tin route đã biết không — khớp thì ghi comment và trả `{ handled: true, replyText }`
(short-circuit LLM), không khớp (vd reply vào tin khác của bot) thì trả `{ handled: false }` và tin vẫn đi tiếp
vào agent như thường.

Bảng agent → worker mặc định `iris-agent=http://127.0.0.1:3103`; đổi bằng env của gateway
`XAC_NHAN_XONG_WORKERS="agentId=url,agentId=url"`. Agent không có trong bảng thì plugin không đụng.

Thay cho `duyet-nhanh` của tms (bản đó gọi script Huly). Nút duyệt admin `duyet:<namecode>` bỏ hẳn —
intake-agents không sinh nút đó.

Lưu ý kiểm thử: hook `before_agent_reply` KHÔNG chạy với tin gửi qua `openclaw agent` (CLI) — chỉ
kiểm được qua Telegram thật. Đừng thử bằng `openclaw agent --agent iris-agent`: tin rơi vào LLM Iris.

## shadow-forwarder

Sao chép không chặn lưu lượng của agent sang relay chạy thử Tiểu Linh 2 (`tools/tl2-shadow`). Không nằm trong cấu hình chạy thật mặc định; cách cài ở [shadow-forwarder/README.md](shadow-forwarder/README.md).
