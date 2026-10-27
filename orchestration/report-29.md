# Báo cáo: PR 15 của RFC 0002 — defineBot lễ tân thành pack MCP và skill (issue #29)

## 1. Đã làm gì (theo từng mục của đặc tả)

1. **Kiểu hoá `ReceptionistDefinition` và loại bỏ `channels`**:
   - Kiểu hoá chặt chẽ `ReceptionistDefinition` trong `packages/core/src/bot/define.ts`: `catalog: FieldCatalog`, `priorityRules: UrgencyRules`, `extractor: FieldExtractorPort`, `instructions?: string`, `skill?: SkillPackDefinition`.
   - Bổ sung interface `SkillPackDefinition` (`agentsMd?`, `identityMd?`, `soulMd?`, `botJson?`, `staticMessages?`).
   - Xoá hoàn toàn `channels` (và `ChannelSpec` không còn dùng) khỏi `ReceptionistDefinition` theo nguyên tắc clean cutover, kênh thuộc harness/PR 16.
   - Không còn kiểu `unknown` trong định nghĩa lễ tân.

2. **`defineBot` kiểm khai báo một chỗ và gom lỗi vào `BotDefinitionError`**:
   - Kiểm tra `assertCatalogIntegrity(catalog)`: phát hiện catalog hỏng, enum thiếu hoặc không hợp lệ.
   - Kiểm tra `priorityRules` và `extractor` có mặt và đúng dạng.
   - Kiểm tra `instructions` (nếu có phải là chuỗi markdown) và `skill` (nếu có phải là object với các trường chuỗi/object hợp lệ).
   - Kiểm tra `persona` có mặt khi khai báo lễ tân, và kiểm tra đủ toàn bộ 131 khoá copy qua hàm `validateCopyCatalog` trong `packages/core/src/intake/copy-catalog.ts`.
   - Mọi lỗi được gom vào `BotDefinitionError.issues` với đường dẫn chính xác (`receptionist.catalog`, `receptionist.priorityRules`, `receptionist.extractor`, `receptionist.instructions`, `receptionist.skill.*`, `persona`).

3. **Pack MCP lễ tân (`createReceptionistMcpServer`)**:
   - Triển khai `packages/core/src/bot/receptionist-mcp.ts` xuất `createReceptionistMcpServer(definition, deps)` sử dụng `createIntakeMcpServer`.
   - Dựng 4 nhóm tool:
     - `intake_step`: bọc `IntakeEngine.step()`, chuyển kết quả thành hợp đồng tool legacy (`action`, `status`, `voiceText`, `displayMarkdown`, `missingFields`, `buttonsShown`, `agentInstruction`, `issue`, `similarTickets`, `docId`, `revision`). Tuyệt đối không trả `callbackData` hay danh sách nút thô cho model (tránh bug MiniMax 24/09).
     - `get_intake_doc`: tra cứu tờ khai theo `docId` hoặc `chatId`, hỗ trợ `includeHistory` đọc toàn bộ revision qua `DraftRepository.getRevisions()`. Format `fields` để tương thích cấu trúc legacy `fields.<name>.value`.
     - `get_similar_tickets`: tra cứu danh sách ticket tương tự của chat.
     - Tool định danh: tích hợp các tool định danh (`check_identity`, `register_identity`, `approve_user`, `reject_user`, `relink_identity`) khi có cấu hình `deps.identity`.
   - Câu `agentInstruction` được lấy động từ `CopyCatalog` (`agent_instruction.wait_for_user` và `agent_instruction.forward`), đảm bảo core generic, không hardcode tiếng Việt.
   - Server hỗ trợ cả stdio qua `runOnStdio` và Streamable HTTP qua `runOnHttp`.

4. **Gói skill (`buildSkillPack`)**:
   - Triển khai `packages/core/src/bot/skill-pack.ts` xuất hàm thuần `buildSkillPack(definition)` trả về `Record<string, string>` chứa cây file:
     - `AGENTS.md`: từ `skill.agentsMd` hoặc `receptionist.instructions`.
     - `IDENTITY.md`: từ `skill.identityMd`.
     - `SOUL.md`: từ `skill.soulMd`.
     - `bot.json`: cấu hình metadata, channel và tracker.
     - `messages/<key>.md`: các tin nhắn tĩnh từ `skill.staticMessages` (`greeting.md`, `help.md`, `after-reset.md`...).
   - Tạo `apps/tieulinh/skill.ts` chứa dữ liệu gói skill và instructions của Tiểu Linh.
   - Khai báo lễ tân + persona + skill data trong `apps/tieulinh/bot.ts`.
   - Có bài kiểm thử cấu trúc gói skill của Tiểu Linh (`apps/tieulinh/skill-pack.test.ts`).

