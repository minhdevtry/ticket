# Báo cáo: Vòng sửa review PR 10 (issue #24 / PR #56)

## 1. Đã làm gì (theo từng mục của đặc tả)

Đã giải quyết triệt để 100% findings từ hai báo cáo review (`report-24-review-standards.md`, `report-24-review-spec.md`) và đặc tả `issue-24-pr-10-review-fixes.md`:

### 1.1 HIGH — Bỏ toàn bộ chữ tiếng Việt gửi người dùng khỏi core
- **`closedTicketRefusalMessage`**: Thay toàn bộ 3 vị trí gọi trực tiếp `closedTicketRefusalMessage` trong `packages/core/src/intake/engine/engine.ts` bằng phương thức private dùng chung `buildClosedRefusal` gọi qua `deps.copy.text("ticket.closed_refusal", { identifier, statusLabel })`. Hàm `closedTicketRefusalMessage` trong `supplement-notifier.ts` được chuyển thành helper trung lập nhận template/CopyCatalog (fallback tiếng Anh trung lập), không tự sinh câu tiếng Việt.
- **Câu xin mô tả sự cố mới**: Bổ sung `CopyKey` `clarify.new_incident_prompt`. Tại `engine.ts` nhánh `saysNewIncident(text)` quá ngắn, gọi qua `deps.copy.text("clarify.new_incident_prompt")`. Cấu hình trong `tieuLinhCopy` giữ nguyên từng byte `"Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ."`.
- **Câu xem trước bổ sung**: Bổ sung các `CopyKey`: `action.suggest_append_preview`, `action.suggest_append_media_note`, `action.suggest_append_other_tickets`. Chuyển toàn bộ câu chữ ghép tiếng Việt ra `CopyCatalog`; `engine.ts` chỉ truyền dữ liệu thô (`lead`, `title`, `identifier`, `quoted`, `files`, `alternatives`, `newIncidentLabel`).
- **Nhãn ưu tiên & câu nâng mức**: Dùng các khoá `priority.level.*` có sẵn để lấy nhãn ưu tiên (`currentPrioLabel`, `reqPrioLabel`). Bổ sung `CopyKey` `action.priority_uplift` và dùng `deps.copy.text("action.priority_uplift", { from, to, reason })`.
- **Câu báo bổ sung thành công**: Chuyển literal cứng tại dòng `action_done` sang `deps.copy.text("action.done_append", { identifier })`. Cấu hình `tieuLinhCopy` bảo toàn nguyên văn câu phản hồi `"Em đã cập nhật bổ sung thông tin này vào ticket {identifier} cho anh/chị rồi nhé ạ!"`.
- **`resolveClosedStatusLabel`**: Bổ sung `CopyKey` `status.closed_done` (`"Hoàn tất (Done)"`) và `status.closed_canceled` (`"Đã hủy (Canceled)"`). `resolveClosedStatusLabel` phân giải trạng thái chuẩn và lấy nhãn hoàn toàn qua `deps.copy.text`.
- **Dữ liệu comment bổ sung**: Bổ sung `comment.supplement_default_content` và `reporter.default_name` để fallback nội dung comment và người báo không còn literal tiếng Việt trong `engine.ts`.
- **Cảnh báo trực ca**: Bổ sung `notify.on_call_supplement` trong `CopyKey`; `notifyOnCallSupplement` hỗ trợ `template` và `botName` do app cấu hình, loại bỏ tên bot cứng trong core.

