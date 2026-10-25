# Tiểu Linh mới (`@vuihoc/tieulinh`): hậu cần

Nửa **hậu cần** (back office) của Tiểu Linh, viết lại bằng bot kit (`defineBot`/`createBot` của `@vuihoc/bot-core`). Nó thay phần worker của [`apps/tieulinh-legacy`](../tieulinh-legacy) và là ví dụ mẫu cho một bot thật: file ở đây chỉ chứa nghiệp vụ và khai báo, thứ gì dùng chung được đã nằm ở `packages/core`. Nửa **lễ tân** (nhận sự cố qua chat, tạo ticket) chưa làm.

Tiểu Linh 2 (TL2) chạy trên dự án `tech.TECH2` với agent `tieulinh2`; chạy thật sẽ đổi sang `tech.TECH` bằng env, không sửa code. Tài liệu đầy đủ (tiếng Việt): [Tiểu Linh mới: hậu cần](../../docs/explanation/tieulinh-hau-can.md), [Chạy Tiểu Linh 2](../../docs/how-to/run-tieulinh-hau-can.md), [biến môi trường](../../docs/reference/config-env.md).

## Bot làm gì

| Sự kiện | Handler | Hành vi |
|---|---|---|
| Ai đó `@tieulinh2` trên ticket | `mention.ts` | Chuyển lời nhắn về người báo qua kênh; LLM (chỉ đọc: `get_issue`, `get_comments`, `search_issues`) trả lời trên ticket, đúng luồng comment. |
| `issue.state_changed` | `closure` (core `TicketClosure`) | Sang Resolved: báo người báo kèm nút "Đã ổn". Sang Done/Canceled/mở lại: báo và gỡ nút cũ. Bot **không bao giờ** chuyển cột. |
| `comment.created` | `forward.ts` | Comment của người xử lý tới người báo (`all` hoặc `mention`; bỏ `#noibo`, bỏ comment của bot). |
| `comment.created` nhắc mã ticket anh em | `duplicates.ts` | LLM phán có phải tuyên bố trùng không; mặc định để một comment gợi ý. `TIEULINH_DUPLICATE_MERGE=true` bật gộp kiểu legacy. |
| Cron `TIEULINH_SLA_CRON` | `sla.ts` | Ticket chưa giao, chưa bắt đầu, quá hạn theo ưu tiên (1/2/4/24 giờ) thì báo trực ca, mỗi ticket một lần. |

Kênh gửi tin: có `TELEGRAM_BOT_TOKEN` thì Telegram thật, không có thì nhật ký JSONL `BOT_DATA_DIR/tieulinh-channel.jsonl` (mode 0600). TL2 chạy chỉ với kênh nhật ký.

## Chạy

```bash
export ITSAPLAN_BASE_URL=https://itsaplan.example.com ITSAPLAN_AGENT_KEY=...   # key của agent tieulinh2
export BOT_DATA_DIR=/var/lib/tieulinh2
export LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=...                          # MiniMax qua proxy
export BOT_WEBHOOK_PORT=3110 ITSAPLAN_WEBHOOK_SECRET=whsec_...                 # luật chạy trên webhook
bun run apps/tieulinh/main.ts
```

Test không cần mạng: `bun run --cwd apps/tieulinh test` (itsaplan giả, LLM giả, đồng hồ giả).

## Cấu trúc

| File | Vai trò |
|---|---|
| `bot.ts` | `tieulinhBot(env)`: khai báo `defineBot` (tracker, agent, handler, luật, lịch, `reporter`). |
| `env.ts` | Env riêng của app (`defineEnv`). |
| `services.ts` | Kho SQLite của app (`tieulinh-app.sqlite`), chọn kênh, `TicketClosure`, dispatcher. |
| `mention.ts`, `forward.ts`, `duplicates.ts`, `sla.ts`, `reporter.ts` | Từng nghiệp vụ. |
| `copy.ts` | Mọi câu tiếng Việt gửi người báo. Logic không chứa chuỗi hiển thị. |
| `*.test.ts`, `testkit.ts` | Kịch bản với `FakeItsaplan` + `FakeLlm`; `parity.test.ts` là bảng đối chiếu test legacy. |

## Quyết định bám theo (ADR của Tiểu Linh)

- **0001** một worker một dự án: tracker khoá theo `tech.TECH2`, sự kiện dự án khác bị bỏ.
- **0006** chỉ người xử lý đóng ticket: không có tự đóng; nút "Đã ổn" chỉ ghi một comment. (Gộp ticket trùng là ngoại lệ có cờ, mặc định TẮT, vì nó huỷ ticket.)
- **0007** ticket tương tự chỉ học từ người: "liên quan" ở đây là kết quả tìm văn bản dùng để gợi ý, không phải kết luận.
- **0008** thao tác ghi từ chat cần xác nhận: bot không tạo/sửa ticket từ chat (lễ tân chưa làm).
- **0010** mô tả ticket là nguyên văn người báo: bot không sửa mô tả; khi gộp, mô tả được chép nguyên văn.

## Lệch so với legacy (cố ý)

- **Phát hiện trùng theo comment, không theo lúc tạo ticket**: giữ đúng tín hiệu của legacy (người xử lý nhắc mã ticket anh em). Dò lúc tạo cần truy hồi ticket liên quan (KG/Onyx), nằm ngoài phạm vi. LLM phải trả `evidence` là đoạn trích có thật trong comment, không thì coi như không trùng.
- **SLA quét không trạng thái**, không còn bảng `sla_trackers`; chỉ tính ticket tạo sau lần đầu app khởi tạo (`sla:since`) để lần chạy đầu không xả cảnh báo cho kho ticket cũ.
- **`backoffice.reporter`** (`reporter.ts`): ticket đã liên kết chat thì người comment trên itsaplan không phải người báo; chưa liên kết thì coi mọi người là người báo (thận trọng). Hiện chưa luật nào dùng (ADR-0006 cấm `closeAfter`), giữ làm điểm cắm.

## Việc để lại (follow-up)

- Nhận tin vào: nút "Đã ổn" bấm trên Telegram, người báo trả lời tự do vào tin thông báo (`TicketClosure.recordReporterOk`, `ReplyRouter` đã có ở core, chờ kênh vào của lễ tân).
- Lễ tân (`defineBot({ receptionist })`): tạo ticket, ghi liên kết người báo vào kho (hiện chỉ test và chế độ sandbox ghi).
- KG/Onyx/Memgraph (nạp tri thức khi ticket hoàn tất), `related-curator` và ticket tương tự, ingest.
- Gửi media thật qua Telegram (hiện ảnh nối vào văn bản), viết lại URL ảnh, tách video.
- Phát hiện trùng lúc tạo ticket (cần truy hồi liên quan).
