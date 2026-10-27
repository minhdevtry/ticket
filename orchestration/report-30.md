# Báo cáo thực hiện: PR 16 của RFC 0002 — adapter OpenClaw cho pack lễ tân (issue #30)

## 1. Đã làm gì (theo từng mục của đặc tả)

### Mục 1: Adapter OpenClaw cho lễ tân (`packages/core/src/openclaw/receptionist-adapter.ts`) và xuất tại `index.ts`
- **Sinh cấu hình `openclaw.json` (`generateReceptionistOpenClawConfig`)**:
  - Nhận `BotDefinition` và tuỳ chọn `ReceptionistOpenClawConfigOptions`.
  - Khai báo MCP server lễ tân (mặc định `intake-<botId>`, lệnh `bun run packages/core/src/intake/mcp/server.ts`, biến môi trường `ITSAPLAN_PROJECT_KEY: def.tracker.project`).
  - Khai báo agent lễ tân (`tieulinh` hoặc tuỳ biến qua options), model, workspace, skills (`incident-intake`, `check-status`).
  - Khai báo hai plugin legacy `iris-tuong-tac` và `xac-nhan-xong` (cả đường dẫn tải `plugins.load.paths` và cấu hình `plugins.entries`).
  - Xuất cấu hình tương thích cả schema OpenClaw mới (`mcp.servers`, `agents.entries`) và legacy (`mcpServers`, `agents[id]`).
- **Đồng bộ Workspace (`syncReceptionistWorkspace`)**:
  - Nhận `BotDefinition`, đường dẫn thư mục đích `targetDir` và `SyncWorkspaceOptions`.
  - Dùng `exportSkillPack` từ PR 15 để sinh các file skill, persona, prompt, messages, references.
  - Dùng `planWorkspaceSync` từ `packages/core/src/openclaw/deploy.ts` để tính toán kế hoạch ghi file idempotent (`create`, `update`, `unchanged`).
  - Tự động ghi file xuống đĩa (hoặc chỉ trả về kế hoạch khi bật cờ `dryRun: true`), trả về `{ plan, summary, targetDir }`.
- **Cầu nối file nút chờ (`connectPendingButtons`)**:
  - Nhận `PendingButtonsAdapterOptions` với thư mục `dir` có thể cấu hình (không hardcode `~/.vhbot/`) và callback cảnh báo `onDrop`.
  - Cung cấp các phương thức `save(chatId, buttons)`, `read(chatId)`, `clear(chatId)`.
  - Tự động chuyển đổi các hàng `InlineButton` (`callbackData`) sang định dạng dây của Telegram `TelegramButton` (`callback_data`) qua `toTelegramButtons`.
  - Cung cấp `sink: { save, clear }` tương thích với `PendingButtonsSink` của pipeline.
  - Cung cấp `handleStepResult(chatId, result)`: tự động lưu nút khi `messages` hoặc `buttons` có nút, và tự động dọn sạch file chờ khi ticket đã tạo thành công (`action: "ticket_created"` hoặc `outcome: "created"`) hoặc khi không còn nút.
- **Helper nút Telegram chuẩn**:
  - `getConfirmationButtons(label)`: trả về mảng nút xác nhận với `callback_data` cố định "đúng rồi".
  - `getDepartmentButtons(options)`: chuyển danh sách phòng ban thành nút Telegram xếp hàng đôi (2 nút/hàng), giữ nguyên nhãn và callbackData.
  - `getBranchButtons()`: trả về danh sách 3 nút chọn nhánh chuẩn cho IRIS (2 hàng).
- **Chuyển tiếp định danh (`forwardSessionToIdentityTools`)**:
  - Hook helper kiểm tra `event.toolName`: khi là `check_identity` hoặc `register_identity`, nếu `params.userId` chưa có thì tự động trích xuất và chuyển tiếp `chatId`/`senderId` từ `PluginHookContext`.
