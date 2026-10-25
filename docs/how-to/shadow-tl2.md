# Chạy bóng Tiểu Linh 2

Mỗi tin nhắn mà Tiểu Linh 1 (đang chạy thật trên server; code là bản tham chiếu đóng băng `apps/tieulinh-legacy`, xem [Bản legacy và bản mới](/explanation/tieulinh-legacy)) nhận được cũng được đưa cho Tiểu Linh 2 (một gateway OpenClaw riêng trên Colab), rồi hai câu trả lời được ghép lại để so sánh. Tiểu Linh 2 không có kênh Telegram nên không bao giờ nhắn người dùng thật. Quyết định kiến trúc: [ADR-0005](/adr/0005-tl2-shadow). Đây là công cụ của maintainer; chế độ shadow dùng chung cho mọi bot vẫn đang viết, xem [Chạy shadow](/how-to/run-shadow).

```
server (Tiểu Linh 1)               máy dev                                   Colab
 plugin shadow-forwarder --POST--> relay --hàng đợi--> worker --ssh -L--> gateway :18796 (agent 2)
                                    proxy :18999 (MiniMax)   <----ssh -R--- provider tl2proxy
                                    proxy :18998 (itsaplan)  <----ssh -R--- MCP tieulinh
                                    pairs.jsonl --> compare.ts

itsaplan (webhook TECH2) --POST /itsaplan-webhook--> relay --ssh -L--> app hậu cần apps/tieulinh (Colab)
                                    proxy :18998 (itsaplan) <---ssh -R--- app (agent-runs, comment, đọc)
                                    proxy :18999 (MiniMax)  <---ssh -R--- app (LLM)
```

