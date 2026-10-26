# Đặc tả: PR 14 của RFC 0002 — dữ liệu domain, chữ và định dạng ticket của lễ tân (issue #28)

## Context

Repo `minhdevtry/ticket`. PR 14 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5),
issue #28. PR 1-13 đã merge vào `main` (PR 13 = soát thông tin F1-F4, commit `aca6360`).

Mục tiêu: đưa **dữ liệu domain, luật ưu tiên, vựng, chữ và định dạng ticket** của Tiểu Linh
vào **app `apps/tieulinh`** (không phải core), port 82 ca test legacy, và giữ đầu ra khớp
bản ghi vàng/legacy từng byte cho tới khi xoá legacy.

## Nguồn legacy (CHỈ ĐỌC — không sửa, không import code legacy vào app mới)

| Nguồn | Vai trò | Test |
|---|---|---|
| `apps/tieulinh-legacy/mcp/tieulinh/domain/ticket-formatter.ts` | định dạng mô tả/comment ticket (J1, K6) | `ticket-formatter.test.ts` (37) |
| `apps/tieulinh-legacy/mcp/tieulinh/create-issue-description.ts` (tìm bằng `rg`) | dựng mô tả ticket (ADR-0010) | `create-issue-description.test.ts` (7) |
| `apps/tieulinh-legacy/mcp/tieulinh/rawtext-regression.test.ts` | hồi quy raw text | 5 |
| `apps/tieulinh-legacy/mcp/tieulinh/domain.test.ts` | catalog + domain | 12 |
| `apps/tieulinh-legacy/mcp/tieulinh/validate.test.ts` | validate field | 7 |
| `apps/tieulinh-legacy/mcp/tieulinh/priority.test.ts` | luật ưu tiên | 7 |
| `apps/tieulinh-legacy/mcp/tieulinh/completeness.test.ts` | độ đầy đủ | 7 |
| `apps/tieulinh-legacy/mcp/tieulinh/domain/` | `validation-rules.json`, `urgency-rules.json`, `required_fields.json`, `product_mapping.json`, `tech_accounts.json`, `taxonomy.ts`, `tech-info-needs.md`, `types.ts` | — |
| `apps/tieulinh-legacy/lib/intake-step/pipeline.ts` | ~70 dòng chữ gửi người báo + mẫu tóm tắt | golden |

Đọc trước: `AGENTS.md`, `CODING_STANDARDS.md`, `packages/core/GLOSSARY.md`,
`docs/rfc/0002-receptionist.md` §1.4 (J1, K6), §2.1-2.4, §5; ADR-0006, ADR-0008, ADR-0010.

## Target

1. **`apps/tieulinh/domain/` (mới)** — dữ liệu và logic riêng Tiểu Linh:
   - `taxonomy.ts`, `types.ts`, các JSON rules lấy từ legacy (giữ nguyên nội dung).
   - `ticket-formatter.ts` (37 ca), `create-issue-description.ts` (7), `validate.ts` (7),
     `priority.ts` (7), `completeness.ts` (7), `domain.ts` (12), raw-text regression (5).
   - `tech-info-needs.md` (hướng dẫn LLM) thuộc app; `LlmTechReviewer` nhận `guide` từ app.
2. **`apps/tieulinh/copy.ts`** — mở rộng thành kho chữ lễ tân của app:
   - Chữ gửi người báo, mẫu tóm tắt, comment gợi ý, nhãn nút; tiếng Việt đặt ở đây.
   - `apps/tieulinh/engine-config` (hoặc `bot.ts`) dùng copy của app, không dùng copy mẫu trong core.
   - `packages/core/examples/tieulinh/copy.ts` chỉ còn là mẫu/test fixture; **không** là nguồn production.
3. **`catalogFromValidationRules`** — nếu core chưa có, thêm hàm **generic** vào core
   (`packages/core/src/intake/gate/`), nhận rules JSON và trả catalog theo `gate/types.ts`.
   Không đưa dữ liệu Tiểu Linh vào core.
4. **Nối F3/F4 vào app** (đã có cổng từ PR 13):
   - `apps/tieulinh/env.ts` đọc `TECH_INFO_REVIEW` → `techReviewPolicy` (`off|checklist|llm`).
   - `apps/tieulinh/env.ts` đọc `ASK_LEARN_DB` → `createAskLearnedLookup(...)` → `learned` cho engine.
   - `makeTieulinhEngine` nhận `learned`/`copy` của app (không hardcode).
5. **Test chống trôi dữ liệu**:
   - Port đủ **82 ca** legacy, giữ nguyên tên ca; đặt cạnh code app (`apps/tieulinh/domain/*.test.ts`).
   - Thêm test golden: dựng ticket mẫu, so mô tả/comment/tóm tắt với bản ghi vàng legacy
     (byte-identical), chạy offline.
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`: J1, K6 và các dòng PR 14
     chuyển `ported` **chỉ khi** test tương ứng tồn tại; tổng `ported/deferred` khớp.
6. **Tài liệu**: `docs/rfc/0002-receptionist.md` §1.4/§5 (J1, K6, cột PR); `docs/` trang
   liên quan nếu hành vi/API đổi; `packages/core/CHANGELOG.md` nếu sửa core.

## Ranh giới

- Chỉ sửa `apps/tieulinh/**`, `packages/core/**` (khi thêm `catalogFromValidationRules`),
  `docs/**`, `orchestration/**`.
- **`apps/tieulinh-legacy/**` chỉ đọc** — không sửa, không import runtime.
- Không đụng `.github/**`, `scripts/**`, `biome.lint-baseline.json`, root `package.json`, `bun.lock`.
- Không tự tạo/sửa/đóng issue; không commit/push (coordinator làm).
- **Không hardcode chữ tiếng Việt trong core**; core chỉ generic + nhận copy/data từ app.

## Chủ quyết

1. Formatter/description/validate/priority/completeness thuộc **app** (dữ liệu Tiểu Linh).
2. `catalogFromValidationRules` là hàm **generic ở core**; app truyền rules.
3. Copy production thuộc **app**; `examples/tieulinh` chỉ là mẫu/test fixture. Test drift so app ↔ legacy.
4. `tech-info-needs.md` thuộc **app**; `LlmTechReviewer(llm, guide)` nhận guide từ app.
5. `TECH_INFO_REVIEW`/`ASK_LEARN_DB` đọc ở **app env**, không đọc trong core.

## Nghiệm thu

- [ ] 82 ca legacy port đủ, tên ca giữ nguyên; không gọi dịch vụ thật.
- [ ] Golden/parity byte-identical với legacy cho mô tả, comment, tóm tắt, chữ.
- [ ] `bun run verify` sạch (lint + check + test + scan + docs nhanh).
- [ ] `bun run docs:check` sạch.
- [ ] Gap register J1/K6/PR 14 cập nhật đúng; RFC §1.4/§5 cập nhật; CHANGELOG nếu core.
- [ ] Không sửa legacy; không thêm chữ Việt vào core.
