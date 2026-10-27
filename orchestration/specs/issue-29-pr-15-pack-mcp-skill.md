# Đặc tả: PR 15 của RFC 0002 — defineBot lễ tân thành pack MCP và skill (issue #29)

## Context

Repo `minhdevtry/ticket`. PR 15 của chuỗi lễ tân (`docs/rfc/0002-receptionist.md` mục 5),
issue #29. PR 13 (soát thông tin) và PR 14 (domain/copy/format) đã merge; main `dcaedb9`.

Mục tiêu: biến khai báo `defineBot({ receptionist })` thành **pack chạy được**:
kiểu chặt + kiểm khai báo một chỗ, **MCP server lễ tân** dựng từ khai báo, và **gói skill**
(persona/hướng dẫn/tin tĩnh) sinh từ khai báo + `CopyCatalog`. `createBot` vẫn là worker hậu cần.

## Nguồn legacy (CHỈ ĐỌC)

| Nguồn | Vai trò |
|---|---|
| `apps/tieulinh-legacy/mcp/tieulinh/tools/intake-step.ts` | tool `intake_step` |
| `apps/tieulinh-legacy/mcp/tieulinh/tools/inspect-tools.ts` | `get_intake_doc`, tra cứu |
| `apps/tieulinh-legacy/mcp/shared/server.ts` | dựng MCP server (đã port ở `packages/core/src/core/mcp-server.ts`) |
| `apps/tieulinh-legacy/mcp/tieulinh/intake-step.test.ts` | 1 ca flow MCP (port) |
| `apps/tieulinh-legacy/skills/tieulinh/{AGENTS,IDENTITY,SOUL}.md`, `bot.json` | cấu trúc gói skill |
| `apps/tieulinh-legacy/skills/_shared/AGENTS.md` | hướng dẫn dùng chung |
| `packages/core/src/bot/define.ts` | `defineBot`, `ReceptionistDefinition` hiện `unknown` |
| `packages/core/src/bot/create.ts` | cảnh báo `declared-not-running` |
| `packages/core/src/core/mcp-server.ts` | `createMcpServer`/`createIntakeMcpServer`, stdio/HTTP |
| `packages/core/src/identity/tools.ts` | bộ tool định danh |
| `packages/core/src/intake/gate/catalog.ts` | `assertCatalogIntegrity` |

Đọc trước: `AGENTS.md`, `CODING_STANDARDS.md`, `packages/core/GLOSSARY.md`,
`docs/rfc/0002-receptionist.md` §2, §5 (PR 15), ADR-0006/0008.

## Target

1. **Kiểu hoá `ReceptionistDefinition`** (`packages/core/src/bot/define.ts`):
   - `catalog: FieldCatalog`, `priorityRules: UrgencyRules`, `extractor: FieldExtractorPort`,
     `instructions?: string` (markdown của gói skill), `skill?: SkillPackDefinition`
     (`agentsMd?`, `identityMd?`, `soulMd?`, `botJson?`, `staticMessages?`).
   - Bỏ `channels` (hoặc đánh dấu deprecated + bỏ khỏi validation); ghi CHANGELOG.
   - Không còn `unknown`.
2. **`defineBot` kiểm khai báo một chỗ**:
   - `assertCatalogIntegrity(catalog)`, kiểm `priorityRules`/`extractor` có mặt, `persona` đủ khoá copy,
     `instructions`/`skill` nếu có phải là chuỗi/đối tượng hợp lệ.
   - Mọi lỗi gom vào `BotDefinitionError.issues` với `path` (`receptionist.catalog`…).
3. **Pack MCP lễ tân** (`packages/core/src/bot/receptionist-mcp.ts` hoặc `intake/mcp/`):
   - `createReceptionistMcpServer(definition, deps)` dựng tool từ khai báo: `intake_step`,
     `get_intake_doc`, `get_similar_tickets`, tool định danh; dùng `createIntakeMcpServer`.
   - Tool KHÔNG trả `callbackData`/nút thô (bug MiniMax 24/09); câu `agentInstruction` từ copy.
   - Chạy được **stdio** và **HTTP** qua `runOnStdio`/`runOnHttp`; test bằng client MCP trần,
     **không mạng thật**.
4. **Gói skill** (`packages/core/src/bot/skill-pack.ts`):
   - `buildSkillPack(definition)` trả `Record<path, string>`: `AGENTS.md`, `IDENTITY.md`,
     `SOUL.md`, `bot.json` (persona/instructions/tin tĩnh), cấu trúc như legacy.
   - Nội dung lấy từ `definition.persona`/`skill`/`instructions`; core **không** hardcode tiếng Việt.
   - App `apps/tieulinh` khai báo receptionist + skill data; có test cấu trúc gói.
5. **`createBot`**: bỏ component `receptionist: declared-not-running` (pack MCP là runtime lễ tân);
   `createBot` giữ backoffice worker. Health không còn cảnh báo giả.
6. **Test/port**:
   - Mở rộng `define.test.ts`: khai báo sai (thiếu catalog/extractor, catalog hỏng, persona thiếu khoá)
     → `BotDefinitionError` gom đủ lỗi; khai báo đúng → đóng băng.
   - Mở rộng `create.test.ts`: không còn `declared-not-running`.
   - Port `intake-step.test.ts` (1 ca flow: 3 lượt → `ticket_created`) vào core với tracker giả.
   - Test MCP stdio + HTTP: liệt kê đúng tool, gọi `intake_step` một lượt; test skill pack
     đúng cây file/nội dung.
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts` (2 dòng PR 15 → `ported`),
     RFC §5, `packages/core/CHANGELOG.md` (đổi `ReceptionistDefinition`, bỏ `channels`).

## Ranh giới

- Sửa `packages/core/**`, `apps/tieulinh/**`, `docs/**`, `orchestration/**`.
- `apps/tieulinh-legacy/**` chỉ đọc.
- Không đụng `.github/**`, `scripts/**`, `biome.lint-baseline.json`, root `package.json`, `bun.lock`.
- Không hardcode tiếng Việt trong core; copy/persona từ app.
- Không commit/push/PR (coordinator làm).

## Chủ quyết

1. Bỏ `ReceptionistDefinition.channels` (breaking nội bộ, ghi CHANGELOG); kênh thuộc harness/PR 16.
2. `createBot` giữ vai trò backoffice; MCP server lễ tân là runtime riêng (stdio/HTTP).
3. Skill pack là **hàm thuần** trả file map; app ghi đĩa (giống `sync-workspace` legacy).
4. MCP tool lấy copy/persona từ `definition.persona`/`CopyCatalog`; core generic.

## Nghiệm thu

- [ ] `defineBot` bắt lỗi khai báo; test định kiểu/validation.
- [ ] MCP server liệt kê đúng tool; gọi được qua stdio và HTTP bằng client MCP trần, offline.
- [ ] Gói skill sinh đúng cấu trúc; test nội dung.
- [ ] Không còn `declared-not-running`; `createBot` tests xanh.
- [ ] Port `intake-step.test.ts` (1) + gap register/RFC/CHANGELOG.
- [ ] `bun run verify` + `bun run docs:check` sạch.
