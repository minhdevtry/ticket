# Đặc tả: PR 17 của RFC 0002 — runbook shadow, canary và hoàn nguyên lễ tân (issue #31)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 17 — **PR cuối cùng** của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #31.

PR 1-16 đã merge vào `main` (toàn bộ mã nguồn, cấu hình defineBot, MCP server, skill pack, OpenClaw adapter và 326 test ported đã nằm trong core và app).
Mục tiêu của PR 17: **chuẩn bị hạ tầng deploy, script vận hành và bộ tài liệu runbook hoàn chỉnh** cho giai đoạn shadow canary và hoàn nguyên an toàn, đóng lại toàn bộ milestone RFC 0002.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `docs/rfc/0002-receptionist.md` mục 5 (hàng PR 17), mục 6 (canary & rollout), mục 8 (chỉ số sẵn sàng).
- `deploy/colab/cup-tieulinh.sh` — script deploy hiện tại cho hậu cần trên Colab.
- `tools/tl2-shadow/colab/tieulinh-run.ts` — runner Colab của Tiểu Linh 2.
- `docs/how-to/shadow-tl2.md`, `docs/how-to/deploy.md`, `docs/how-to/run-tieulinh-hau-can.md`.

---

## Target

1. **Mở rộng script `deploy/colab/cup-tieulinh.sh`:**
   - Bổ sung tuỳ chọn `--role <all|backoffice|receptionist>` (mặc định giữ `backoffice` hoặc `all` để tương thích ngược).
   - Khi `--role receptionist` hoặc `--role all`: thiết lập môi trường và cấu hình OpenClaw/MCP server lễ tân đã dựng ở PR 15 & 16.
   - Thêm lệnh kiểm tra trạng thái và log cho từng role (`status`, `stop`).
   - Đảm bảo an toàn bảo mật: kiểm tra bộ lọc archive không chứa secret, SSH proxy an toàn qua máy dev.

2. **Soạn thảo Runbook Canary & Hoàn nguyên (`docs/how-to/receptionist-canary-rollback.md`):**
   - Viết bằng tiếng Việt chuẩn mực theo phong cách kỹ thuật của repo.
   - **Mục tiêu & Nguyên tắc**:
     - Tiểu Linh 1 vẫn phục vụ 100% production.
     - Tiểu Linh 2 chạy shadow trên Colab/dev, tuyệt đối không gửi tin nhắn Telegram ra người dùng thật trừ khi nằm trong danh sách canary đã duyệt.
   - **Quy trình Canary theo Chat ID (`CANARY_CHATS`)**:
     - Cấu hình plugin `shadow-forwarder` trên gateway OpenClaw prod.
     - Khai báo danh sách chat thử nghiệm nội bộ (nhóm kỹ thuật dev, QA).
     - Cách thức định tuyến: chat thường chỉ ghi log shadow so sánh; chat canary mới được bật tương tác 2 chiều.
   - **Kịch bản Hoàn nguyên Khẩn cấp (< 1 phút)**:
     - Các tình huống kích hoạt hoàn nguyên (Trigger conditions): model trả 500 liên tiếp, bot gửi sai tin nhắn, telegram token lỗi, người dùng báo sự cố nghiêm trọng.
     - Lệnh hạ cờ tức thì: chuyển cờ canary về 0 hoặc tắt plugin `shadow-forwarder` trên gateway.
     - Lệnh dừng an toàn trên Colab: `deploy/colab/cup-tieulinh.sh stop`.
     - Quy trình kiểm tra xác nhận sau hoàn nguyên (Verification checklist).
   - **Xử lý sự cố thường gặp (Troubleshooting)**:
     - Colab bị thu hồi / rớt SSH tunnel: cách dựng lại tunnel trong 30s.
     - Quota LLM / rate limit: fallback model ID.
     - Lệch dữ liệu binding giữa TL1 và TL2: xử lý file binding chia sẻ.

3. **Cập nhật Chỉ mục Tài liệu (`docs/how-to/index.md` & VitePress config):**
   - Thêm liên kết tới `receptionist-canary-rollback.md` trong `docs/how-to/index.md`.
   - Cập nhật sidebar nếu cần trong `docs/.vitepress/config.mts`.

4. **Sổ đối chiếu & Tài liệu (`ENGINE.md`, `CHANGELOG.md`):**
   - PR 17 không port thêm test legacy nào (sổ giữ nguyên: `total=450 core=61 ported=326 deferred=52 by-design=11`).
   - Cập nhật `packages/core/CHANGELOG.md` hoặc changelog repo ghi nhận PR 17 và hoàn thành chuỗi di trú RFC 0002.

---

## Non-goals

- KHÔNG kích hoạt canary thật trên bot production (đây là script và runbook hướng dẫn, việc kích hoạt thật do người vận hành thực hiện khi nghiệm thu).
- KHÔNG thay đổi logic của `packages/core/src/intake` hay `apps/tieulinh`.
- KHÔNG làm lộ bất kỳ token hay secret nào trong tài liệu hoặc script.

---

## Constraints & Forbidden

- Tuân thủ `SECURITY.md`: không ghi token, password, IP nội bộ vào tài liệu hoặc script.
- Bắt buộc `bun run scan` sạch.
- Bắt buộc `bun run docs:check` sạch (snippets, refs, dead-links).
- Bắt buộc `bun run verify` sạch.

---

## Observable Acceptance

1. `deploy/colab/cup-tieulinh.sh --help` hiển thị tuỳ chọn role cho lễ tân.
2. `docs/how-to/receptionist-canary-rollback.md` đầy đủ các mục (nguyên tắc, cấu hình canary, kịch bản hoàn nguyên, xử lý sự cố).
3. `bun run docs:check` sạch 100%.
4. `bun run scan` sạch 100%.
5. `bun run verify` sạch 100%.
6. Báo cáo thực hiện tại `orchestration/report-31.md`.