- **Quản lý cờ `forceNew` cho `/new` (`createForceNewTracker`)**:
  - Cung cấp tracker quản lý cờ `forceNew` theo `chatId` (`mark`, `consume`, `has`, `clear`).
  - Cung cấp `asHandler()` trả về `ForceNewHandler` nối trực tiếp với webhook `/internal/force-new`.
- **Mở rộng `backoffice.inbound.forceNew`**:
  - Cập nhật kiểu `InboundDefinition` trong `packages/core/src/backoffice/types.ts`: thêm `forceNew?: (ctx: InboundContext<C>, request: { chatId: string }) => Promise<void> | void`.
  - Cập nhật `packages/core/src/bot/define.ts`: cho phép `forceNew` trong danh sách các handler hợp lệ của `backoffice.inbound`.
  - Cập nhật `packages/core/src/bot/create.ts`: tự động đăng ký `webhookServer.onForceNew` khi `inbound.forceNew` được khai báo.

### Mục 2: Kiểm hợp đồng với plugin legacy trong `packages/core/src/openclaw/openclaw-adapter.test.ts`
- Import trực tiếp các hàm xuất của hai plugin legacy:
  - `iris-tuong-tac`: `choPhepNutTrenTinCoMa`, `laCallbackNoiBo`, `xuLyDebounceCallback`, `layAccountId`, `donDepVanBanKhiCoNut`, plugin default.
  - `xac-nhan-xong`: `docXacNhan`, `layChatId`, `layReplyToId`, `boPhongBiKenh`, `laLenhSuCoMoi`, `docBangWorker`, `xuLyXacNhan`, `xuLyTruocDispatch`, plugin default.
- **Khớp chữ tóm tắt TL2 với `choPhepNutTrenTinCoMa` và regex dòng 522**:
  - Cập nhật `summary.confirm_hint` trong `apps/tieulinh/copy.ts` và `packages/core/examples/tieulinh/copy.ts` thành:
    `"Anh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận để em tạo ticket nhé ạ."`
    để khớp regex dòng 522 của `iris-tuong-tac` (`/(?:tóm tắt|kiểm tra (?:kỹ )?(?:lại )?thông tin|trước khi xác nhận...)/i`), tránh nguy cơ nút xác nhận bị plugin tự động gỡ bỏ trên Telegram.
  - Kiểm tra tin tóm tắt chuẩn của TL2 không chứa mã ticket → `choPhepNutTrenTinCoMa` trả về `true` (không để nút xác nhận biến mất, bảo vệ theo RFC 0002 dòng 491).
  - Kiểm tra tin xem trước đính kèm mã ticket TECH-795 có nút nhắc đúng mã → `choPhepNutTrenTinCoMa` trả về `true` (ADR-0008).
  - Kiểm tra tin thông báo đã tạo xong ticket TECH-975 với nút xác nhận cũ → `choPhepNutTrenTinCoMa` trả về `false` (khoá nút thành công, không để nút xác nhận cũ xuất hiện trên tin hoàn tất).
- **Kiểm hợp đồng đầu ra `intake_step`**:
  - Khi action là `WAITS_FOR_USER`: `buttonsShown = true`, mảng nút được đẩy qua file chờ, `agentInstruction` chỉ đạo model dừng lượt ("Gửi nguyên văn voiceText rồi KẾT THÚC LƯỢT..."), và kết quả tool không in trường `buttons` trong JSON gửi model.
  - Khi action hoàn tất (`ticket_created`): `buttonsShown = false`, dọn dẹp file chờ, `agentInstruction` thông thường.
- **Kiểm chéo 45 ca test legacy**:
  - 12 ca test của `iris-tuong-tac`: `layAccountId` (2), `choPhepNutTrenTinCoMa` (3), `xuLyDebounceCallback` (2), `laCallbackNoiBo` (3), chặn noop tại `before_dispatch` và `before_agent_reply` (2).
  - 33 ca test của `xac-nhan-xong`: `docXacNhan` (2), `layChatId` (2), `layReplyToId` (3), `boPhongBiKenh` (2), `laLenhSuCoMoi` (3), `docBangWorker` (1), `xuLyXacNhan` (12), `xuLyTruocDispatch` (8).

