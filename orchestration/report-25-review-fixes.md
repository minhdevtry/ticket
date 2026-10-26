# Báo cáo: Vòng sửa Review PR 11 — Ticket Commands (Issue #25)

**Worker**: Dispatched Worker (`task_e228f585d435`, dispatch `ctx_5753b84915af`)  
**Mục tiêu**: Xử lý toàn bộ các finding từ hai báo cáo review độc lập (`orchestration/report-25-review-standards.md` và `orchestration/report-25-review-spec.md`) cho PR #58 (nhánh `minhdevtry/feat-pr-11-ticket-commands`, issue #25).  
**Nguyên tắc**: Không đổi hành vi nghiệp vụ, đầu ra tiếng Việt của Tiểu Linh giữ nguyên từng byte, không commit/push.

---

## 1. Chi tiết khắc phục theo từng Finding

### 1.1. HIGH (A1) — `filesNote` hardcode trong bản xem trước `append`
- **Vị trí**: `packages/core/src/intake/engine/engine.ts:1718-1720`
- **Xử lý**: Thay thế chuỗi hardcode ` (kèm ${mediaPaths.length} ảnh/tệp)` bằng:
  ```ts
  const filesNote =
    mediaPaths.length > 0
      ? deps.copy.text("action.suggest_append_media_note", { count: mediaPaths.length }).trim()
      : "";
  ```
- **Kết quả**: Thống nhất 100% với luồng `suggest` (dòng 1664) và `suggest_unclear` (dòng 1910). Câu chữ hoàn toàn qua `CopyCatalog`.

### 1.2. MEDIUM (A2) — Tên bot mặc định `"Tiểu Linh"` trong Core Engine
- **Vị trí**: `packages/core/src/intake/engine/engine.ts:2318` & `packages/core/src/intake/ports.ts`
- **Xử lý**:
  - Bổ sung `CopyKey`: `"bot.default_name"`.
  - Cấu hình trong `examples/tieulinh/copy.ts`: `"bot.default_name": "Tiểu Linh"`.
  - Cấu hình trong `test-copy.fixture.ts`: `"bot.default_name": "Bot"`.
  - Trong `engine.ts`: chuyển sang `const botName = deps.botName ?? deps.copy.text("bot.default_name");`.
  - Thay thế fixture `*Nguồn: Tiểu Linh*` trong `edit.test.ts` thành `*Nguồn: Bot*`.
- **Kết quả**: Không còn chuỗi `"Tiểu Linh"` hardcode trong `packages/core/src/intake/engine/`. App Tiểu Linh giữ nguyên output qua cấu hình hoặc `CopyCatalog`.

### 1.3. MEDIUM (A3) — Nhãn thay đổi `"Tiêu đề"`, `"Mô tả"`, và `"(chưa có)"` trong `edit.ts`
- **Vị trí**: `packages/core/src/intake/engine/edit.ts` & `engine.ts`
- **Xử lý**:
  - Khai báo giao diện `EditLabels`:
    ```ts
    export interface EditLabels {
      title?: string;
      description?: string;
      notPresent?: string;
    }
    ```
  - Bổ sung 3 `CopyKey` tương ứng: `"edit.title_label"`, `"edit.description_label"`, `"edit.not_present"`.
  - `applyEditOps` nhận tham số `labels?: EditLabels`, mặc định dùng nhãn trung lập tiếng Anh (`"Title"`, `"Description"`, `"(none)"`).
  - Trong `engine.ts` (dòng 1541), engine truyền nhãn từ `CopyCatalog` (`deps.copy.text("edit.title_label")`,...).
  - Thêm test kiểm chứng `applyEditOps` cả khi nhận nhãn tuỳ biến lẫn khi dùng nhãn mặc định trung lập.
- **Kết quả**: Loại bỏ toàn bộ literal tiếng Việt gửi người dùng trong `edit.ts`.

### 1.4. MEDIUM (A4) — Trùng lặp helper `withTimeout` (Single Source of Truth)
- **Vị trí**: `packages/core/src/intake/engine/timeout.ts` (mới)
- **Xử lý**:
  - Tách `withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>` sang module dùng chung `timeout.ts`.
  - Xoá bỏ định nghĩa trùng lặp ở cả `command-interpreter.ts` và `edit.ts`, import từ `./timeout`.
  - Re-export qua `packages/core/src/intake/engine/index.ts`.
  - Bổ sung test suite `timeout.test.ts` (2 ca test).
- **Kết quả**: Đảm bảo Single Source of Truth, không còn copy-paste.

### 1.5. MEDIUM (A5 / B3) — Bổ sung test kiểm nền khi sửa (`action.edit_conflict_rejected`)
- **Vị trí**: `packages/core/src/intake/engine/pr11-ticket-commands.test.ts`
- **Xử lý**: Thêm ca test tự động:
  1. Người báo gửi lệnh sửa ticket `TECHTEST-795` → nhận bản xem trước `confirm_ticket_action`.
  2. Kỹ thuật viên cập nhật mô tả trên tracker mock trong lúc người báo chờ bấm nút.
  3. Người báo bấm xác nhận sửa (`✅ Sửa TECHTEST-795`).
  4. Assert: trả về `outcome: "action_done"`, thông báo chứa `cập nhật sau khi em lập bản sửa` (`action.edit_conflict_rejected`), `it$.calls.updateIssue` không bị gọi (không ghi đè dữ liệu), pending action được dọn sạch.
