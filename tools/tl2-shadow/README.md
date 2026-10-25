# tl2-shadow

Công cụ chạy bóng Tiểu Linh 2 (relay, hàng đợi, worker, proxy giữ secret, tunnel, `compare.ts`, và `colab/` để dựng gateway trên Colab). Chỉ chạy trên máy dev.

Tài liệu đầy đủ: [docs/how-to/shadow-tl2.md](../../docs/how-to/shadow-tl2.md) (site docs: "Chạy bóng Tiểu Linh 2"). Quyết định: [ADR-0005](../../docs/adr/0005-tl2-shadow.md).

```bash
bun test tools/tl2-shadow          # test (không gọi dịch vụ thật)
deploy/dev/tl2-shadow.sh start     # proxy + tunnel + relay + app hậu cần trên Colab
```

| File | Vai trò |
| --- | --- |
| `relay.ts` | `POST /ingest`, `GET /health`; ghi hàng đợi; chạy worker; `POST /itsaplan-webhook` (kiểm HMAC, chuyển tới app hậu cần, không lưu) |
| `queue.ts` | `events.jsonl`, `pairs.jsonl` (0600, giữ 7 ngày) |
| `worker.ts` | gọi Tiểu Linh 2 theo thứ tự từng chat, replay khi tunnel về |
| `proxy.ts`, `proxy-itsaplan.ts`, `proxy-common.ts` | proxy MiniMax và itsaplan giữ secret |
| `tunnel.ts` | `ssh -O forward` trên ControlMaster (gateway, app hậu cần, hai proxy), lấy token gateway |
| `compare.ts` | bảng so sánh từ `pairs.jsonl` |
| `colab/` | `render-config.ts`, `bootstrap.ts` (gateway), `tieulinh-run.ts` (app hậu cần `apps/tieulinh`, không secret); chạy trên Colab |
