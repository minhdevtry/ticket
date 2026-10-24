# tl2-shadow

Chạy bóng Tiểu Linh 2: mỗi tin nhắn Tiểu Linh 1 (live, trên server) nhận được cũng được đưa cho Tiểu Linh 2 (Colab, OpenClaw riêng), rồi ghép câu trả lời của hai bên để so sánh. Tiểu Linh 2 không có kênh Telegram nên không bao giờ nhắn người dùng thật. Quyết định: [ADR-0004](../../docs/adr/0004-tl2-shadow.md).

Vị trí: `tools/` (không phải `apps/`) vì đây là công cụ chỉ chạy ở máy dev, không triển khai trên server như một bot.

```
server (Tiểu Linh 1)                dev                                      Colab (colab2)
 plugin shadow-forwarder --POST--> relay :3106 --queue--> worker --ssh -L--> gateway :18796 (agent 2)
                                    proxy :18999 (MiniMax) <------ssh -R------ provider tl2proxy
                                    proxy :18998 (itsaplan TECH2) <--ssh -R--- MCP tieulinh
                                    pairs.jsonl --> compare.ts
```

## Thành phần

| File | Vai trò |
| --- | --- |
| `relay.ts` | HTTP `POST /ingest`, `GET /health`; chỉ nhận loopback + `SHADOW_ALLOW_FROM`; ghi hàng đợi; chạy worker |
| `queue.ts` | `events.jsonl`, `pairs.jsonl` (0600, retention 7 ngày), chỉ mục theo chat |
| `worker.ts` | Gọi `POST /v1/chat/completions` (`openclaw/ticket-intake-agent-2`, header `x-openclaw-session-key: agent:ticket-intake-agent-2:shadow:<chatId>`); tuần tự từng chat; replay khi tunnel về; bỏ tin quá 24 giờ |
| `proxy.ts` | Proxy loopback giữ secret: MiniMax `:18999`, itsaplan `:18998` |
| `tunnel.ts` | Giữ `ssh -O forward` (-L gateway, -R hai proxy) trên ControlMaster; lấy token gateway về |
| `compare.ts` | Bảng so sánh từ `pairs.jsonl` |
| `colab/` | `render-config.ts` (openclaw.json không secret) và `bootstrap.ts` (chạy trên Colab) |

Mỗi tin vào được gửi kèm phong bì kênh giống OpenClaw thật (`chat_id`, người gửi) và vài lượt gần nhất (tin người dùng + câu trả lời của Tiểu Linh 1 làm `assistant`). Tiểu Linh 2 được gọi ngay khi tin tới (song song với Tiểu Linh 1); cặp chỉ ghi khi Tiểu Linh 1 đã trả lời xong (im lặng `TL2_TL1_SETTLE_MS`, tối đa `TL2_TL1_WAIT_MAX_MS`).

## Cấu hình (ngoài repo)

`~/.config/ticket/tl2-shadow.env` (tự nạp, không ghi đè biến đã đặt):

```bash
SHADOW_ALLOW_FROM=10.0.0.5     # IP server được gửi sự kiện (bắt buộc; rỗng = chỉ loopback)
TL2_COLAB_HOST=colab2
# tuỳ chọn: SHADOW_PORT=3106  SHADOW_BIND=0.0.0.0  SHADOW_RELAY_TOKEN=...  TL2_CONTEXT_TURNS=4
#           TL2_CONCURRENCY=3  TL2_REQUEST_TIMEOUT_MS=180000  TL2_RETENTION_DAYS=7
```

`~/.config/ticket/minimax.env` (0600): `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, tuỳ chọn `MINIMAX_MODELS` (mặc định `MiniMax-M3.1-Flash`).
`~/.config/ticket/tieulinh2.env` (0600): `ITSAPLAN_BASE_URL`, `ITSAPLAN_API_KEY`, `ITSAPLAN_PROJECT_KEY` (proxy từ chối `TECH` và `PO`).

Dữ liệu chat thật nằm ở `~/.local/share/tl2-shadow/` (0700; file 0600): `events.jsonl`, `pairs.jsonl`, `gateway.token`, `logs/`. Đổi chỗ bằng `TL2_SHADOW_DIR`. Proxy không log nội dung.

## Chạy

```bash
deploy/colab/cup-openclaw.sh -H colab2     # lần đầu và mỗi khi Colab bị thu hồi / đổi code
deploy/dev/tl2-shadow.sh start             # proxy, tunnel, relay (pidfile; `systemd-install` để chạy bền)
deploy/dev/tl2-shadow.sh status | logs [proxy|relay|tunnel]
deploy/dev/tl2-shadow.sh stop              # dừng theo PID, gỡ forward
bun run tools/tl2-shadow/compare.ts --since 24h          # bảng; thêm --full | --md | --json | --chat <id>
```

`cup-openclaw.sh` chỉ đẩy code đã commit của `-r <ref>` (mặc định HEAD) bằng `git archive`, cài theo lockfile, dựng `openclaw.json` (kiểu API MiniMax `--api anthropic-messages|openai-completions`, mặc định anthropic-messages; cả hai đã thử chạy được) và khởi động gateway. Chạy lại cùng ref thì không đổi gì.

## Giới hạn đã biết

- Tin gửi dồn dập (tin sau tới trước khi Tiểu Linh 1 trả lời tin trước): câu trả lời có thể gán lệch tin theo cửa sổ thời gian; ngữ cảnh gửi cho Tiểu Linh 2 có thể thiếu câu trả lời mới nhất.
- Nút bấm (inline keyboard) của Tiểu Linh 1 không có ở Tiểu Linh 2; cặp so sánh chỉ gồm chữ.
- Lệnh gọi tool của Tiểu Linh 2 không có trong cặp (endpoint chat-completions không trả); xem `logs/proxy.log` cho các lệnh itsaplan.
- Ticket Tiểu Linh 2 tạo nằm ở project `TECH2`; proxy chặn DELETE nên không tự xoá được.
