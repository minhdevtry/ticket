# Chạy bóng Tiểu Linh 2

Mỗi tin nhắn mà Tiểu Linh 1 (đang chạy thật trên server) nhận được cũng được đưa cho Tiểu Linh 2 (một gateway OpenClaw riêng trên Colab), rồi hai câu trả lời được ghép lại để so sánh. Tiểu Linh 2 không có kênh Telegram nên không bao giờ nhắn người dùng thật. Quyết định kiến trúc: [ADR-0005](/adr/0005-tl2-shadow). Đây là công cụ của maintainer; chế độ shadow dùng chung cho mọi bot vẫn đang viết, xem [Chạy shadow](/how-to/run-shadow).

```
server (Tiểu Linh 1)               máy dev                                   Colab
 plugin shadow-forwarder --POST--> relay --hàng đợi--> worker --ssh -L--> gateway :18796 (agent 2)
                                    proxy :18999 (MiniMax)   <----ssh -R--- provider tl2proxy
                                    proxy :18998 (itsaplan)  <----ssh -R--- MCP tieulinh
                                    pairs.jsonl --> compare.ts
```

Mã nằm ở `tools/tl2-shadow` (công cụ chỉ chạy ở máy dev, nên không để trong `apps/`) và plugin ở `apps/tieulinh/openclaw-plugin/shadow-forwarder`.

## Mô hình an toàn

| Điểm | Biện pháp |
| --- | --- |
| Plugin trên server | Chỉ quan sát, không chờ mạng, timeout 1500 ms, cầu dao 60 giây sau lỗi. Phạm vi session phải khớp `^agent:[a-z0-9-]+:$` (rỗng hoặc thiếu `:` cuối thì plugin tự tắt, không chuyển tiếp agent khác). `relayUrl` phải là địa chỉ IP. Không gửi kết quả tool, tham số tool bị chặn cỡ. |
| Spool trên server | 0600, tối đa 5 MB, giữ 48 giờ, gửi lại theo thứ tự; lỗi 4xx (trừ 408/429) bị bỏ chứ không thử mãi. |
| Relay | Mặc định chỉ nghe loopback. Ngoài loopback bắt buộc `SHADOW_BIND=<IP cụ thể>`, token dùng chung (`SHADOW_RELAY_TOKEN`, cùng giá trị `token` của plugin), và `SHADOW_ALLOW_FROM=<IP server>`. Không nhận `0.0.0.0`. |
| Dữ liệu | Hàng đợi và `pairs.jsonl` nằm ngoài repo, thư mục 0700, file 0600, giữ 7 ngày. |
| Proxy MiniMax | Chỉ `POST /v1/messages` và `/v1/chat/completions`, JSON, model trong allowlist, trần tốc độ và đồng thời, kiểm tra Host loopback, không log nội dung. |
| Proxy itsaplan | Mặc định chặn. Đọc chỉ trong project thử và ticket thuộc nó. Ghi chỉ qua các route tạo ticket, sửa ticket, comment, field, link; mỗi route có danh sách khoá body và mọi tham chiếu (cột, nhãn, loại, người phụ trách, field, ticket đích) phải thuộc project thử; bỏ query string; chặn DELETE, webhook, đính kèm, đổi project hay team. Lúc khởi động tự kiểm tra: khoá itsaplan mà đọc được project thật thì proxy từ chối chạy. |
| Colab | Không giữ secret. Tool dựng sẵn shell, file, web, trình duyệt bị cấm; chỉ còn tool của MCP `ticketintake`. Token gateway là chuỗi ngẫu nhiên sinh trên Colab. |

### Dữ liệu người dùng rời máy

Tiểu Linh 2 cần ngữ cảnh giống Tiểu Linh 1, nên các trường sau của tin Telegram đi từ server sang relay, rồi sang Colab:

- nội dung tin, chat ID, message ID, thời điểm;
- ID, tên hiển thị và username người gửi;
- tin được reply (nội dung, người gửi);
- vài lượt trước của cùng chat, kèm câu trả lời của Tiểu Linh 1.

Ảnh và file không được chuyển (chỉ loại và có/không có file). Nội dung đi qua MiniMax và Itsaplan thử qua proxy. Đường server tới relay hiện là HTTP trên LAN có token, chưa mã hoá; bước sau có thể chuyển sang `ssh -R` hoặc WireGuard.

## Cấu hình (ngoài repo)

`~/.config/ticket/tl2-shadow.env` (tự nạp, không ghi đè biến đã đặt):