- **Kết quả**: Khẳng định bất biến an toàn Optimistic Concurrency Check (D5 / ADR-0008).

### 1.6. MEDIUM (B1) — `checkIssueClosed` fallback thiếu `columns`
- **Vị trí**: `packages/core/src/intake/engine/engine.ts:2540-2542` & dòng 2562-2569
- **Xử lý**:
  - Trong `checkIssueClosed`: khi fallback sang `deps.tracker.getIssue`, nạp thêm danh sách cột qua `deps.tracker.listProjectColumns?.(deps.identifierPrefix)` và truyền `isIssueClosed(issue, columns)`.
  - Trong `resolveClosedStatusLabel`: bổ sung đối chiếu cột qua `listProjectColumns` để nhận diện chính xác trạng thái hủy/hoàn tất khi `stateType` chưa có.
  - Thêm test tự động trong `pr11-ticket-commands.test.ts`: Tracker tùy biến chỉ có `getIssue` + `listProjectColumns` (cột Done) → lệnh bổ sung ticket đã đóng trả về `closed_refusal` (`post_create_update`), thông báo từ chối lịch sự kèm trạng thái `Hoàn tất (Done)`.
- **Kết quả**: Ngăn chặn hoàn toàn việc cho phép bổ sung vào ticket đã đóng trên tracker tùy biến.

### 1.7. LOW (A6) — Trạng thái fallback `"chưa rõ"`
- **Vị trí**: `packages/core/src/intake/engine/engine.ts:1462`
- **Xử lý**:
  - Bổ sung `CopyKey`: `"status.unknown"`.
  - Trong `examples/tieulinh/copy.ts`: `"status.unknown": "chưa rõ"`.
  - Trong `test-copy.fixture.ts`: `"status.unknown": "unknown"`.
  - Thay `column?.name ?? issue?.stateType ?? "chưa rõ"` bằng `column?.name ?? issue?.stateType ?? deps.copy.text("status.unknown")`.
- **Kết quả**: Không còn hardcode chuỗi trạng thái trong engine.

### 1.8. LOW (A7) — Magic number `columnId ?? 9`
- **Vị trí**: `packages/core/src/intake/engine/engine.ts:164-165, 2332`
- **Xử lý**:
  - Bổ sung tuỳ chọn `defaultCanceledColumnId?: number` vào `IntakeEngineDeps`.
  - Tại `executeConfirmedTicketAction`: `const targetColumnId = canceledCol?.id ?? deps.defaultCanceledColumnId;`. Nếu không tìm thấy cột canceled và không cấu hình `defaultCanceledColumnId`, bỏ qua bước chuyển cột, không ghi đè mù quáng.
- **Kết quả**: Không còn magic number `9` trong core engine.

### 1.9. LOW (A8) — Prompt LLM chưa override được
- **Vị trí**: `command-interpreter.ts` và `edit.ts`
- **Xử lý**:
  - Khai báo `LlmTicketCommandInterpreterOptions` (`timeoutMs?: number; systemPrompt?: string;`). Cho phép constructor nhận options object hoặc `timeoutMs: number`.
  - Khai báo `PlanEditOptions` (`timeoutMs?: number; editPrompt?: string;`). Cho phép `planEdit` nhận options object hoặc `timeoutMs: number`.
  - Bổ sung test tự động kiểm chứng việc override prompt cho cả hai module.
- **Kết quả**: Khả năng tái sử dụng core cho các ngôn ngữ và bot khác mà không phá vỡ tương thích ngược.

### 1.10. LOW (B2) — Cơ chế `move_created` trong đường lùi không LLM
- **Ghi chú kiến trúc**: By-design theo RFC 0002. Việc phân giải đại từ chỉ định ("cái này", "cái vừa tạo") đòi hỏi hiểu ngữ cảnh tự nhiên của LLM. Khi không có LLM, engine coi tin là `append` và sinh bản xem trước kèm trích đoạn nội dung, yêu cầu người báo bấm nút xác nhận nên hoàn toàn không gây ghi ngầm hay mất an toàn dữ liệu.

---

## 2. Danh sách tệp thay đổi (Files Modified)