### Mục 3: Port 7 ca test legacy từ `apps/tieulinh-legacy`
- Port chính xác 7 ca test legacy được liệt kê trong `receptionist-gap-register.test.ts` sang `packages/core/src/openclaw/openclaw-adapter.test.ts`:
  1. `lib/intake-step/pipeline.flow.test.ts`:
     - `"tạo ticket: có binding, dọn bản nháp, nút xác nhận hiện lúc tóm tắt và bị xoá sau khi tạo"`: kiểm tra luồng tiếp nhận từ tóm tắt (nút lưu vào file chờ) đến xác nhận (tạo ticket, lưu binding, xoá bản nháp và dọn file nút).
  2. `mcp/shared/tools/confirmation-and-binding.test.ts`:
     - `"checkIdentity: lưu initialButtons vào file nút tạm khi user được duyệt và chưa có draft"`: kiểm tra lưu nút nhánh ban đầu vào file chờ khi user được duyệt và chưa có draft.
     - `"checkRequiredFields: tự động lưu branch buttons và nhắc chọn nhánh khi thiếu variant"`: kiểm tra tự động lưu nút chọn nhánh vào file chờ và câu hỏi nhắc chọn nhánh bên dưới.
     - `"checkRequiredFields: đã đính nút thì thôi liệt kê lựa chọn trong câu hỏi"`: kiểm tra khi có nút bấm thì câu hỏi không liệt kê danh sách lựa chọn dạng chữ ("chọn một:", "·").
  3. `lib/telegram/buttons.test.ts`:
     - `"dùng đúng chữ được truyền vào, callback_data cố định 'đúng rồi'"`: kiểm tra `getConfirmationButtons`.
     - `"không tự bịa thêm hay bớt phòng ban nào so với danh sách truyền vào"`: kiểm tra `getDepartmentButtons`.
     - `"trả về danh sách 3 nút nhánh chuẩn cho IRIS"`: kiểm tra `getBranchButtons`.

### Mục 4: Sổ đối chiếu và tài liệu (`ENGINE.md`, `CHANGELOG.md`)
- Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`:
  - Chuyển 7 dòng trên từ trạng thái `"deferred"` sang `"ported"`, trỏ tới `C("openclaw/openclaw-adapter.test.ts", "<tên-test>")`.
- Cập nhật `packages/core/docs/parity/ENGINE.md`:
  - Dòng gap-register: `<!-- gap-register: total=450 core=61 ported=326 deferred=52 by-design=11 -->`.
  - Bảng `<!-- gap-register-deferred-by-pr -->`: hàng PR 16 thành `0`.
- Cập nhật `packages/core/CHANGELOG.md`: ghi nhận đầy đủ các thay đổi trong PR 16 dưới mục `## Unreleased`.

---

## 2. File nào đổi

- **Mới**:
  - `packages/core/src/openclaw/receptionist-adapter.ts`
  - `packages/core/src/openclaw/openclaw-adapter.test.ts`
  - `packages/core/src/openclaw/legacy-plugins.d.ts`
  - `orchestration/report-30.md`
- **Sửa**:
  - `.gitignore`
  - `apps/tieulinh/copy.ts`
  - `packages/core/examples/tieulinh/copy.ts`
  - `packages/core/src/openclaw/index.ts`
  - `packages/core/src/backoffice/types.ts`
  - `packages/core/src/bot/define.ts`
  - `packages/core/src/bot/create.ts`
  - `packages/core/src/intake/mcp/intake-step.test.ts`
  - `packages/core/src/intake/mcp/skill-pack.ts`
  - `apps/tieulinh/receptionist-gap-register.test.ts`
  - `packages/core/docs/parity/ENGINE.md`
  - `packages/core/CHANGELOG.md`
---

## 3. Lệnh đã chạy và kết quả thật

