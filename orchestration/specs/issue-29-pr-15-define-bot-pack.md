# Đặc tả: PR 15 của RFC 0002 — defineBot lễ tân thành pack MCP và skill (issue #29)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 15 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #29.

PR 1-14 đã merge vào `main` (PR 14 = dữ liệu domain + chữ + định dạng ticket của app
Tiểu Linh). Còn PR 15 (đây), PR 16 (adapter OpenClaw), PR 17 (runbook deploy).

Mục tiêu của PR 15: **gom phần khai báo của lễ tân về một chỗ** — một khai báo vừa là bot, vừa
là bộ tool MCP, vừa là gói skill, để app không phải tự viết lại ở nhiều nơi.

Cụ thể:
- Thay `unknown` bằng kiểu cụ thể trong `ReceptionistDefinition` (`catalog`, `priorityRules`,
  `extractor` hiện là `unknown`).
- `defineBot` **kiểm catalog và chính sách** — gom lỗi khai báo về một chỗ.
- Dựng bộ **tool MCP của lễ tân** (`intake_step`, tra cứu, định danh) từ khai báo, bằng
  `createIntakeMcpServer` (đã có ở `packages/core/src/core/mcp-server.ts`).
- Xuất **gói skill** (persona, hướng dẫn, tin tĩnh) từ khai báo + `CopyCatalog`.
- Bỏ cảnh báo `"declared-not-running"`.
- Bỏ hoặc đánh dấu không dùng `ReceptionistDefinition.channels`.
- `createBot` giữ vai trò **worker hậu cần** (không phải lễ tân).

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md`.
- `docs/rfc/0002-receptionist.md` mục 1.4 (hàng 15), mục 2.1-2.4, mục 5 (hàng PR 15), mục 7
  (cấu trúc gói skill).
- `packages/core/src/bot/define.ts` và `create.ts` — nền hiện có.

---

## Nguồn legacy (bản tham chiếu đóng băng — CHỈ ĐỌC)

- `apps/tieulinh-legacy/**/define.test.ts`, `create.test.ts` — bộ test định nghĩa bot.
- `apps/tieulinh-legacy/**/intake-step.test.ts` (1 ca) — bước intake trong gói skill.
- `apps/tieulinh-legacy/skills/tieulinh/` — cấu trúc gói skill (persona, hướng dẫn, tin tĩnh).

---

## Target

1. **`packages/core/src/bot/define.ts`:**
   - `ReceptionistDefinition.catalog` / `.priorityRules` / `.extractor`: đổi `unknown` → kiểu cụ
     thể từ `packages/core/src/intake/` (`Catalog`, `UrgencyRules`, `FieldExtractorPort`).
   - `defineBot` **kiểm tra khai báo**: catalog hợp lệ (field bắt buộc, mộtOf), luật ưu tiên hợp
     lệ, chính sách soát hợp lệ — **gom lỗi về một chỗ** và ném `BotDefinitionError` kèm danh
     sách lỗi (dùng cơ chế `BotDefinitionIssue` sẵn có).
   - Bỏ cảnh báo `"declared-not-running"`.
   - `ReceptionistDefinition.channels`: bỏ hoặc đánh dấu không dùng — quyết định thuộc chủ.

2. **Bộ tool MCP của lễ tân** (`packages/core/src/intake/mcp/` hoặc chỗ đã có sẵn — grep trước):
   - `intake_step` — chạy một lượt của engine.
   - tra cứu — tra cứu ticket.
   - định danh — định danh người báo.
   - Dựng từ khai báo bằng `createIntakeMcpServer` (`packages/core/src/core/mcp-server.ts`).
   - **Mọi lỗi tool phải trả về kết quả BÌNH THƯƠNG kèm cờ `loi: true`** — không ném lên host
     (xem `describeToolFailure` trong `mcp-server.ts`).

3. **Gói skill** (xuất từ khai báo + `CopyCatalog`):
   - Cấu trúc thư mục đúng như `apps/tieulinh-legacy/skills/tieulinh/`: persona, hướng dẫn, tin
     tĩnh.
   - Chữ lấy từ `CopyCatalog` — không sinh lại ở chỗ khác.

4. **`packages/core/src/bot/create.ts`:** `createBot` giữ vai trò **worker hậu cần** — không phải
   lễ tân. Ghi rõ bằng comment + tài liệu.

5. **Kiểm thử:**
   - Port/mở rộng: `define.test.ts`, `create.test.ts`, `intake-step.test.ts` (1 ca).
   - MCP server lễ tân: **liệt kê đúng tool** và **gọi được qua stdio VÀ HTTP** bằng client MCP
     trần trong test — **không mạng thật**.
   - Gói skill sinh ra đúng cấu trúc thư mục.
   - Cập nhật sổ đối chiếu + `ENGINE.md` nếu có dòng liên quan.
   - `packages/core/CHANGELOG.md`; `docs/` nếu đổi API công khai.

---

## Ranh giới

- **Chỉ sửa trong `packages/core/`, `apps/tieulinh/` và `docs/`.**
- **`apps/tieulinh-legacy/**` chỉ đọc** — không sửa, không import code legacy vào app mới.
- Không đụng `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `bun.lock`.
- Không tự tạo/sửa/đóng issue. Không commit, không push (coordinator làm).

## Cần chủ quyết (ghi vào báo cáo, không tự quyết)

- **`ReceptionistDefinition.channels`**: bỏ hẳn hay giới hạn "không dùng"? (Bỏ là đổi API
  công khai; giữ thì cần ghi rõ phạm vi dùng.)
- **Tên và phạm vi gói skill**: tên thư mục (`skills/<tên-bot>/`), và ai chịu trách nhiệm đồng bộ
  gói skill với `CopyCatalog` khi copy đổi (PR 16 sẽ đồng bộ workspace OpenClaw — cần thống
  nhất ranh giới với PR 16 để không làm hai bên cùng sửa một chỗ).
- **`intake_step` qua MCP có trả kết quả `StepOutput` thô hay đã diễn giải cho model?** Legacy
  dùng gì?
