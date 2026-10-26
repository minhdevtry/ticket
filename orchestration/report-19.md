# Báo cáo PR 5: llmExtractor và heuristic tiếng Việt (issue #19)

## 1. Công việc đã thực hiện

- **Mô-đun trích xuất và heuristic mới tại `packages/core/src/intake/extractor/`**:
  - `taxonomy.ts`: Danh mục đóng (`VALID_PRODUCTS`, `VALID_SYSTEMS`, `VALID_ERROR_CATEGORIES`, `VALID_REPORTING_DEPTS`, `VALID_DEVICE_TYPES`), bảng từ đồng nghĩa (`SYSTEM_SYNONYMS`, `DEPT_SYNONYMS`, `GENERIC_SYSTEM_KEYS`), và các hằng số giới hạn độ dài (`MAX_LLM_MESSAGE_CHARS`, `MAX_LLM_CONTEXT_CHARS`).
  - `heuristics.ts`: Bộ heuristic tiếng Việt tất định, độc lập hoàn toàn với LLM (RFC 0002 E2-E4, A14):
    - Nhận diện ý định tĩnh: `isShortConfirmation`, `isExplicitCancel`, `isDeclineAnswer`, `isChitchat`.
    - Lệnh sửa tờ khai: `parseEditCommand` ("sửa tiêu đề thành ...", "bỏ ý ...").
    - Bù bằng chứng ưu tiên: `inferEvidence` (`blocksLearning`, `blocksPayment`, `scope`).
    - Chuẩn hoá và phát hiện bộ phận: `normalizeWithSynonyms`, `detectSystem`, `deptMentioned`, `detectUnrecognizedDept`, `stripGreeting`, `isVietnamesePhone`.
    - Chốt chặn tiêu đề: `isInvalidTitle`, `deriveFallbackTitle`, `isPersonNameOnly`, `extractBlockInfo`, `extractLabelledIdentifiers`.
  - `schema.ts`: Hàm sinh lược đồ Zod (`buildExtractorSchema`, `describeExtractedKeys`) từ taxonomy cho phép tách dữ liệu miền của app khỏi core.
  - `merger.ts`: `mergeExtractedFields` bảo toàn tiêu đề người dùng tự đặt (`titleExplicit`), tóm tắt lại tiêu đề khi có mô tả mới, bảo toàn bằng chứng ưu tiên (không bị false hạ cờ, scope chỉ tăng), cắt trần độ dài triệu chứng và văn bản mô tả.
  - `llm-extractor.ts`: `FieldExtractor` triển khai `FieldExtractorPort`:
    - Chuỗi model dự phòng (E5): thử lần lượt các model cách nhau bằng dấu phẩy trong cấu hình, chuyển model khi gặp lỗi mạng/timeout/5xx/429.
    - Tín hiệu "LLM không dùng được" (E5 / TECH-1146): khi toàn bộ chuỗi model thất bại, rơi về heuristic nhưng KHÔNG bịa tiêu đề từ dòng đầu.
    - Chuẩn hoá sau LLM (E2): từ đồng nghĩa, bộ phận CHỈ nhận khi tin có nhắc, luật chuyển SĐT từ `customerId` sang `studentAccount`, chốt chặn từ chối tên người/mã làm tiêu đề.
    - Bù bằng chứng (E4): cụm từ rõ ràng trong tin nhắn thắng cờ `false` mặc định của model.
    - Lệnh sửa tờ khai tường minh (A14) thắng LLM.
  - `index.ts`: Re-export toàn bộ mô-đun extractor trong `@vuihoc/bot-core/intake`.

- **Cập nhật cổng và draft trong `packages/core/src/intake/`**:
  - `ports.ts`: Thêm `context?: string` và `createdTicket?: { identifier: string; title?: string }` vào `ExtractInput`; bổ sung các trường thuộc tính phẳng trên `ExtractedFields` phục vụ tương thích domain.
  - `draft/types.ts`: Thêm `titleExplicit?: boolean` vào `DraftTicket` và `unrecognizedDept?: string` vào `IntakeDraft`.

