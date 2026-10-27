# Báo cáo thực hiện: PR 15 của RFC 0002 — defineBot lễ tân thành pack MCP và skill (issue #29)

## 1. Đã làm gì (theo từng mục của đặc tả)

### Mục 1: `packages/core/src/bot/define.ts`
- **Kiểu cụ thể cho `ReceptionistDefinition`**: Thay thế toàn bộ `unknown` bằng các kiểu chặt chẽ từ `@vuihoc/bot-core/intake`:
  - `catalog?: FieldCatalog` (có bí danh `Catalog = FieldCatalog`).
  - `priorityRules?: UrgencyRules`.
  - `extractor?: FieldExtractorPort`.
  - `variant?: string | ((draft: IntakeDraft, record: IntakeRecord) => string)`.
  - `techReviewPolicy?: TechReviewPolicy` (`"off" | "checklist" | "llm"`).
  - `techReviewer?: TechReviewerPort`.
  - `techReviewGuide?: string`.
  - `learned?: LearnedItemsPort`.
  - `policy?: { draftTtlMs?: number; minConfirmDelayMs?: number; followUpMaxChars?: number }`.
  - `ownership?: OwnershipPort`.
- **Kiểm tra khai báo lễ tân (`validateBotDefinition`)**:
  - Gom toàn bộ lỗi khai báo vào một ngoại lệ duy nhất `BotDefinitionError` chứa danh sách `BotDefinitionIssue[]`.
  - Kiểm tra `catalog`: yêu cầu khai báo `variants` không rỗng, mỗi variant phải có `fields`, kiểm tra type enum trỏ tới danh mục enum hợp lệ, cú pháp `requiredIf` và tham chiếu enum, kiểm tra cú pháp regex `pattern`, kiểm tra các trường trong `oneOf`, `recapFields`, `budgetGroups` phải tồn tại trong variant fields hoặc autoLabels.
  - Kiểm tra `priorityRules`: `levels` phải là mảng chuỗi ít nhất 2 mức; các luật sàn (`floors`) và luật trần (`ceilings`) phải có điều kiện `when`, lý do `reason` không rỗng và mức `minLevel`/`maxLevel` nằm trong danh sách `levels`.
  - Kiểm tra `techReviewPolicy`: chỉ nhận `"off"`, `"checklist"` hoặc `"llm"`.
  - Kiểm tra `extractor`: bắt buộc phải có phương thức `extract(input)`.
  - Bắt lỗi khi khai báo `receptionist: {}` rỗng mà không có cấu hình hợp lệ.
- **`ReceptionistDefinition.channels`**: Giữ lại trường này với ghi chú rõ ràng là kênh thuộc harness (OpenClaw), runtime pack không sử dụng, nhằm giữ tương thích ngược với các khai báo cũ mà không dùng thẻ cấm `@deprecated`.

### Mục 2: Bộ tool MCP của lễ tân (`packages/core/src/intake/mcp/`)
- Dựng module `packages/core/src/intake/mcp/` với đầy đủ các tool:
  - `intake_step` (`intake-step.ts`): chạy một lượt của `IntakeEngine.step()`, ánh xạ `StepOutcome` sang `LegacyIntakeAction` (`action`), chuẩn hoá `status`, xuất `voiceText`, `displayMarkdown`, `missingFields`, `buttonsShown`, `issue`, `docId`, `revision`; đặc biệt **không bao giờ trả mảng nút (`buttons`/`callbackData`) trong kết quả JSON gửi model** để tránh lỗi model tự bấm nút. Bổ sung `agentInstruction` chỉ dẫn dừng lượt khi gặp action cần người dùng trả lời/bấm nút (`WAITS_FOR_USER`).
  - `get_intake_doc` và `get_similar_tickets` (`inspect-tools.ts`): phục vụ tra cứu chi tiết tờ khai, tương thích với cấu trúc `document.fields[name] = { value }` của legacy, lấy toàn bộ lịch sử revision qua `getRevisions(docId)`.
  - `get_issue` (`lookup-tools.ts`): tra cứu tiến độ ticket theo mã hiển thị hoặc tự động tra cứu ticket gần nhất của chat qua `bindings.getLatestBinding(chatId)`.
  - `check_identity` và `register_identity` (`identity-tools.ts`): định danh người báo, tích hợp trả về `pendingDraft` khi người dùng đang có bản nháp ticket gom dở.