### 1.2 MEDIUM — Bỏ tên bot cụ thể khỏi core
- Trong `packages/core/src/intake/notify/supplement-notifier.ts`: Thay thế các regex hardcode `tiểu linh`, `tieulinh`, `iris`, `onyx`, `bot-ticket-intake`, `bot-iris-intake`, `admin` bằng `DEFAULT_SYSTEM_ACTOR_RE` tổng quát (`/\b(?:bot|agent|ai-coder|ai-lead|ai-qa|coder\s*ai|lead\s*ai|qa\s*ai)\b|^admin$/i`).
- Mở rộng `ResolveMentionOptions` và `IntakeEngineDeps` với tuỳ chọn `ignoredActors?: string[] | RegExp` và `botName?: string`.
- Danh sách bot riêng của Tiểu Linh được định nghĩa tập trung tại `packages/core/examples/tieulinh/engine-config.ts` (`DEFAULT_TIEULINH_IGNORED_ACTORS`) và truyền vào `makeTieuLinhEngine`.
- Bổ sung 2 bài test trong `supplement-notifier.test.ts` chứng minh: khi app truyền `ignoredActors` thì tên bot riêng bị bỏ qua; khi không truyền thì core trung lập không tự động lọc các tên đó.

### 1.3 LOW 1 — Gộp luồng từ chối ticket đã đóng
- Trích xuất phương thức private `buildClosedRefusal(issueId, identifier, url?)` trên `IntakeEngine`, gộp 3 luồng lặp kiểm tra `isClosed -> resolveClosedStatusLabel -> return { outcome: "closed_refusal", messages: [...], issue: ... }` tại `routeExistingTicket`, `handlePostCreate`, và `resolvePendingAction`.

### 1.4 LOW 2 — Assert trực tiếp `res.outcome`
- Thêm `expect(res.outcome).toBe("closed_refusal")` trực tiếp tại 3 ca test ticket đã đóng trong `packages/core/src/intake/engine/pr10-post-create.test.ts`.

---

## 2. Danh sách file thay đổi

| File | Mục đích |
|---|---|
| `packages/core/src/intake/ports.ts` | Bổ sung các `CopyKey` mới cho `CopyCatalog` |
| `packages/core/src/intake/engine/engine.ts` | Gỡ toàn bộ literal tiếng Việt, gộp `buildClosedRefusal`, hỗ trợ `ignoredActors`/`botName` |
| `packages/core/src/intake/notify/supplement-notifier.ts` | Bỏ tên bot cụ thể khỏi regex, hỗ trợ `ignoredActors`, helper `closedTicketRefusalMessage` trung lập |
| `packages/core/examples/tieulinh/copy.ts` | Cung cấp câu chữ tiếng Việt cho tất cả các `CopyKey` mới của Tiểu Linh |
| `packages/core/examples/tieulinh/engine-config.ts` | Khai báo `DEFAULT_TIEULINH_IGNORED_ACTORS` và truyền `ignoredActors`/`botName` |
| `packages/core/src/intake/engine/test-copy.fixture.ts` | Bổ sung định nghĩa tiếng Anh/trung lập cho các `CopyKey` mới |
| `packages/core/src/intake/engine/pr10-post-create.test.ts` | Assert `res.outcome === "closed_refusal"`, thêm suite 5 test khẳng định byte-for-byte tiếng Việt |
| `packages/core/src/intake/notify/supplement-notifier.test.ts` | Cập nhật test `closedTicketRefusalMessage`, thêm 2 test `ignoredActors` |
| `packages/core/CHANGELOG.md` | Ghi nhận chi tiết các cải tiến review fixes theo chuẩn repo |

---

## 3. Bảng lệnh đã chạy và kết quả thực tế

