# Đặc tả: PR 16 của RFC 0002 — adapter OpenClaw cho pack lễ tân (issue #30)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 16 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #30.

PR 1-15 đã merge vào `main` (PR 15 = đóng gói defineBot thành pack MCP và skill).
Còn PR 16 (đây: adapter OpenClaw cho pack lễ tân) và PR 17 (runbook deploy).

Mục tiêu của PR 16: **kết nối pack lễ tân của core vào harness OpenClaw** mà không phải viết lại plugin OpenClaw. Cung cấp adapter để cấu hình OpenClaw (`openclaw.json`), đồng bộ workspace (skill, persona), chuyển giao nút Telegram qua file chờ, hỗ trợ cờ `forceNew` khi người dùng bấm `/new`, và kiểm chứng hợp đồng chặt chẽ với hai plugin legacy `iris-tuong-tac` và `xac-nhan-xong`.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md`.
- `docs/rfc/0002-receptionist.md` mục 1.5 (các dòng H1, H2, K1-K5), mục 2, mục 5 (hàng PR 16).
- `packages/core/src/openclaw/` (đã có: `pending-buttons.ts`, `deploy.ts`, `identity-token.ts`, `agent-gating.ts`, `context-injection.ts`).
- `packages/core/src/intake/mcp/` (đã xong ở PR 15: `server.ts`, `skill-pack.ts`, `intake-step.ts`, `identity-tools.ts`).

---

## Nguồn legacy (bản tham chiếu đóng băng — CHỈ ĐỌC)

- `apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac/` (`index.mjs`, `index.test.mjs` — 12 ca test).
- `apps/tieulinh-legacy/openclaw-plugin/xac-nhan-xong/` (`index.mjs`, `index.test.mjs` — 33 ca test).
- `apps/tieulinh-legacy/lib/telegram/buttons.ts` và `buttons.test.ts`.
- `apps/tieulinh-legacy/mcp/shared/tools/confirmation-and-binding.test.ts`.

---

## Target

1. **Adapter OpenClaw cho lễ tân (`packages/core/src/openclaw/receptionist-adapter.ts` và xuất tại `index.ts`):**
   - **Sinh mảnh cấu hình `openclaw.json` (`generateReceptionistOpenClawConfig`)**:
     - Khai báo MCP server (lệnh khởi chạy MCP server lễ tân `createReceptionistMcpServer`).
     - Khai báo agent lễ tân (`tieulinh` hoặc tuỳ biến qua options), model, prompt/skills.
     - Khai báo plugin `iris-tuong-tac` và `xac-nhan-xong`.
   - **Đồng bộ Workspace (`syncReceptionistWorkspace`)**:
     - Lắp ráp với `exportSkillPack` từ PR 15, dùng `planWorkspaceSync` để ghi các file skill, persona, messages vào thư mục workspace OpenClaw được chỉ định.
   - **Cầu nối file nút chờ (`connectPendingButtons`)**:
     - Kết nối kết quả của `intake_step` hoặc `checkRequiredFields`/`checkIdentity` với file nút chờ Telegram qua `savePendingButtons`/`readPendingButtons`/`clearPendingButtons` (thư mục do options cấu hình, an toàn khi chạy song song theo chatId).
   - **Định danh qua `identityTools`**:
     - Chuyển tiếp session/chatId vào `check_identity` / `register_identity`.
   - **Cờ `forceNew` cho `/new`**:
     - Adapter nối với `ForceNewHandler` (trong `packages/core/src/itsaplan/webhook/server.ts` hoặc `backoffice.inbound.forceNew`) để khi plugin `xac-nhan-xong` bắt `/new` và gọi webhook, cờ `forceNew` được ghi nhận cho chat session.

2. **Kiểm hợp đồng với Plugin Legacy (`packages/core/src/openclaw/openclaw-adapter.test.ts`):**
   - Import trực tiếp các hàm xuất ra từ plugin legacy:
     - Từ `apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac/index.mjs`: `choPhepNutTrenTinCoMa`, `laCallbackNoiBo`, `xuLyDebounceCallback`, `layAccountId`, `donDepVanBanKhiCoNut`.
     - Từ `apps/tieulinh-legacy/openclaw-plugin/xac-nhan-xong/index.mjs`: `docXacNhan`, `layChatId`, `layReplyToId`, `boPhongBiKenh`, `laLenhSuCoMoi`.
   - **Kiểm tra khớp chữ tóm tắt TL2**:
     - Tin tóm tắt hoặc tin xem trước do TL2 / `intake_step` sinh ra khi kiểm tra qua `choPhepNutTrenTinCoMa` phải trả về `true` (không được để đổi định dạng làm plugin hiểu nhầm là tin đã tạo xong khiến nút xác nhận biến mất — xem cảnh báo tại RFC 0002 dòng 491).
   - **Kiểm hợp đồng đầu ra `intake_step`**:
     - `action`, `buttonsShown`, `agentInstruction`. Khi action là `WAITS_FOR_USER`, mảng nút được đẩy qua file chờ và `agentInstruction` chỉ đạo model dừng lượt, không in mảng nút trong JSON gửi LLM.
   - **Kiểm chéo 45 ca test legacy**:
     - Chạy kiểm chéo 12 ca của `iris-tuong-tac` và 33 ca của `xac-nhan-xong` qua các hàm xuất của plugin.

3. **Port 7 ca test legacy từ `apps/tieulinh/receptionist-gap-register.test.ts`:**
   - `lib/intake-step/pipeline.flow.test.ts`:
     - `"tạo ticket: có binding, dọn bản nháp, nút xác nhận hiện lúc tóm tắt và bị xoá sau khi tạo"`
   - `mcp/shared/tools/confirmation-and-binding.test.ts`:
     - `"checkIdentity: lưu initialButtons vào file nút tạm khi user được duyệt và chưa có draft"`
     - `"checkRequiredFields: tự động lưu branch buttons và nhắc chọn nhánh khi thiếu variant"`
     - `"checkRequiredFields: đã đính nút thì thôi liệt kê lựa chọn trong câu hỏi"`
   - `lib/telegram/buttons.test.ts`:
     - `"dùng đúng chữ được truyền vào, callback_data cố định 'đúng rồi'"`
     - `"không tự bịa thêm hay bớt phòng ban nào so với danh sách truyền vào"`
     - `"trả về danh sách 3 nút nhánh chuẩn cho IRIS"`
   - Chuyển 7 dòng trên trong `apps/tieulinh/receptionist-gap-register.test.ts` từ `"deferred"` sang `"ported"`, trỏ tới bài test cụ thể trong `packages/core/src/openclaw/openclaw-adapter.test.ts` (hoặc test tương ứng).

4. **Sổ đối chiếu và Tài liệu (`ENGINE.md`, `CHANGELOG.md`):**
   - Cập nhật `packages/core/docs/parity/ENGINE.md`:
     - `total=450 core=61 ported=326 deferred=52 by-design=11`
     - Bảng `<!-- gap-register-deferred-by-pr -->`: hàng PR 16 thành `0`.
   - Cập nhật `packages/core/CHANGELOG.md` ghi nhận PR 16.

---

## Non-goals

- KHÔNG viết lại hai plugin `iris-tuong-tac` và `xac-nhan-xong` (giữ nguyên ở legacy, chỉ viết adapter và test hợp đồng).
- KHÔNG thực hiện deploy production hay chạy thử Colab thật (đó là việc của PR 17).
- KHÔNG sửa đổi các module ngoài phạm vi (`apps/tieulinh-legacy/**`, `.github/**`, `bun.lock`).

---

## Constraints & Forbidden

- Core không được hardcode text tiếng Việt gửi người dùng, không hardcode đường dẫn tuyệt đối máy cá nhân.
- Thư mục file nút chờ phải là tham số có thể cấu hình (không hardcode `~/.vhbot/`).
- Bắt buộc `bun run verify` sạch và `bun run docs:check` sạch.

---

## Observable Acceptance

1. `bun test packages/core/src/openclaw` xanh 100%.
2. `bun test apps/tieulinh/receptionist-gap-register.test.ts` xanh 9/9, số liệu khớp từng dòng:
   `total=450 core=61 ported=326 deferred=52 by-design=11`.
3. `bun run check` và `bun run scan` sạch.
4. `bun run docs:check` sạch.
5. Ghi báo cáo kết quả thực hiện vào `orchestration/report-30.md`.