| STT | Tệp thay đổi | Nội dung thay đổi |
|---|---|---|
| 1 | `packages/core/src/intake/engine/timeout.ts` | **(Mới)** Helper `withTimeout` dùng chung |
| 2 | `packages/core/src/intake/engine/timeout.test.ts` | **(Mới)** Test unit cho `withTimeout` |
| 3 | `packages/core/src/intake/engine/index.ts` | Re-export `timeout.ts` |
| 4 | `packages/core/src/intake/ports.ts` | Bổ sung 5 `CopyKey`: `bot.default_name`, `edit.title_label`, `edit.description_label`, `edit.not_present`, `status.unknown` |
| 5 | `packages/core/examples/tieulinh/copy.ts` | Cung cấp câu chữ tiếng Việt Tiểu Linh cho 5 key mới |
| 6 | `packages/core/src/intake/engine/test-copy.fixture.ts` | Cung cấp câu chữ tiếng Anh trung lập cho 5 key mới |
| 7 | `packages/core/src/intake/engine/edit.ts` | Dùng `withTimeout`, `PlanEditOptions`, `EditLabels`, bỏ hardcode nhãn tiếng Việt |
| 8 | `packages/core/src/intake/engine/edit.test.ts` | Đổi fixture trung lập `*Nguồn: Bot*`, test `EditLabels` và `editPrompt` override |
| 9 | `packages/core/src/intake/engine/command-interpreter.ts` | Dùng `withTimeout`, `LlmTicketCommandInterpreterOptions`, cho phép override `systemPrompt` |
| 10 | `packages/core/src/intake/engine/engine.ts` | Fix A1 (`filesNote`), A2 (`botName`), A6 (`status.unknown`), A7 (`defaultCanceledColumnId`), B1 (`checkIssueClosed` columns) |
| 11 | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` | Thêm 3 ca test: kiểm nền xung đột, fallback cột đóng, prompt override |
| 12 | `packages/core/CHANGELOG.md` | Ghi nhận chi tiết các mục sửa review A1-A8, B1-B3 |

*Tuyệt đối không chạm các file cấm: `apps/tieulinh-legacy/**`, `.github/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.*

---

## 3. Bảng lệnh và kết quả thực tế (Evidence)

Chạy trên môi trường Linux x64 tại worktree `feat-pr-11-ticket-commands`:

| STT | Lệnh kiểm thử | Kết quả thực tế | Đánh giá |
|---|---|---|---|
| 1 | `bun run lint:baseline` | `noNonNullAssertion: 416/418`, `noExplicitAny: 780/780` (Số lỗi không tăng) | **PASS** |
| 2 | `bun test packages/core/src/intake/engine/text.test.ts` | **5 pass**, 0 fail (28 expect() calls) | **PASS** |
| 3 | `bun test packages/core/src/intake/engine/edit.test.ts` | **5 pass**, 0 fail (14 expect() calls) | **PASS** |
| 4 | `bun test packages/core/src/intake/engine/pr11-ticket-commands.test.ts` | **19 pass**, 0 fail (92 expect() calls) | **PASS** |
| 5 | `bun test packages/core/src/intake/engine/ownership-confirm.test.ts` | **6 pass**, 0 fail (31 expect() calls) | **PASS** |
| 6 | `bun test apps/tieulinh/receptionist-gap-register.test.ts` | **9 pass**, 0 fail (1241 expect() calls) | **PASS** |
| 7 | `bun test packages/core/src/intake/engine/timeout.test.ts` | **2 pass**, 0 fail (2 expect() calls) | **PASS** |
| 8 | `bun run --cwd packages/core test` | **1420 pass**, 0 fail (9722 expect() calls trên 114 files) | **PASS** |

### Bằng chứng bổ sung:
1. **Kiểm tra literal tiếng Việt gửi người dùng**:
   ```bash
   grep -n -E '["'\''"][^"'\''"]*[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ][^"'\''"]*["'\''"]' \
     packages/core/src/intake/engine/engine.ts packages/core/src/intake/engine/edit.ts packages/core/src/intake/engine/command-interpreter.ts
   ```
   - Trong `engine.ts`: **0** chuỗi tiếng Việt ngoài comment.
   - Trong `edit.ts`: **0** chuỗi gửi người dùng (chỉ còn markdown header nội bộ của ticket `## Thông tin sự cố` / `### Mô tả` và `EDIT_PROMPT` gửi LLM).
   - Trong `command-interpreter.ts`: **0** chuỗi gửi người dùng (chỉ còn prompt LLM nội bộ `SYSTEM_PROMPT` và `userPrompt`).

2. **Kiểm tra định danh `"Tiểu Linh"` trong `packages/core/src/intake/engine/`**:
   ```bash
   grep -rn "Tiểu Linh" packages/core/src/intake/engine/edit.ts packages/core/src/intake/engine/engine.ts \
     packages/core/src/intake/engine/command-interpreter.ts packages/core/src/intake/engine/edit.test.ts \
     packages/core/src/intake/engine/pr11-ticket-commands.test.ts packages/core/src/intake/engine/timeout.ts
   ```
   - Kết quả: **0 matches found**.

---

## 4. Kết luận

Toàn bộ các phát hiện ở cả 2 báo cáo review độc lập đã được sửa đổi triệt để. Hệ thống bảo toàn 100% các bất biến an toàn cốt lõi, không thay đổi hành vi nghiệp vụ, đầu ra tiếng Việt của Tiểu Linh giữ nguyên từng byte, test suite đạt 1420/1420 pass, linter baseline sạch sẽ.