| Lệnh | Mục đích | Kết quả thực tế | Trạng thái |
|---|---|---|---|
| `bun run lint` | Biome lint toàn repo | Exit 0. Không có diagnostic nào thuộc các file sửa đổi của PR 10. | PASS |
| `bun run lint:baseline` | Kiểm soát `noNonNullAssertion` và `noExplicitAny` | `noNonNullAssertion`: 416/418; `noExplicitAny`: 780/780. Không tăng lỗi. | PASS |
| `bun test packages/core/src/intake/notify/supplement-notifier.test.ts` | Test pure notify & mention target | 21 pass, 0 fail (51 expect() calls, 164ms) | PASS |
| `bun test packages/core/src/intake/engine/pr10-post-create.test.ts` | Test flow & notify sau tạo ticket | 23 pass, 0 fail (99 expect() calls, 185ms) | PASS |
| `bun test packages/core/src/intake/engine/engine.test.ts` | Test suite cơ sở của engine | 23 pass, 0 fail (57 expect() calls, 136ms) | PASS |
| `bun test apps/tieulinh/receptionist-gap-register.test.ts` | Sổ đối chiếu gap register 450 ca | 9 pass, 0 fail (1241 expect() calls, 17ms) | PASS |
| `bun run --cwd packages/core test` | Toàn bộ unit tests của `@vuihoc/bot-core` | 1383 pass, 0 fail (9555 expect() calls, 45.7s) | PASS |
| `bun run check` | Typecheck TypeScript toàn workspace | 4 packages (`bot-core`, `tl2-shadow`, `tieulinh`, `tieulinh-legacy`) Exit 0 sạch. | PASS |

---

## 4. Bằng chứng kiểm tra độc lập

### 4.1 Bằng chứng grep không còn cụm tiếng Việt gửi người dùng trong core
Chạy script kiểm tra tất cả các chuỗi có ký tự tiếng Việt nằm ngoài comment/JSDoc trong `engine.ts` và `supplement-notifier.ts`:
- Trong `engine.ts`: Chỉ còn duy nhất 1 regex dòng 1224 dùng phân tích lệnh gõ tay của người dùng:
  `/(?:bổ\s*sung|thêm|update|cập\s*nhật)\s+([A-Z0-9_]+-\d+)(?:\s*[:\-–]?\s*(.*))?$/iu`
  Hoàn toàn không còn chuỗi tiếng Việt gửi người dùng nào trong mã nguồn.
- Trong `supplement-notifier.ts`: Hoàn toàn không còn chuỗi giao diện người dùng tiếng Việt nào. Các chuỗi tiếng Việt còn lại chỉ gồm log nội bộ (`getLogger().warn`) và cú pháp đánh dấu bình luận kỹ thuật tracker (`markBotComment` cho Itsaplan timeline đã được kiểm chứng bởi test suite ported).

### 4.2 Bằng chứng bảo toàn từng byte đầu ra tiếng Việt của Tiểu Linh
Suite test mới trong `pr10-post-create.test.ts` (`Đầu ra tiếng Việt của Tiểu Linh qua CopyCatalog giữ nguyên từng byte (PR 10 review fixes)`):
1. `ticket.closed_refusal`:
   `"Dạ ticket TECH-104 hiện đã đóng ở trạng thái Hoàn tất (Done) trên hệ thống rồi nên không thể ghi bổ sung được nữa ạ. Nếu cần hỗ trợ sự cố mới, anh/chị vui lòng tạo ticket mới giúp em nhé ạ."` (Khớp 100%)
2. `clarify.new_incident_prompt`:
   `"Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ."` (Khớp 100%)
3. `action.suggest_append_preview`:
   `'Dạ tin này là bổ sung cho TECHTEST-100 «Sự cố 100» phải không ạ? Em sẽ ghi vào TECHTEST-100:\n\n> Học sinh dùng iPad\n(kèm 1 ảnh/tệp)\n\nAnh/chị bấm nút xác nhận để em ghi, hoặc "Sự cố mới" nếu là việc khác nhé.'` (Khớp 100%)
4. `action.priority_uplift`:
   `"⏫ Nâng mức ưu tiên Trung bình → Khẩn cấp theo đề nghị của người báo. Lý do: PH đang gay gắt"` (Khớp 100%)
5. `action.done_append`:
   `"Em đã cập nhật bổ sung thông tin này vào ticket TECHTEST-100 cho anh/chị rồi nhé ạ!"` (Khớp 100%)

---

## 5. Còn dở gì
- Toàn bộ công việc theo đặc tả `issue-24-pr-10-review-fixes.md` đã hoàn thành 100%.
- Không còn việc tồn đọng thuộc PR 10 (issue #24).