```bash
# Mặc định relay chỉ nghe loopback. Để nhận từ server qua LAN, đặt đủ ba biến:
SHADOW_BIND=10.0.0.2            # IP LAN cụ thể của máy dev (không dùng 0.0.0.0)
SHADOW_RELAY_TOKEN=thay-bang-chuoi-ngau-nhien-dai   # >= 16 ký tự, khớp `token` của plugin
SHADOW_ALLOW_FROM=10.0.0.5      # IP server
TL2_COLAB_HOST=colab2
# tuỳ chọn: SHADOW_PORT=3106  TL2_CONTEXT_TURNS=4  TL2_CONCURRENCY=3
#           TL2_REQUEST_TIMEOUT_MS=180000  TL2_RETENTION_DAYS=7
```

`~/.config/ticket/minimax.env` (0600): `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, tuỳ chọn `MINIMAX_MODELS` (mặc định `MiniMax-M3.1-Flash`).
`~/.config/ticket/tieulinh2.env` (0600): `ITSAPLAN_BASE_URL`, `ITSAPLAN_API_KEY`, `ITSAPLAN_PROJECT_KEY` (proxy từ chối `TECH` và `PO`). Dùng khoá chỉ có quyền project thử.

Dữ liệu chat thật ở `~/.local/share/tl2-shadow/` (0700; file 0600): `events.jsonl`, `pairs.jsonl`, `gateway.token`, `logs/`. Đổi chỗ bằng `TL2_SHADOW_DIR`.

## Chạy

```bash
deploy/colab/cup-openclaw.sh -H colab2     # lần đầu, mỗi khi Colab bị thu hồi hoặc đổi code
deploy/dev/tl2-shadow.sh start             # proxy, tunnel, relay (pidfile; `systemd-install` để chạy bền)
deploy/dev/tl2-shadow.sh status
deploy/dev/tl2-shadow.sh stop              # dừng theo PID, gỡ forward
bun run tools/tl2-shadow/compare.ts --since 24h    # bảng; thêm --full, --md, --json, --chat <id>
```

`cup-openclaw.sh` chỉ đẩy code đã commit của `-r <ref>` (mặc định `HEAD`) bằng `git archive`, từ chối nếu bản lưu có file giống secret, cài theo lockfile, dựng `openclaw.json` không secret (`--api anthropic-messages` hoặc `openai-completions`, cả hai đều chạy) và khởi động gateway. Chạy lại cùng ref thì không đổi gì.

## Cài plugin trên server

Làm tay trên server, không có bước tự động. Thêm vào `~/.openclaw/openclaw.json`, giữ nguyên plugin cũ:

```json
"plugins": {
  "load": { "paths": ["<repo>/apps/tieulinh/openclaw-plugin/shadow-forwarder"] },
  "entries": {
    "shadow-forwarder": {
      "enabled": true,
      "config": {
        "relayUrl": "http://10.0.0.2:3106/ingest",
        "token": "cùng-giá-trị-với-SHADOW_RELAY_TOKEN"
      }
    }
  }
}
```

Kiểm tra sau khi nạp (canary): chạy `openclaw plugins inspect shadow-forwarder --runtime --json` và thấy ba hook `message_received`, `message_sent`, `after_tool_call`; rồi gửi MỘT tin thử vào bot và xem `bun run tools/tl2-shadow/compare.ts --limit 1` trên máy dev. Plugin tắt hay cấu hình sai thì để lại dòng `TẮT: <lý do>` trong `~/.openclaw/shadow-forwarder.log` và không đăng ký hook nào. Gỡ: bỏ mục `shadow-forwarder` rồi reload gateway.

## Giới hạn đã biết

- Tin gửi dồn dập (tin sau tới trước khi Tiểu Linh 1 trả lời tin trước): câu trả lời có thể gán lệch theo cửa sổ thời gian; ngữ cảnh gửi cho Tiểu Linh 2 có thể thiếu câu trả lời mới nhất.
- Nút bấm (inline keyboard) của Tiểu Linh 1 không có ở Tiểu Linh 2; cặp so sánh chỉ gồm chữ.
- Lệnh gọi tool của Tiểu Linh 2 không có trong cặp (endpoint chat-completions không trả); xem `logs/proxy.log` cho các lệnh itsaplan.
- Ticket Tiểu Linh 2 tạo nằm ở `TECH2`; proxy chặn DELETE nên không tự xoá được.
- Độ trễ mỗi lượt khoảng 15 đến 50 giây (nhiều vòng gọi LLM và tool).