5. **`createBot` loại bỏ `receptionist: declared-not-running`**:
   - Xoá trường `receptionist?: { state: "declared-not-running"; note: string }` khỏi `BotHealth.components`.
   - Xoá khối gán `components.receptionist` trong `health()`, giúp health không còn cảnh báo giả (MCP pack là runtime của lễ tân).
   - Cập nhật tài liệu `docs/explanation/bot-kit.md`.

6. **Tăng revision tờ khai và bổ sung `getRevisions`**:
   - Bổ sung `getRevisions(docId: string): IntakeDraft[]` vào `DraftRepository` và triển khai trong `SqliteDraftRepository`.
   - Nâng cấp `IntakeEngine.mergeIntoDraft`: tự động tăng `revision` qua các lượt hội thoại (`open ? open.revision + 1 : base.revision`).
   - Cập nhật `checkIdentityTool` hỗ trợ trả `pendingDraft` khi cấu hình `drafts: DraftRepository`.

## 2. File nào đổi

### Thêm mới (7 files)
- `packages/core/src/bot/receptionist-mcp.ts`: module dựng MCP server lễ tân (`createReceptionistMcpServer`).
- `packages/core/src/bot/receptionist-mcp.test.ts`: test MCP server qua InMemoryTransport và Streamable HTTP.
- `packages/core/src/bot/skill-pack.ts`: module sinh gói skill (`buildSkillPack`).
- `packages/core/src/bot/skill-pack.test.ts`: test sinh cây file gói skill.
- `packages/core/src/bot/intake-step.test.ts`: port test legacy intake-step 3 lượt và check_identity pendingDraft.
- `apps/tieulinh/skill.ts`: dữ liệu gói skill và hướng dẫn vận hành Tiểu Linh.
- `apps/tieulinh/skill-pack.test.ts`: test sinh gói skill của app Tiểu Linh.

### Chỉnh sửa (19 files)
- `packages/core/src/bot/define.ts`: kiểu hoá `ReceptionistDefinition`, bỏ `channels`, bổ sung `SkillPackDefinition`, kiểm tra toàn vẹn catalog và khoá copy trong `validateBotDefinition`.
- `packages/core/src/bot/define.test.ts`: mở rộng test kiểm tra khai báo lễ tân (thiếu trường, catalog hỏng, persona thiếu khoá, sai kiểu instructions/skill).
- `packages/core/src/bot/create.ts`: loại bỏ component `receptionist: declared-not-running` khỏi `BotHealth`.
- `packages/core/src/bot/create.test.ts`: bổ sung test kiểm tra health không còn `declared-not-running`.
- `packages/core/src/bot/index.ts`: export `createReceptionistMcpServer` và `buildSkillPack`.
- `packages/core/src/identity/tools.ts`: hỗ trợ `drafts?: DraftRepository` và trả `pendingDraft` trong `checkIdentityTool`.
- `packages/core/src/intake/ports.ts`: thêm `agent_instruction.wait_for_user` và `agent_instruction.forward` vào `CopyKey`.
- `packages/core/src/intake/copy-catalog.ts`: xuất `REQUIRED_COPY_KEYS` và hàm `validateCopyCatalog`.
- `packages/core/src/intake/draft/repository.ts`: thêm phương thức `getRevisions(docId)`.
- `packages/core/src/intake/engine/engine.ts`: tăng revision qua các lượt hội thoại.
- `packages/core/src/intake/engine/test-copy.fixture.ts`: bổ sung 2 khoá copy agent_instruction.
- `packages/core/examples/tieulinh/copy.ts`: bổ sung 2 khoá copy agent_instruction.
- `apps/tieulinh/copy.ts`: bổ sung 2 khoá copy agent_instruction tiếng Việt.
- `apps/tieulinh/bot.ts`: khai báo `receptionist` và `persona` trong `defineBot`.
- `apps/tieulinh/receptionist-gap-register.test.ts`: cập nhật 2 dòng test PR 15 sang `ported`.
- `packages/core/docs/parity/ENGINE.md`: cập nhật bảng số liệu và PR 15 (tổng ported: 311, deferred: 67).
- `packages/core/CHANGELOG.md`: ghi chú thay đổi PR 15.
- `docs/rfc/0002-receptionist.md`: cập nhật bảng PR 15 mục 5.
- `docs/explanation/bot-kit.md`: cập nhật giải thích vai trò của `createBot` và pack lễ tân.

## 3. Lệnh đã chạy và kết quả thật

