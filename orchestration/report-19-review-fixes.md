# Báo cáo sửa 9 điểm review PR 5 (Issue #19)

Worktree: `~/orca/workspaces/ticket/feat-pr-5-extractor` (nhánh `minhdevtry/feat-pr-5-extractor`).

Đã rà soát và khắc phục toàn bộ 9 điểm reviewer chỉ ra cho PR 5 theo đặc tả `orchestration/specs/issue-19-pr-5-review-fixes.md`. Không chạm vào `apps/tieulinh-legacy/**`, không commit, không push.

---

## 1. Chi tiết 9 mục đã sửa

### Mục 1: Mã CRM — lấy mã đầu tiên thay vì mã cuối
- **Vấn đề**: `extractor/heuristics.ts:714-717` mất `break` so với legacy `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts:381-384`, khiến tin nhắn chứa nhiều dòng mã CRM độc lập bị lấy mã ở dòng cuối cùng thay vì dòng đầu tiên.
- **Sửa**: Thêm `break;` ngay sau khi gán `out.customer = m[1];` trong `extractLabelledIdentifiers` tại `packages/core/src/intake/extractor/heuristics.ts:715`.
- **Test bổ sung**: Thêm ca test `mã CRM: lấy mã đầu tiên thay vì mã sau khi có nhiều dòng mã CRM độc lập` trong `packages/core/src/intake/extractor/extractor.test.ts`.

### Mục 2: Gộp triệu chứng — giữ 30 triệu chứng cuối, dedup giữ nguyên hoa thường, lọc token nội bộ
- **Vấn đề**: `extractor/merger.ts` giữ 30 triệu chứng đầu thay vì 30 triệu chứng cuối (`slice(-MAX_SYMPTOMS)`); dedup chuyển chữ thường làm "Lỗi X" và "lỗi x" bị gộp; mất bộ lọc `isInternalCallbackToken` khiến token nội bộ như "noop" lọt vào triệu chứng và `rawText` (vi phạm ADR-0010).
- **Sửa**: Trong `packages/core/src/intake/extractor/merger.ts`:
  - Dùng `isInternalCallbackToken` từ `@vuihoc/bot-core/core`.
  - Bỏ tin nhắn chỉ chứa token nội bộ khỏi `rawText`: `if (carriesText && message && !isInternalCallbackToken(message))`.
  - Lọc token nội bộ khỏi triệu chứng: `incomingSymptoms.filter((s) => !isInternalCallbackToken(s))`.
  - Dedup bằng `new Set([...keptPrev, ...incomingSymptoms].filter(Boolean))` (so sánh phân biệt hoa thường, không chuyển chữ thường) và lấy 30 phần tử cuối: `.slice(-MAX_SYMPTOMS)`.
- **Test bổ sung**: Thêm 3 ca test trong `packages/core/src/intake/extractor/extractor.test.ts`:
  - `gộp triệu chứng: giữ 30 triệu chứng cuối khi vượt trần`
  - `gộp triệu chứng: dedup không hợp nhất phân biệt hoa thường`
  - `gộp triệu chứng & rawText: loại bỏ token nội bộ như noop`

### Mục 3: Đường lùi tương đương với `extract` của core
- **Vấn đề & Quyết định**: Hàm `extract()` của `packages/core/src/llm/extract.ts` được thiết kế nhận một `LlmClient` duy nhất, bắt buộc khung lời nhắc tiếng Anh `<input>...</input>` và không hỗ trợ chuỗi fallback model đa provider (`openai`, `anthropic`, `openclaw` CLI). Do đó, `FieldExtractor` sử dụng đường lùi tương đương hoàn chỉnh:
  - Dùng `buildExtractorSchema(this.domain)` từ `./schema` để kiểm tra Zod schema.
  - Khi model trả về chuỗi không phải JSON hoặc vi phạm schema, gửi yêu cầu **hỏi lại đúng một lần** kèm danh sách chi tiết các lỗi (`check.error.issues`).
  - Khi model từ chối trả lời (gặp cờ `content_filter` hoặc `refusal` / `LlmContentFilterError`), dừng ngay lập tức, không hỏi lại.
  - Khi hết lượt hỏi hoặc LLM chết, rơi về heuristic tất định và xoá tiêu đề dự phòng.
