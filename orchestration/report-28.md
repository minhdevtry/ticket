# Báo cáo: PR 14 của RFC 0002 — Dữ liệu domain, chữ và định dạng ticket của lễ tân (issue #28)

## 1. Đã làm gì

Theo từng mục của đặc tả `orchestration/specs/issue-28-pr-14-domain-format.md`:

### Target 1: `apps/tieulinh/domain/` — Dữ liệu và logic riêng Tiểu Linh
- Đưa toàn bộ dữ liệu cấu hình quy tắc và hướng dẫn của Tiểu Linh vào app `apps/tieulinh/domain/`:
  - `validation-rules.json`, `urgency-rules.json`, `required_fields.json`, `product_mapping.json`, `tech_accounts.json` (giữ nguyên nội dung).
  - `taxonomy.ts`: danh mục 9 sản phẩm, 9 hệ thống, 7 bộ phận, 11 phân loại lỗi, 4 loại thiết bị; phân loại `ProductCategory` và hàm `getRecommendedSoftFields`.
  - `types.ts`: cấu trúc `IncidentDetails`, `ReporterInfo`, `SimilarIssue`, `UploadedAttachmentResult`.
  - `tech-info-needs.md`: tài liệu hướng dẫn dữ kiện kỹ thuật cần hỏi của kỹ thuật viên VuiHoc.
  - `ticket-formatter.ts`: module định dạng ticket của Tiểu Linh (`formatTicketDescription`, `formatConfirmationMessage`, `buildAdviceComment`, `splitDiagnosis`, `symptomsOfDescription`, `quoteForPreview`, `groundIdentifierFields`, `appendTicketUpdateDescription`).
  - `domain.ts`: khai báo `ticketDomain` (`IssueDomain`), `reporterShape`, trích xuất số điện thoại `extractAccounts`, `isPhoneNumber`, và `getRecommendedSoftFields`.
  - `create-issue-description.ts`: xây dựng công cụ `createIssue`, tạo bản xem trước, kiểm soát ADR-0010 (mô tả ticket nguyên văn, chẩn đoán đưa sang comment riêng mang marker bot, best-effort comment).
  - `validate.ts`: `validateFields`, `validateOne`, `inferProductKey`, cùng hằng nhãn tiếng Việt `FIELD_PROMPT_LABELS`, `NON_PROMPT_FIELDS`, `EXHAUSTED_DEFAULTS`, `DEFAULT_SYNONYMS`.
  - `priority.ts`: công cụ `assessPriority` thẩm định mức ưu tiên dựa trên bằng chứng và luật floor/ceiling.
  - `issues.ts`: công cụ `getIssue`, `updateIssue` kèm từ vựng `DEFAULT_ISSUE_VOCABULARY`.

### Target 2: `apps/tieulinh/copy.ts` — Kho chữ lễ tân của app
- Mở rộng `apps/tieulinh/copy.ts` thành kho chữ đầy đủ cho lễ tân:
  - Khai báo trọn bộ `tieulinhReceptionistCopy: Record<CopyKey, string>` (và bí danh `tieuLinhCopy`) bao gồm toàn bộ các câu chào, hỏi thiếu thông tin, hỏi hệ thống/lý do gấp, tách ticket, bổ sung sau tạo, huỷ/đóng ticket, checklist review, nhãn nút và thông báo trạng thái tiếng Việt.
  - Tách bạch kho chữ production của app với ví dụ mẫu trong core (`packages/core/examples/tieulinh/copy.ts`).

### Target 3: `catalogFromValidationRules` generic ở core
- Triển khai hàm generic `catalogFromValidationRules` trong `packages/core/src/intake/gate/from-validation-rules.ts` và export từ `@vuihoc/bot-core/intake`:
  - Nhận `rules` (`ValidationRules`) và `fieldRequirements` (`FieldRequirementsTable`).
  - Nhận cấu hình tuỳ biến `CatalogFromValidationRulesOptions` (`labels`, `promptBuilder`, `nonPromptFields`, `exhaustedDefaults`, `synonyms`, `pairedVariantField`, `maxRetries`, `enforceValueRules`).
  - Hoàn toàn không hardcode dữ liệu của Tiểu Linh trong core.
  - Viết bài kiểm thử `packages/core/src/intake/gate/from-validation-rules.test.ts` kiểm tra tính hợp lệ và thẩm định giá trị.
  - Ghi nhận thay đổi vào `packages/core/CHANGELOG.md`.

### Target 4: Nối F3/F4 vào app
- Cập nhật `apps/tieulinh/env.ts`:
  - `TECH_INFO_REVIEW: z.enum(["off", "checklist", "llm"]).default("checklist")` (công tắc chính sách soát F4).
  - `ASK_LEARN_DB: z.string().min(1).optional()` (đường dẫn SQLite tự học F3).
- Tạo `apps/tieulinh/engine-config.ts`:
  - Dựng `tieulinhCatalog` từ `validation-rules.json` và `required_fields.json` qua `buildTieulinhCatalog`.
  - Dựng `tieulinhUrgency` từ `urgency-rules.json`.
  - Hàm `makeTieulinhEngine(w: TieulinhWiring)` cấu hình `IntakeEngine` với copy production từ `apps/tieulinh/copy.ts`, kho `learned` tự học từ `createAskLearnedLookup(w.askLearnDbPath)`, chính sách `techReviewPolicy`, và các cổng tracker/drafts/bindings.