```bash
# 1. Test toàn bộ packages/core
bun run --cwd packages/core test
# Kết quả: 1518 pass, 0 fail, 10267 expect() calls across 125 files [44.56s]

# 2. Test toàn bộ apps/tieulinh
bun run --cwd apps/tieulinh test
# Kết quả: 178 pass, 0 fail, 1866 expect() calls across 20 files [10.20s]

# 3. Test toàn bộ apps/tieulinh-legacy (bản tham chiếu đóng băng)
bun run --cwd apps/tieulinh-legacy test
# Kết quả: 938 pass, 27 skip, 0 fail across 88 files [79.34s]

# 4. Kiểm tra baseline lint
bun run lint:baseline
# Kết quả:
# ok   style/noNonNullAssertion: 413 lỗi (cho phép tối đa 418)
# ok   suspicious/noExplicitAny: 780 lỗi (cho phép tối đa 780)
# Số lỗi của các rule đang tắt không tăng.

# 5. Typecheck toàn repo
bun run check
# Kết quả:
# @vuihoc/bot-core check: Exited with code 0
# @vuihoc/tl2-shadow check: Exited with code 0
# @vuihoc/tieulinh check: Exited with code 0
# @vuihoc/tieulinh-legacy check: Exited with code 0

# 6. Toàn bộ verify suite
bun run verify
# Kết quả: lint, lint:baseline, check, test, test:scripts (61 pass), scan (clean), docs:snippets (26 check, 14 run, 2 no-check), docs:refs (48 trang khớp). Tất cả đều pass sạch.

# 7. Build và kiểm docs
bun run docs:check
# Kết quả: TypeDoc + VitePress build thành công (47.40s) + check snippets + check refs sạch.
```

## 4. Test nào thêm, test nào port

### Test port từ legacy sang core (`packages/core/src/bot/intake-step.test.ts`):
1. `"gọi intake_step và kiểm tra inspect_tools qua các lượt"`: port từ `apps/tieulinh-legacy/mcp/tieulinh/intake-step.test.ts` (3 lượt flow MCP: `ask_missing_field` -> `confirm_summary` -> `ticket_created`, kiểm tra `inspect_tools` và lịch sử revision).
2. `"check_identity: trả về pendingDraft khi có bản nháp ticket đang gom dở"`: port từ `apps/tieulinh-legacy/mcp/shared/tools/confirmation-and-binding.test.ts`.

### Test mới thêm:
1. `packages/core/src/bot/define.test.ts`:
   - `"lễ tân hợp lệ được đóng băng"`: kiểm tra khai báo lễ tân hợp lệ trả về object đóng băng.
   - `"lễ tân sai: gom đủ lỗi thiếu catalog, priorityRules, extractor, persona"`: kiểm tra gom lỗi `BotDefinitionError`.
   - `"lễ tân: bắt catalog không toàn vẹn"`: kiểm tra `assertCatalogIntegrity`.
   - `"lễ tân: persona thiếu khoá copy bị bắt lỗi"`: kiểm tra `validateCopyCatalog`.
   - `"lễ tân: instructions và skill sai kiểu dữ liệu bị bắt lỗi"`.
2. `packages/core/src/bot/create.test.ts`:
   - `"khai báo receptionist: health không còn component receptionist: declared-not-running"`.
3. `packages/core/src/bot/receptionist-mcp.test.ts`:
   - `"liệt kê đúng các tool tiếp nhận và gọi qua InMemoryTransport"`: kiểm tra MCP client offline gọi `intake_step`, `get_intake_doc`, `get_similar_tickets`.
   - `"chạy được trên Streamable HTTP và gọi tool với JSON-RPC"`: kiểm tra `runOnHttp` nhận initialize, tools/list, tools/call.
   - `"runOnStdio bọc được StdioServerTransport"`.
4. `packages/core/src/bot/skill-pack.test.ts`:
   - `"sinh đầy đủ cây file gói skill từ BotDefinition"`: kiểm tra `buildSkillPack`.
   - `"rơi về instructions khi skill.agentsMd không khai"`.
5. `apps/tieulinh/skill-pack.test.ts`:
   - `"sinh đúng cấu trúc file của gói skill Tiểu Linh"`.

## 5. Còn dở gì, và phần đó thuộc PR nào

- Adapter OpenClaw (mảnh cấu hình `openclaw.json`, plugin iris/xac-nhan-xong, file nút chờ): thuộc PR 16.
- Runbook shadow, canary và hoàn nguyên lễ tân: thuộc PR 17.
- Tri thức KG/Onyx/Memgraph: nằm ngoài chuỗi di trú này (RFC riêng sau).
