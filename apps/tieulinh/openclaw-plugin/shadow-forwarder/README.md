# shadow-forwarder

Sao chép lưu lượng của MỘT agent (tin vào, tin ra đã gửi, lệnh gọi tool) sang relay của bộ chạy bóng Tiểu Linh 2 (`tools/tl2-shadow`). Chỉ quan sát: không chặn, không đổi nội dung, không thêm độ trễ.

- `message_received`: handler trả ngay, `fetch` không bị chờ, `AbortSignal.timeout(1500)`.
- `message_sent`: câu trả lời cuối cùng đã gửi.
- `after_tool_call`: tên tool và tham số (tắt bằng `tools: false`).
- Chỉ lấy session key bắt đầu bằng `sessionPrefix` (mặc định `agent:ticket-intake-agent:`).
- Relay không với tới: ghi `~/.openclaw/shadow-forwarder.spool.jsonl` (tối đa 5 MB, 0600) và gửi lại theo thứ tự sau lần gửi thành công kế tiếp (tối đa 500 sự kiện mỗi lần, cách nhau 30 giây).
- Chưa cấu hình `relayUrl` (và không có `SHADOW_RELAY_URL`): plugin không đăng ký hook nào.

## Cài (làm tay trên server)

Thêm vào `~/.openclaw/openclaw.json`, giữ nguyên các plugin cũ:

```json
"plugins": {
  "load": { "paths": [
    "<repo>/apps/tieulinh/openclaw-plugin/shadow-forwarder"
  ] },
  "entries": {
    "shadow-forwarder": {
      "enabled": true,
      "config": { "relayUrl": "http://10.0.0.5:3106/ingest" }
    }
  }
}
```

`10.0.0.5` là ví dụ: thay bằng IP LAN của máy dev chạy relay. Cấu hình tuỳ chọn: `token` (khớp `SHADOW_RELAY_TOKEN` của relay), `sessionPrefix`, `timeoutMs` (200-5000), `tools`, `spoolPath`.

Không cần `hooks.allowConversationAccess`. Gỡ: bỏ mục `shadow-forwarder` rồi reload gateway.

Kiểm thử: `bun test apps/tieulinh/openclaw-plugin/shadow-forwarder`.