### Target 5: Test chống trôi dữ liệu và bản ghi vàng
- Port đủ **82 ca test** legacy đặt cạnh code app trong `apps/tieulinh/domain/*.test.ts`:
  - `ticket-formatter.test.ts`: 37 ca (cleanMediaTags, formatIctTimestamp, splitDiagnosis, buildAdviceComment, formatTicketDescription, chặn định danh model tự bịa TECH-928, appendTicketUpdateDescription, formatConfirmationMessage).
  - `create-issue-description.test.ts`: 7 ca (mô tả nguyên văn, comment gợi ý mang marker bot, bản xem trước ADR-0008, model không đưa rawText, markdown không vỡ xem trước, best-effort comment, không tạo comment rác).
  - `rawtext-regression.test.ts`: 5 ca (SĐT lượt trước, văn bản tra cứu từ nguyên văn, rawText undefined, đoán hệ thống/lỗi từ rawText, moi SĐT từ tin nguyên văn).
  - `domain.test.ts`: 12 ca (danh tính người báo, sự cố 1 người hỏi thêm, toàn hệ thống không hỏi, moi SĐT, chuỗi giữ chỗ, bỏ null, SĐT trong diagnosis, rawText thắng description, diagnosis sang comment, customerId dạng SĐT, extractAccounts 2 ca).
  - `validate.test.ts`: 7 ca (subject_code chung chung, name_code sai format, enum chuẩn hoá, enum sai kèm danh sách cho phép, chặn rác, trường không luật, để trống).
  - `priority.test.ts`: 7 ca (hạ mức 1 người có workaround, nâng mức chặn giao dịch, sàn thắng trần, cả hệ thống, mức hợp lý giữ nguyên, thiếu bằng chứng nêu rõ, học sinh đơn lẻ sàn High).
  - `completeness.test.ts`: 7 ca (thiếu reporting_dept đính nút, đủ reporting_dept hoàn tất, hỏi quá 2 lần dùng default, chưa hết budget hỏi tiếp, đòi student_account khi không có sđt, có sđt không đòi thêm, infer product_key chọn nen_hoi).
- Thêm các bài kiểm thử parity bổ sung:
  - `validate-fields.parity.test.ts`: 6 ca parity cho `validate_fields` và enum đối chiếu giữa `validation-rules.json` và `taxonomy.ts`.
  - `issues.vocabulary.test.ts`: 4 ca parity cho `get_issue` và `update_issue` từ vựng/mã projectKey.
  - `pr14-flow-media.test.ts` (ở `packages/core/src/intake/engine/`): 1 ca flow kiểm tra J1 ("tin chỉ có ảnh không làm sập, ảnh được gắn vào tài liệu rồi tải lên ticket").
  - `golden.test.ts` (ở `apps/tieulinh/domain/`): 5 ca kiểm tra khớp từng byte (byte-identical) mô tả ticket, câu xác nhận, comment gợi ý, bổ sung cập nhật và escape preview.
- Cập nhật sổ đối chiếu `apps/tieulinh/receptionist-gap-register.test.ts`:
  - Chuyển toàn bộ 77 dòng của PR 14 từ `deferred` sang `ported` (trỏ trực tiếp tới các bài kiểm thử mới có thật).
  - Cập nhật số liệu trong `packages/core/docs/parity/ENGINE.md`: `total=450 core=61 ported=309 deferred=69 by-design=11` (PR 14 còn 0 dòng deferred).
  - Cập nhật bảng khoảng trống RFC 0002 §1.4 (`J1`, `K6`) và kế hoạch di trú §5 (`docs/rfc/0002-receptionist.md`).

---

## 2. File nào đổi