```bash
# 1. Chạy test riêng cho openclaw adapter và các file trong openclaw:
bun test packages/core/src/openclaw
# Kết quả: 137 pass, 0 fail, 328 expect() calls across 8 files (170.00ms)

# 2. Kiểm tra sổ đối chiếu:
bun test apps/tieulinh/receptionist-gap-register.test.ts
# Kết quả: 9 pass, 0 fail, 1241 expect() calls (23.00ms)

# 3. Typecheck toàn bộ workspace:
bun run check
# Kết quả:
# @vuihoc/bot-core check: Exited with code 0
# @vuihoc/tl2-shadow check: Exited with code 0
# @vuihoc/tieulinh check: Exited with code 0
# @vuihoc/tieulinh-legacy check: Exited with code 0

# 4. Kiểm tra lint baseline:
bun run lint:baseline
# Kết quả:
# ok   style/noNonNullAssertion: 413 lỗi (cho phép tối đa 418)
# ok   suspicious/noExplicitAny: 780 lỗi (cho phép tối đa 780)
# Số lỗi của các rule đang tắt không tăng.

# 5. Kiểm tra linter biome:
bun run lint
# Kết quả: 0 error, exited with code 0

# 6. Kiểm tra vệ sinh bảo mật:
bun run scan
# Kết quả: ✓ public-hygiene scan clean

# 7. Kiểm tra tài liệu, TypeDoc và code snippets:
bun run docs:check
# Kết quả:
# Mẫu code: 26 ts check, 14 ts run, 2 ts no-check.
# Docs khớp code: 48 trang.
# VitePress build complete in 70.79s.

# 8. Chạy toàn bộ test của workspace:
bun run test
# Kết quả:
# @vuihoc/bot-core test: 1577 pass, 0 fail (45.95s)
# @vuihoc/tieulinh test: 177 pass, 0 fail (9.46s)
# @vuihoc/tl2-shadow test: 154 pass, 0 fail (1.40s)
# @vuihoc/tieulinh-legacy test: 938 pass, 27 skip, 0 fail (55.02s)

# 9. Kiểm tra toàn diện verify:
bun run verify
# Kết quả: lint + lint:baseline + check + test + test:scripts + scan + docs:snippets + docs:refs đều xanh 100%.
```

---

## 4. Test nào thêm, test nào port

- **Port từ legacy (7 test)**:
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
- **Kiểm chéo từ plugin legacy (45 test)**:
  - 12 ca test của `iris-tuong-tac` (`layAccountId`, `choPhepNutTrenTinCoMa`, `xuLyDebounceCallback`, `laCallbackNoiBo`, `plugin iris-tuong-tac chặn noop ở before_dispatch và before_agent_reply`).
  - 33 ca test của `xac-nhan-xong` (`docXacNhan`, `layChatId`, `layReplyToId`, `boPhongBiKenh`, `laLenhSuCoMoi`, `docBangWorker`, `xuLyXacNhan`, `xuLyTruocDispatch`).
- **Thêm mới (11 test)**:
  - Hợp đồng đầu ra `intake_step` (`buttonsShown`, `agentInstruction`, mảng nút chuyển qua file chờ và không lộ trong JSON gửi model).
  - Khớp chữ tóm tắt TL2 và xem trước với `choPhepNutTrenTinCoMa` (RFC 0002 dòng 491, ADR-0008).
  - Kiểm tra `donDepVanBanKhiCoNut` và định danh plugin legacy.
  - Sinh cấu hình `generateReceptionistOpenClawConfig` và kiểm tra ghép nối qua `mergeJsonConfig`.
  - Đồng bộ workspace `syncReceptionistWorkspace` (kế hoạch, cờ `dryRun`, ghi file và tính chất idempotent).
  - Chuyển tiếp session/chatId vào `identityTools` (`forwardSessionToIdentityTools`).
  - Quản lý cờ `forceNew` cho `/new` (`createForceNewTracker`).

---

## 5. Còn dở gì, và phần đó thuộc PR nào

- PR 16 đã hoàn tất 100% mục tiêu đặc tả. Số test deferred của PR 16 trong sổ đối chiếu đã về 0.
- Còn PR 17 (`docs(deploy): runbook shadow, canary và hoàn nguyên lễ tân`): runbook vận hành, script triển khai Colab (không port test legacy).