- **Test bổ sung**: Thêm ca test `hỏi lại đúng một lần khi JSON đầu tiên không hợp lệ` trong `packages/core/src/intake/extractor/llm-extractor.test.ts`.

### Mục 4: Chuỗi model dự phòng hỗ trợ đa provider và phân loại HTTP status
- **Vấn đề**: `defaultComplete` chỉ gọi `/chat/completions`, không hỗ trợ `anthropic` và `openclaw` như legacy `worker/llm.ts`; phân loại lỗi để chuyển model dựa vào regex message thay vì HTTP status.
- **Sửa**: Trong `packages/core/src/intake/extractor/llm-extractor.ts`:
  - Định nghĩa `LlmClientError` cho mã lỗi HTTP 4xx (trừ 429).
  - Tách các hàm gọi theo từng provider: `completeOpenAi` (`/chat/completions`), `completeAnthropic` (`/v1/messages` với header `x-api-key` và `anthropic-version`), `completeOpenclaw` (chạy subprocess `openclaw infer model run`).
  - Trong `defaultComplete`: bắt `LlmClientError` và `LlmContentFilterError` để dừng chuỗi thử lại ngay lập tức (không thử model dự phòng nếu request sai hoặc bị từ chối); tiếp tục thử model dự phòng với lỗi 5xx, 429 hoặc lỗi mạng.
- **Test bổ sung**: Thêm ca test `chuỗi model dự phòng: lỗi 4xx client dừng ngay không thử model tiếp theo` trong `packages/core/src/intake/extractor/llm-extractor.test.ts`.

### Mục 5: Danh mục mặc định đồng bộ hoàn toàn với legacy
- **Vấn đề**: `extractor/taxonomy.ts` có danh mục sản phẩm và nhóm lỗi khác với legacy, thứ tự `VALID_SYSTEMS` khác khiến `detectSystem` first-match cho kết quả sai lệch.
- **Sửa**: Cập nhật `packages/core/src/intake/extractor/taxonomy.ts` khớp 100% với legacy `apps/tieulinh-legacy/mcp/tieulinh/domain/taxonomy.ts`:
  - `VALID_PRODUCTS`: `["Tự học", "Duo", "Pas", "Tutor", "Exam", "VNESchool", "K12 Viettel", "Smart Media", "Khác"]`
  - `VALID_SYSTEMS`: `["CRM_Vuihoc", "DUO_Vuihoc", "TUTOR_Vuihoc", "VH_Tự học", "LMS_Vuihoc", "CARE_Vuihoc", "ClassIn", "VNESCHOOL", "Khác_Hạ tầng_IT"]` (giữ nguyên thứ tự để first-match chuẩn xác).
  - `VALID_ERROR_CATEGORIES`: `["Lỗi hệ thống", "Lỗi kỹ thuật", "Lỗi dữ liệu", "Lỗi bên thứ 3", "Lỗi chưa xác định", "Hỗ trợ", "Khác", "Lỗi cấu hình máy", "Cải tiến sản phẩm", "ND bị nhầm hoặc hiểu sai", "Lỗi nhập liệu"]`
  - `VALID_REPORTING_DEPTS`: `["Vận hành", "Vận đơn", "CSKH", "CSHV", "Chuyên môn", "Sale", "Quản lý lớp"]`
  - `VALID_DEVICE_TYPES`: `["Điện thoại", "Máy tính bảng", "PC", "Laptop"]`
- **Test bổ sung**: Thêm ca test `danh mục mặc định khớp legacy` trong `packages/core/src/intake/extractor/llm-extractor.test.ts`.