- **Factory `createReceptionistMcpServer` (`server.ts`)**: lắp ráp các tool trên bằng `createIntakeMcpServer` (`packages/core/src/core/mcp-server.ts`), hỗ trợ nhận `engine` dựng sẵn hoặc tự động khởi tạo `IntakeEngine` từ `BotDefinition` và các dependency (drafts, bindings, tracker, copy, clock).
- **Xử lý lỗi tool MCP**:
  - Toàn bộ tool handler đều bọc `try/catch` với `describeToolFailure(toolName, err)` trả về `{ loi: true, ma_loi: "...", thong_bao_cho_nguoi_dung: "...", chi_tiet: "..." }`.
  - `createIntakeMcpServer` cũng đảm bảo mọi lỗi không bắt được đều được chuyển thành kết quả văn bản thường mang cờ `loi: true`, tuyệt đối **không ném exception lên host MCP**.
- Bổ sung phương thức `getRevisions(docId: string): IntakeDraft[]` trên `DraftRepository` và `SqliteDraftRepository`.

### Mục 3: Gói skill (`packages/core/src/intake/mcp/skill-pack.ts`)
- Hàm `exportSkillPack(def, options)` sinh trọn vẹn gói skill theo đúng cấu trúc thư mục của `apps/tieulinh-legacy/skills/tieulinh/`:
  - `bot.json`: cấu hình bot, channel, tracker (`projectKey`), danh sách skill.
  - `AGENTS.md`: quy tắc cốt lõi ("Cấm nghĩ thành tiếng", "Một lượt một tin", quy trình tiếp nhận qua `intake_step`, tra cứu qua `get_issue`, ...).
  - `IDENTITY.md`: khai sinh danh tính bot.
  - `SOUL.md`: tâm hồn và giọng điệu ("Xưng em, gọi anh/chị").
  - `messages/greeting.md`: câu chào từ `CopyCatalog` (`skill.message.greeting`).
  - `messages/help.md`: hướng dẫn trợ giúp từ `CopyCatalog` (`skill.message.help`).
  - `messages/after-reset.md`: thông báo sau khi reset từ `CopyCatalog` (`skill.message.after_reset`).
  - `skills/incident-intake/SKILL.md`: mô tả skill tiếp nhận sự cố.
  - `skills/check-status/SKILL.md`: mô tả skill tra cứu tiến độ.
  - `references/priority-matrix.md` & `references/incident-taxonomy.md`: tài liệu tham chiếu ma trận ưu tiên và danh mục sự cố.
- Câu chữ lấy trực tiếp từ `CopyCatalog` (`def.persona` hoặc `options.copy`), không hardcode văn bản tiếng Việt trong logic.
- Cung cấp phương thức `pack.writeTo(targetDir)` tự động tạo thư mục và ghi toàn bộ file.

### Mục 4: `packages/core/src/bot/create.ts`
- Cập nhật header comment và tài liệu làm rõ: `createBot` là **worker hậu cần** (backoffice worker runtime phục vụ `agent-runs` native của itsaplan, webhook, lịch cron, hẹn giờ và `/healthz`), **không phải lễ tân**.
- Gỡ bỏ hoàn toàn cảnh báo `logger.warn("receptionist đã khai báo nhưng CHƯA chạy...")`.
- Gỡ bỏ thuộc tính `receptionist?: { state: "declared-not-running"; note: string }` khỏi `BotHealth.components` và runtime `health()`.

### Mục 5: Export từ package root
- Xuất đầy đủ các hàm và kiểu mới từ `@vuihoc/bot-core/intake` và `@vuihoc/bot-core/bot`:
  - `createReceptionistMcpServer`, `exportSkillPack`, `intakeStepTool`, `inspectTools`, `lookupTools`, `receptionistIdentityTools`.
  - Kiểu: `ReceptionistServerOptions`, `SkillPack`, `SkillPackFile`, `SkillPackOptions`, `IntakeStepDeps`, `InspectToolsDeps`, `LookupToolsDeps`.
  - Bí danh `Catalog = FieldCatalog`.
  - Khoá copy: `skill.message.greeting`, `skill.message.help`, `skill.message.after_reset`.