- **Port 45 ca kiểm thử legacy (giữ nguyên tên test chính xác)**:
  - `packages/core/src/intake/extractor/extractor.test.ts` (2 ca)
  - `packages/core/src/intake/extractor/extractor-rules.test.ts` (21 ca)
  - `packages/core/src/intake/extractor/extractor-dept-system-title.test.ts` (12 ca)
  - `packages/core/src/intake/extractor/extractor-evidence.test.ts` (10 ca)
  - Kèm `packages/core/src/intake/extractor/llm-extractor.test.ts` (6 ca kiểm thử tích hợp với `FakeLlm`).

- **Cập nhật sổ đối chiếu và tài liệu**:
  - `apps/tieulinh/receptionist-gap-register.test.ts`: Cập nhật 45 dòng test của 4 file trên từ `deferred` thành `ported` trỏ tới file test mới ở core; bổ sung `scripts/golden/record.test.ts` vào `FILE_ROWS`.
  - `packages/core/docs/parity/ENGINE.md`: Cập nhật marker và bảng số liệu: `total=450 core=69 ported=45 deferred=325 by-design=11`.
  - `packages/core/CHANGELOG.md`: Thêm mục thay đổi chi tiết cho PR 5.

## 2. Danh sách file thay đổi

- `packages/core/src/intake/ports.ts`
- `packages/core/src/intake/draft/types.ts`
- `packages/core/src/intake/index.ts`
- `packages/core/src/intake/extractor/taxonomy.ts` (mới)
- `packages/core/src/intake/extractor/heuristics.ts` (mới)
- `packages/core/src/intake/extractor/schema.ts` (mới)
- `packages/core/src/intake/extractor/merger.ts` (mới)
- `packages/core/src/intake/extractor/llm-extractor.ts` (mới)
- `packages/core/src/intake/extractor/index.ts` (mới)
- `packages/core/src/intake/extractor/extractor.test.ts` (mới)
- `packages/core/src/intake/extractor/extractor-rules.test.ts` (mới)
- `packages/core/src/intake/extractor/extractor-dept-system-title.test.ts` (mới)
- `packages/core/src/intake/extractor/extractor-evidence.test.ts` (mới)
- `packages/core/src/intake/extractor/llm-extractor.test.ts` (mới)
- `packages/core/CHANGELOG.md`
- `packages/core/docs/parity/ENGINE.md`
- `apps/tieulinh/receptionist-gap-register.test.ts`

## 3. Lệnh đã chạy và kết quả thật

1. `bun test packages/core/src/intake/extractor/`
   - Kết quả: 51 pass, 0 fail (156 expect calls) trên 5 file.
2. `bun test apps/tieulinh/receptionist-gap-register.test.ts`
   - Kết quả: 8 pass, 0 fail (1224 expect calls).
3. `bun run --cwd packages/core test`
   - Kết quả: 1135 pass, 0 fail (8553 expect calls) trên 89 file.
4. `bun run --cwd apps/tieulinh test`
   - Kết quả: 72 pass, 0 fail (1570 expect calls) trên 7 file.
5. `bun run check`
   - Kết quả: Exited with code 0 trên cả 4 workspace (`@vuihoc/tl2-shadow`, `@vuihoc/bot-core`, `@vuihoc/tieulinh`, `@vuihoc/tieulinh-legacy`).
6. `bun run lint` (`biome check .`)
   - Kết quả: 0 error.
7. `bun run scan` (`scripts/scan-public.ts`)
   - Kết quả: `✓ public-hygiene scan clean`.
8. `bun run docs:check`
   - Kết quả: Build VitePress thành công, TypeDoc sinh API docs, 41 trang docs khớp code, 0 broken link/snippet -> EXIT=0.
9. `bun run verify`
   - Kết quả: Toàn bộ chuỗi verify (lint + check + test + test:scripts + scan + docs:snippets + docs:refs) -> EXIT=0.

## 4. Phần còn hoãn

- 1 ca kiểm thử kịch bản flow (`lib/intake-step/pipeline.flow.test.ts`: "tin đầu 'Yêu cầu hỗ trợ: …' / 'ok app Duo lỗi…' không bao giờ tạo ticket") tiếp tục hoãn sang PR 7 (hỏi bổ sung theo luật).
- Câu hỏi động cho bộ phận ngoài danh mục trong luồng tương tác engine tiếp tục hoàn thiện ở PR 7 (hỏi bổ sung theo luật, bộ phận ngoài danh mục).