### Mục 6: Ghi nhận `unrecognizedDept` khi gộp tờ khai
- **Vấn đề**: Khi người báo nêu bộ phận ngoài danh mục đóng (như "Kế toán"), `mergeDraftDocument` không ghi nhận `unrecognizedDept` (vốn đã có sẵn trong kiểu `LegacyDraftDocument`), khiến thông tin bị rơi mất.
- **Sửa**: Trong `packages/core/src/intake/extractor/merger.ts`, ghi nhận `unrecognizedDept` từ `extracted.reportingDeptUnrecognized`, và xoá đi khi trường `reportingDept` đã có giá trị hợp lệ (khớp legacy `pipeline.ts:860-862`).
- **Test bổ sung**: Thêm ca test `gộp trường: unrecognizedDept được ghi lại và xoá khi đã có reportingDept hợp lệ` trong `packages/core/src/intake/extractor/extractor.test.ts`.

### Mục 7: Ngữ cảnh LLM ghép lại câu báo vừa hỏi (`provide_info`)
- **Vấn đề**: `extractor/llm-extractor.ts` chỉ lấy một trong các trường `draftDescription ?? techQuestion ?? draftTitle`, bỏ mất câu báo ngữ cảnh của legacy `pipeline.ts:3233-3241`.
- **Sửa**: Trong `FieldExtractor.extract`, ghép đầy đủ tiêu đề, mô tả và câu báo:
  `"(Trợ lý vừa hỏi người báo: \"${ctx.techQuestion.trim()}\" — tin mới là câu trả lời, tức \"provide_info\".)"`.
- **Test bổ sung**: Thêm ca test `ngữ cảnh LLM: câu hỏi kỹ thuật vừa hỏi được đưa vào ngữ cảnh kèm câu báo provide_info` trong `packages/core/src/intake/extractor/llm-extractor.test.ts`.

### Mục 8: Đồng bộ số liệu parity trong `ENGINE.md`
- **Vấn đề**: Dòng `ported` ghi "PR 5 port thêm 45 dòng" trong khi bảng dưới và marker ghi 44 dòng (15 dòng PR 4 + 44 dòng PR 5 = 59 dòng).
- **Sửa**: Sửa văn bản tại dòng 63 của `packages/core/docs/parity/ENGINE.md` thành `PR 5 port thêm 44 dòng`.

### Mục 9: Cập nhật tài liệu `docs/` cho API công khai mới
- **Thực hiện**:
  - Viết tài liệu tiếng Việt đầy đủ tại `docs/reference/intake-extractor.md` trình bày chi tiết về `FieldExtractor`, `FieldExtractorOptions`, `ExtractorDomainConfig`, các luật heuristic tiếng Việt, đường lùi khi LLM chết (E5 / TECH-1146), và ranh giới miền giữa core và app. Tất cả các mẫu code đều có cờ `check` chuẩn xác.
  - Cập nhật sidebar tại `docs/.vitepress/config.ts` thêm mục "Bộ trích xuất sự cố (extractor)".
  - Cập nhật bảng tra cứu tại `docs/reference/index.md` và bảng subpath tại `docs/reference/entry-points.md`.

---

## 2. Bằng chứng kiểm chứng thực tế

| Lệnh đã chạy | Kết quả thực tế | Ghi chú |
|---|---|---|
| `bun test packages/core/src/intake/extractor/` | **60 pass, 0 fail** (178 expect() calls) | Bao gồm 44 ca legacy ported và các ca kiểm thử bổ sung cho 9 mục review |
| `bun test apps/tieulinh/receptionist-gap-register.test.ts` | **8 pass, 0 fail** (1227 expect() calls) | Toàn bộ sổ đối chiếu và phân bổ PR khớp hoàn toàn |
| `bun run scan` | **clean** (`✓ public-hygiene scan clean`) | Không lộ secret, IP nội bộ, home-path hay thông tin nhạy cảm |
| `bun run docs:check` | **EXIT=0** (180.48 s) | Build VitePress thành công, TypeDoc sinh API sạch, mẫu code (26 `ts check`, 14 `ts run`, 2 `ts no-check`), đối chiếu 48 trang docs khớp code |
| `bun run verify` | **EXIT=0** (116.75 s) | Toàn bộ suite verify (lint, baseline không tăng, typecheck 4 packages, toàn bộ test suite, scan-public, docs snippets & refs) đều xanh |