### File sửa đổi (`git diff`):
- `apps/tieulinh/copy.ts`: bổ sung `tieulinhReceptionistCopy` và `tieuLinhCopy` (129 khoá `CopyKey`).
- `apps/tieulinh/env.ts`: bổ sung `TECH_INFO_REVIEW` và `ASK_LEARN_DB`.
- `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển 77 dòng PR 14 sang `ported`.
- `docs/rfc/0002-receptionist.md`: cập nhật trạng thái J1, K6 sang "Đủ".
- `packages/core/CHANGELOG.md`: ghi nhận `catalogFromValidationRules`.
- `packages/core/docs/parity/ENGINE.md`: cập nhật số liệu `ported=309`, `deferred=69`, PR 14 = 0.
- `packages/core/src/intake/gate/index.ts`: export `from-validation-rules`.
- `packages/core/src/telegram/transport.test.ts`: bổ sung polling chờ event loop ổn định cho test async fire-and-forget.

### File tạo mới:
- `apps/tieulinh/engine-config.ts`
- `apps/tieulinh/domain/types.ts`
- `apps/tieulinh/domain/taxonomy.ts`
- `apps/tieulinh/domain/ticket-formatter.ts`
- `apps/tieulinh/domain/domain.ts`
- `apps/tieulinh/domain/create-issue-description.ts`
- `apps/tieulinh/domain/validate.ts`
- `apps/tieulinh/domain/priority.ts`
- `apps/tieulinh/domain/issues.ts`
- `apps/tieulinh/domain/validation-rules.json`
- `apps/tieulinh/domain/urgency-rules.json`
- `apps/tieulinh/domain/required_fields.json`
- `apps/tieulinh/domain/product_mapping.json`
- `apps/tieulinh/domain/tech_accounts.json`
- `apps/tieulinh/domain/tech-info-needs.md`
- `apps/tieulinh/domain/ticket-formatter.test.ts` (37 ca)
- `apps/tieulinh/domain/create-issue-description.test.ts` (7 ca)
- `apps/tieulinh/domain/rawtext-regression.test.ts` (5 ca)
- `apps/tieulinh/domain/domain.test.ts` (12 ca)
- `apps/tieulinh/domain/validate.test.ts` (7 ca)
- `apps/tieulinh/domain/priority.test.ts` (7 ca)
- `apps/tieulinh/domain/completeness.test.ts` (7 ca)
- `apps/tieulinh/domain/validate-fields.parity.test.ts` (6 ca)
- `apps/tieulinh/domain/issues.vocabulary.test.ts` (4 ca)
- `apps/tieulinh/domain/golden.test.ts` (5 ca)
- `packages/core/src/intake/gate/from-validation-rules.ts`
- `packages/core/src/intake/gate/from-validation-rules.test.ts` (2 ca)
- `packages/core/src/intake/engine/pr14-flow-media.test.ts` (1 ca)

---

## 3. Lệnh đã chạy và kết quả thật

1. `bun test apps/tieulinh/domain`:
   ```
   97 pass, 0 fail, 237 expect() calls across 10 files.
   ```
2. `bun test packages/core/src/intake/gate/from-validation-rules.test.ts`:
   ```
   2 pass, 0 fail, 14 expect() calls.
   ```
3. `bun test packages/core/src/intake/engine/pr14-flow-media.test.ts`:
   ```
   1 pass, 0 fail, 6 expect() calls.
   ```
4. `bun test apps/tieulinh/receptionist-gap-register.test.ts`:
   ```
   9 pass, 0 fail, 1241 expect() calls across 1 file.
   ```
5. `bun test packages/core/src/intake/engine/golden-intake.test.ts`:
   ```
   9 pass, 0 fail, 11 expect() calls.
   ```
6. `bun run check`:
   ```
   @vuihoc/bot-core check: Exited with code 0
   @vuihoc/tl2-shadow check: Exited with code 0
   @vuihoc/tieulinh check: Exited with code 0
   @vuihoc/tieulinh-legacy check: Exited with code 0
   ```
7. `bun run docs:check`:
   ```
   build complete in 48.08s.
   Mẫu code: 26 ts check, 14 ts run, 2 ts no-check.
   Docs khớp code: 48 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
   ```
8. `bun run verify`:
   ```
   - biome check .: 0 errors
   - lint-baseline: không tăng lỗi
   - check: 4/4 packages pass
   - test: all packages pass
   - test:scripts: 61 pass, 0 fail
   - scan: public-hygiene scan clean
   - docs:snippets: 26 ts check, 14 ts run, 2 ts no-check
   - docs:refs: 48 trang khớp
   ```

---

## 4. Test nào thêm, test nào port

- **82 ca test legacy được port nguyên vẹn tên**:
  - 37 ca trong `apps/tieulinh/domain/ticket-formatter.test.ts`
  - 7 ca trong `apps/tieulinh/domain/create-issue-description.test.ts`
  - 5 ca trong `apps/tieulinh/domain/rawtext-regression.test.ts`
  - 12 ca trong `apps/tieulinh/domain/domain.test.ts`
  - 7 ca trong `apps/tieulinh/domain/validate.test.ts`
  - 7 ca trong `apps/tieulinh/domain/priority.test.ts`
  - 7 ca trong `apps/tieulinh/domain/completeness.test.ts`
- **11 ca test parity/flow legacy bổ sung**:
  - 6 ca trong `apps/tieulinh/domain/validate-fields.parity.test.ts`
  - 4 ca trong `apps/tieulinh/domain/issues.vocabulary.test.ts`
  - 1 ca trong `packages/core/src/intake/engine/pr14-flow-media.test.ts`
- **7 ca test mới**:
  - 2 ca unit test trong `packages/core/src/intake/gate/from-validation-rules.test.ts`
  - 5 ca golden byte-identical trong `apps/tieulinh/domain/golden.test.ts`

---

## 5. Còn dở gì và thuộc PR nào

- Toàn bộ nội dung của PR 14 (issue #28) đã hoàn thành 100%. Không còn phần dở nào thuộc PR 14.
- PR kế tiếp trong chuỗi di trú lễ tân: **PR 15** (`feat(core/bot): defineBot lễ tân thành pack MCP và skill` — issue #29, 11 ca deferred của tool MCP `create_issue`, `check_required_fields`, `validate_fields`).