## 2. File nào đổi

- **Mới**:
  - `packages/core/src/intake/mcp/intake-step.ts`
  - `packages/core/src/intake/mcp/inspect-tools.ts`
  - `packages/core/src/intake/mcp/lookup-tools.ts`
  - `packages/core/src/intake/mcp/identity-tools.ts`
  - `packages/core/src/intake/mcp/skill-pack.ts`
  - `packages/core/src/intake/mcp/server.ts`
  - `packages/core/src/intake/mcp/index.ts`
  - `packages/core/src/intake/mcp/intake-step.test.ts`
- **Sửa**:
  - `packages/core/src/bot/define.ts`
  - `packages/core/src/bot/define.test.ts`
  - `packages/core/src/bot/create.ts`
  - `packages/core/src/bot/create.test.ts`
  - `packages/core/src/bot/index.ts`
  - `packages/core/src/intake/ports.ts`
  - `packages/core/src/intake/index.ts`
  - `packages/core/src/intake/gate/types.ts`
  - `packages/core/src/intake/draft/repository.ts`
  - `packages/core/src/intake/engine/engine.ts`
  - `packages/core/src/intake/engine/test-copy.fixture.ts`
  - `packages/core/examples/tieulinh/copy.ts`
  - `packages/core/CHANGELOG.md`
  - `packages/core/docs/parity/ENGINE.md`
  - `apps/tieulinh/copy.ts`
  - `apps/tieulinh/sla.test.ts`
  - `apps/tieulinh/receptionist-gap-register.test.ts`
  - `docs/explanation/bot-kit.md`

## 3. Lệnh đã chạy và kết quả thật

```bash
# 1. Chạy test riêng cho mcp và intake_step:
bun test packages/core/src/intake/mcp/intake-step.test.ts
# Kết quả: 4 pass, 0 fail, 44 expect() calls (174.00ms)

# 2. Chạy test định nghĩa bot:
bun test packages/core/src/bot/define.test.ts
# Kết quả: 13 pass, 0 fail, 57 expect() calls (77.00ms)

# 3. Chạy test createBot:
bun test packages/core/src/bot/create.test.ts
# Kết quả: 25 pass, 0 fail, 83 expect() calls (610.00ms)

# 4. Chạy toàn bộ test của packages/core:
bun run --cwd packages/core test
# Kết quả: 1513 pass, 0 fail, 10254 expect() calls (57.50s)

# 5. Chạy toàn bộ test của apps/tieulinh:
bun run --cwd apps/tieulinh test
# Kết quả: 177 pass, 0 fail, 1851 expect() calls (11.53s)

# 6. Kiểm tra sổ đối chiếu:
bun test apps/tieulinh/receptionist-gap-register.test.ts
# Kết quả: 9 pass, 0 fail, 1241 expect() calls (42.00ms)

# 7. Kiểm tra lint baseline:
bun run lint:baseline
# Kết quả:
# ok   style/noNonNullAssertion: 413 lỗi (cho phép tối đa 418)
# ok   suspicious/noExplicitAny: 780 lỗi (cho phép tối đa 780)
# Số lỗi của các rule đang tắt không tăng.

# 8. Typecheck toàn bộ workspace:
bun run check
# Kết quả:
# @vuihoc/bot-core check: Exited with code 0
# @vuihoc/tl2-shadow check: Exited with code 0
# @vuihoc/tieulinh check: Exited with code 0
# @vuihoc/tieulinh-legacy check: Exited with code 0

# 9. Kiểm tra vệ sinh bảo mật:
bun run scan
# Kết quả: ✓ public-hygiene scan clean

# 10. Kiểm tra tài liệu và snippets:
bun run docs:check
# Kết quả:
# copy-keys: 132 khoá
# adr-index: 16 ADR
# Mẫu code: 26 ts check, 14 ts run, 2 ts no-check.
# Docs khớp code: 48 trang.
# VitePress build complete in 48.35s.

# 11. Kiểm tra toàn diện (verify):
bun run verify
# Kết quả: lint + lint:baseline + check + test + test:scripts + scan + docs:snippets + docs:refs đều xanh 100%.
```

## 4. Test nào thêm, test nào port