Bên cạnh nhánh so sánh, cùng bộ máy này còn chạy **app hậu cần `apps/tieulinh`** (agent `tieulinh2`, dự án `TECH2`) trên Colab: xem [Chạy app hậu cần trên Colab](#chay-app-hau-can-tren-colab).

Mã nằm ở `tools/tl2-shadow` (công cụ chỉ chạy ở máy dev, nên không để trong `apps/`) và plugin ở `apps/tieulinh-legacy/openclaw-plugin/shadow-forwarder`.

## Mô hình an toàn

| Điểm | Biện pháp |
| --- | --- |
| Plugin trên server | Chỉ quan sát, không chờ mạng, timeout 1500 ms, cầu dao 60 giây sau lỗi. Phạm vi session phải khớp `^agent:[a-z0-9-]+:$` (rỗng hoặc thiếu `:` cuối thì plugin tự tắt, không chuyển tiếp agent khác). `relayUrl` phải là địa chỉ IP. Không gửi kết quả tool, tham số tool bị chặn cỡ. |
| Spool trên server | 0600, tối đa 5 MB, giữ 48 giờ, gửi lại theo thứ tự; lỗi 4xx (trừ 408/429) bị bỏ chứ không thử mãi. |
| Relay | Mặc định chỉ nghe loopback. Ngoài loopback bắt buộc `SHADOW_BIND=<IP cụ thể>`, token dùng chung (`SHADOW_RELAY_TOKEN`, cùng giá trị `token` của plugin), và `SHADOW_ALLOW_FROM=<IP server>`. Không nhận `0.0.0.0`. |
| Webhook itsaplan | `POST /itsaplan-webhook` trên relay: cùng bind/danh sách IP với `/ingest`, nhưng xác thực bằng chữ ký HMAC `X-Itsaplan-Signature` (`t=<giây>,v1=<hex>`, lệch quá 5 phút bị từ chối) với `ITSAPLAN_WEBHOOK_SECRET`, không dùng token của `/ingest`. Chỉ chuyển tiếp `comment.created` và `issue.state_changed` tới server webhook loopback của app (qua `ssh -L`), không ghi đĩa, không log nội dung; app lỗi thì trả 502 để itsaplan thử lại. Thiếu secret thì đường này là 404. Secret nằm ở dev; app trên Colab không giữ. |
| Dữ liệu | Hàng đợi và `pairs.jsonl` nằm ngoài repo, thư mục 0700, file 0600, giữ 7 ngày. |
| Proxy MiniMax | Chỉ `POST /v1/messages` và `/v1/chat/completions`, JSON, model trong allowlist, trần tốc độ và đồng thời, kiểm tra Host loopback, không log nội dung. |
| Proxy itsaplan | Mặc định chặn. Đọc chỉ trong project thử và ticket thuộc nó. Ghi chỉ qua các route tạo ticket, sửa ticket, comment (kể cả `replyToId` để trả lời trong luồng), field, link; thêm đúng bốn route `POST /agent-runs/{claim, {id}/heartbeat, {id}/result, {id}/events}` cho app hậu cần (tắt bằng `TL2_ITSAPLAN_AGENT_RUNS=false`; `{id}` chỉ dùng được cho run vừa nhận qua chính proxy và thuộc project thử, id lạ trả 404; body có danh sách khoá, loại sự kiện AG-UI và trần cỡ); mỗi route có danh sách khoá body và mọi tham chiếu (cột, nhãn, loại, người phụ trách, field, ticket đích) phải thuộc project thử; bỏ query string; chặn DELETE, webhook, đính kèm, đổi project hay team. Lúc khởi động tự kiểm tra: khoá itsaplan mà đọc được project thật thì proxy từ chối chạy. |
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
`~/.config/ticket/tieulinh2.env` (0600): `ITSAPLAN_BASE_URL`, `ITSAPLAN_API_KEY`, `ITSAPLAN_PROJECT_KEY` (proxy từ chối `TECH` và `PO`). Dùng khoá chỉ có quyền project thử. Thêm `ITSAPLAN_WEBHOOK_SECRET` (relay đọc đúng khoá này từ file) khi chạy app hậu cần. Cổng app trên Colab là `TL2_APP_PORT` (mặc định 3120, tunnel `-L` về dev), đổi URL chuyển tiếp bằng `TL2_APP_URL` (phải là loopback), danh sách sự kiện bằng `TL2_WEBHOOK_EVENTS`.

Dữ liệu chat thật ở `~/.local/share/tl2-shadow/` (0700; file 0600): `events.jsonl`, `pairs.jsonl`, `gateway.token`, `logs/`. Đổi chỗ bằng `TL2_SHADOW_DIR`.

## Chạy

```bash
deploy/colab/cup-openclaw.sh -H colab2     # lần đầu, mỗi khi Colab bị thu hồi hoặc đổi code
deploy/dev/tl2-shadow.sh start             # proxy, tunnel, relay, rồi app hậu cần trên Colab (pidfile; TL2_TIEULINH=off để bỏ app)
deploy/dev/tl2-shadow.sh status
deploy/dev/tl2-shadow.sh stop              # dừng theo PID, gỡ forward
bun run tools/tl2-shadow/compare.ts --since 24h    # bảng; thêm --full, --md, --json, --chat <id>
```

`cup-openclaw.sh` chỉ đẩy code đã commit của `-r <ref>` (mặc định `HEAD`) bằng `git archive`, từ chối nếu bản lưu có file giống secret, cài theo lockfile, dựng `openclaw.json` không secret (`--api anthropic-messages` hoặc `openai-completions`, cả hai đều chạy) và khởi động gateway. Chạy lại cùng ref thì không đổi gì.

## Cài plugin trên server

Làm tay trên server, không có bước tự động. Thêm vào `~/.openclaw/openclaw.json`, giữ nguyên plugin cũ:

```json
"plugins": {
  "load": { "paths": ["<repo>/apps/tieulinh-legacy/openclaw-plugin/shadow-forwarder"] },
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

Khuyến nghị khi cài lên gateway đang phục vụ người thật:

- Chép thư mục plugin từ một commit cố định của `main` bằng `git archive <sha> apps/tieulinh-legacy/openclaw-plugin/shadow-forwarder` (không chép working tree) vào một thư mục NGOÀI mọi repo, vd `~/apps/ticket-plugins/shadow-forwarder`, rồi trỏ `plugins.load.paths` vào đó.
- Sao lưu `openclaw.json` (bản có dấu thời gian, 0600) trước khi sửa, đặt `token` qua here-doc đọc từ file 0600 (đừng đưa vào dòng lệnh), đặt `sessionPrefix` rõ ràng (vd `agent:ticket-intake-agent:`): gateway có thể phục vụ agent khác.
- Chạy `openclaw config validate` rồi chờ hot reload (OpenClaw 2026.9.x nạp plugin và `plugins.entries` không cần restart). Log gateway (`openclaw gateway status` in đường dẫn) phải có `config hot reload applied`.
- Giữ bản sao lưu để quay lại ngay: chép bản sao lưu về `openclaw.json` cũng được hot reload.

Kiểm tra sau khi nạp (canary): chạy `openclaw plugins inspect shadow-forwarder --runtime --json` và thấy ba hook `message_received`, `message_sent`, `after_tool_call`; rồi chờ tin thật kế tiếp (hoặc gửi MỘT tin thử vào bot) và xem `bun run tools/tl2-shadow/compare.ts --limit 1` trên máy dev. `compare.ts` in nội dung tin thật ra terminal: chỉ chạy ở cửa sổ riêng tư, đừng dán vào log hay ticket. Plugin tắt hay cấu hình sai thì để lại dòng `TẮT: <lý do>` trong `~/.openclaw/shadow-forwarder.log` và không đăng ký hook nào. Gỡ: bỏ mục `shadow-forwarder` rồi reload gateway.

## Chạy app hậu cần trên Colab {#chay-app-hau-can-tren-colab}

Chạy `apps/tieulinh` (agent `tieulinh2`, dự án `tech.TECH2`) để thử nửa hậu cần với ticket thật của TECH2. Bot chỉ có kênh nhật ký (không có `TELEGRAM_BOT_TOKEN`), itsaplan và LLM đi qua hai proxy trên dev, nên Colab vẫn không giữ secret. Bot làm gì: [Tiểu Linh mới: hậu cần](/explanation/tieulinh-hau-can); chạy thế nào ở nơi khác: [Chạy Tiểu Linh 2 (hậu cần)](/how-to/run-tieulinh-hau-can).

### 1. Chuẩn bị Colab (một lần cho mỗi VM)

`cup-openclaw.sh` và `cup-tieulinh.sh` cần sẵn `bun`, Node 24 ở `/opt/node24` và OpenClaw ở `/opt/oc` (VM Colab mới chưa có). Cài bằng thao tác công khai, không cần secret:

```bash
ssh colab2 'curl -fsSL https://bun.sh/install | bash; ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun'
ssh colab2 'mkdir -p /opt/node24 && curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz | tar -xJ -C /opt/node24 --strip-components=1'
ssh colab2 'PATH=/opt/node24/bin:$PATH npm install -g --prefix /opt/oc --allow-scripts=@google/genai,esbuild,koffi,protobufjs,openclaw openclaw@2026.9.9'
```

Cờ `--allow-scripts` cần vì npm mới bỏ qua script cài đặt của OpenClaw. Colab bị thu hồi thì làm lại từ đầu mục này.

### 2. Webhook của TECH2

App cần webhook của itsaplan cho luật `closure`, `relay-comment` và `duplicates` (sự kiện `comment.created` và `issue.state_changed`; mention đi bằng agent-runs, không qua webhook). Tạo MỘT webhook trên đúng dự án `tech.TECH2`, trỏ về relay trên dev, bằng khoá quản trị (khoá của agent không có quyền webhook; chạy trên server, đừng in khoá):

```bash
curl -s -X POST "$ITSAPLAN_URL/projects/tech.TECH2/webhooks" \
  -H "x-api-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"url":"http://10.0.0.2:3106/itsaplan-webhook","events":["comment.created","issue.state_changed"],"isActive":true}'
```

`10.0.0.2` là IP LAN của dev (cùng giá trị `SHADOW_BIND`). Itsaplan bỏ qua `secret` do client gửi và tự sinh `whsec_…`: đọc lại secret từ `GET /projects/tech.TECH2/webhooks` rồi ghi vào `~/.config/ticket/tieulinh2.env` thành `ITSAPLAN_WEBHOOK_SECRET=` (0600), rồi khởi động lại relay để nạp. Đừng đọc secret ra terminal: chuyển thẳng vào file.

Agent chỉ được chạy theo mention khi bật `triggerOnMention` (mặc định tắt với agent ngoài): `PATCH /teams/<team-id>/ai-agents/<agent-id>` với `{"triggerOnMention":true}`. Không bật thì `@tieulinh2` không tạo run nào và `claim` luôn trả rỗng.

### 3. Chạy

```bash
deploy/dev/tl2-shadow.sh start          # proxy, tunnel, relay, rồi cup-tieulinh.sh
deploy/dev/tl2-shadow.sh status         # thêm health của app
deploy/colab/cup-tieulinh.sh -H colab2 -r <ref>     # chỉ app: đẩy code đã commit, chạy lại khi bản hoặc env đổi
deploy/colab/cup-tieulinh.sh -H colab2 stop|status
deploy/dev/tl2-shadow.sh logs tieulinh  # nhật ký app trên Colab
```

`cup-tieulinh.sh` dùng cùng cách đẩy code và cùng bộ lọc secret với `cup-openclaw.sh`, nhưng giữ symlink riêng (`~/tl2/tieulinh-current`) nên hai bản không giẫm nhau khi dọn bản cũ. Nó kiểm tra hai cổng proxy đã sang Colab, rồi chạy `tools/tl2-shadow/colab/tieulinh-run.ts` trên Colab: dựng env KHÔNG secret (itsaplan và LLM trỏ loopback, khoá giả `proxy-injects-the-real-key`, webhook và `/healthz` chỉ nghe loopback, chat giả `-1000000000001` làm sandbox cho ticket chưa có người báo), chạy nền bằng `setsid`, chờ `/healthz` báo `ok`. Chạy lại cùng ref và cùng env thì không làm gì.

Dữ liệu của app (`BOT_DATA_DIR=~/tl2/tieulinh/data` trên Colab: kho SQLite và `tieulinh-channel.jsonl`) là TẠM THỜI: mất khi Colab bị thu hồi. Chấp nhận được cho môi trường thử; đọc nhật ký kênh bằng `ssh colab2 'cat ~/tl2/tieulinh/data/tieulinh-channel.jsonl'`.

### 4. Kiểm thử nhanh (smoke) trên TECH2

Đi qua proxy dev (`127.0.0.1:18998`), không dùng khoá thật:

1. Tạo ticket `[smoke] ...` bằng `POST /projects/TECH2/issues` (cột `Todo`).
2. Một người (không phải chính `tieulinh2`) comment `@tieulinh2 ...`. Sự kiện do actor kiểu agent gây ra (đổi cột bằng khoá agent chẳng hạn) bị luật của bot bỏ qua có chủ đích (bot không phản ứng với agent, `reactToAgents`), nên bước này và bước 4 dùng khoá của một người (quản trị) trên server, chỉ với ticket TECH2; tạo ticket và đọc thì dùng proxy được.
3. Kỳ vọng: `claim` nhận run `mention`, vài `events`, một comment trả lời có `replyToId` bằng comment đã mention, rồi `result` (204). `/healthz` có `totals.claimed` và `succeeded` tăng, `failed` bằng 0.
4. Kéo ticket sang `In Progress` rồi `Done`: nhật ký kênh có hai bản ghi `state` (`open`, `done`). TECH2 không có cột loại Resolved nên không thấy `withReporterOkButton: true`; muốn thử nút "Đã ổn" thì thêm một cột Resolved vào TECH2.

Ticket smoke không xoá được qua proxy (chặn DELETE); để nguyên hoặc dọn bằng khoá quản trị.

### Gỡ

```bash
deploy/colab/cup-tieulinh.sh -H colab2 stop     # dừng app
# gỡ webhook: DELETE /webhooks/<id> bằng khoá quản trị (id từ GET /projects/tech.TECH2/webhooks)
deploy/dev/tl2-shadow.sh stop                   # dừng app, rồi relay, tunnel, proxy (dừng theo PID)
```

## Giới hạn đã biết

- Tin gửi dồn dập (tin sau tới trước khi Tiểu Linh 1 trả lời tin trước): câu trả lời có thể gán lệch theo cửa sổ thời gian; ngữ cảnh gửi cho Tiểu Linh 2 có thể thiếu câu trả lời mới nhất.
- Nút bấm (inline keyboard) của Tiểu Linh 1 không có ở Tiểu Linh 2; cặp so sánh chỉ gồm chữ.
- Lệnh gọi tool của Tiểu Linh 2 không có trong cặp (endpoint chat-completions không trả); xem `logs/proxy.log` cho các lệnh itsaplan.
- Ticket Tiểu Linh 2 tạo nằm ở `TECH2`; proxy chặn DELETE nên không tự xoá được.
- Cặp so sánh ghi cả khi Tiểu Linh 1 trả lỗi: câu lỗi của gateway (vd "LLM request failed") hiện ở cột Tiểu Linh 1. Plugin chỉ quan sát nên lỗi đó là của nhà cung cấp model hay phiên chat, không phải của plugin; vẫn nên so log gateway trước và sau khi gỡ.
- Độ trễ mỗi lượt khoảng 15 đến 50 giây (nhiều vòng gọi LLM và tool).