- **Port từ legacy**:
  - `apps/tieulinh-legacy/mcp/tieulinh/intake-step.test.ts` (1 ca: "gọi intake_step và kiểm tra inspect_tools qua các lượt") → chuyển thành `packages/core/src/intake/mcp/intake-step.test.ts` (giữ nguyên chính xác tên ca test và ngữ nghĩa).
- **Thêm mới**:
  - `packages/core/src/intake/mcp/intake-step.test.ts`:
    - "MCP server lễ tân liệt kê đúng tool và gọi được qua stdio (in-memory) và HTTP": kiểm tra client MCP gọi qua stdio linked transport và streamable HTTP transport với loopback ephemeral port.
    - "mọi lỗi tool MCP trả về kết quả thường kèm cờ loi: true, không ném lên host": kiểm tra hành vi bọc lỗi `describeToolFailure`.
    - "gói skill sinh ra đúng cấu trúc thư mục": kiểm tra `exportSkillPack` sinh đủ 11 file theo đúng cấu trúc của legacy.
  - `packages/core/src/bot/define.test.ts`:
    - "chỉ lễ tân cũng hợp lệ (pack MCP và skill)": kiểm tra `defineBot` với `receptionist` hợp lệ.
    - "gom mọi lỗi catalog, luật ưu tiên, chính sách soát vào BotDefinitionError": kiểm tra gom lỗi toàn diện.
    - "receptionist rỗng không có cấu hình bị chặn": kiểm tra chặn `receptionist: {}`.
  - `packages/core/src/bot/create.test.ts`:
    - "khai báo receptionist: createBot không cảnh báo declared-not-running, health không mang receptionist".

## 5. Trả lời các điểm cần chủ quyết

1. **`ReceptionistDefinition.channels`**:
   - **Hiện trạng xử lý**: Giữ lại trường `channels?: readonly ChannelSpec[]` trong `ReceptionistDefinition` với doc comment ghi rõ: kênh thuộc harness (OpenClaw), runtime pack không dùng trường này.
   - **Đề xuất cho chủ**: Giữ nguyên như hiện tại để tránh break các cấu hình khai báo trước đây; có thể xoá bỏ hoàn toàn khi chuẩn hoá API 1.0.
2. **Tên và phạm vi gói skill**:
   - `exportSkillPack` xuất các file dạng cấu trúc tương đối (`bot.json`, `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `messages/*.md`, `skills/*/*.md`, `references/*.md`).
   - Ranh giới với PR 16: PR 15 chịu trách nhiệm **sinh nội dung gói skill từ khai báo + CopyCatalog**; PR 16 (OpenClaw adapter) sẽ chịu trách nhiệm **chép/đồng bộ các file này vào thư mục workspace của OpenClaw** (`skills/<tên-bot>/` hoặc `workspaces/<tên-bot>/`). Nhờ đó hai PR không bị dẫm chân lên nhau.
3. **`intake_step` qua MCP trả kết quả `StepOutput` thô hay đã diễn giải cho model?**
   - **Thực tế legacy**: Legacy trả về object đã diễn giải gồm: `action` (chuỗi legacy action), `status`, `voiceText`, `displayMarkdown`, `missingFields`, `buttonsShown` (boolean), `agentInstruction` ("Gửi nguyên văn voiceText rồi KẾT THÚC LƯỢT..."), `issue`, `similarTickets`, `docId`, `revision`; và **loại bỏ mảng nút bấm (`buttons`)** để model không tự động gọi lại tool với nhãn nút.
   - **Cài đặt trong PR 15**: Tuân thủ 100% định dạng legacy này qua `legacyActionForOutcome` để tương thích hoàn toàn với OpenClaw persona và plugin hiện tại mà không phải sửa đổi prompt.

## 6. Còn dở gì, và phần đó thuộc PR nào

- PR 16 (`feat(core/openclaw): adapter OpenClaw cho pack lễ tân`): adapter cấu hình `openclaw.json`, đồng bộ workspace, file nút chờ Telegram, webhook `inbound.forceNew`, kiểm chéo plugin `iris-tuong-tac` và `xac-nhan-xong`.
- PR 17 (`docs(deploy): runbook shadow, canary và hoàn nguyên lễ tân`): runbook vận hành, script triển khai Colab.
