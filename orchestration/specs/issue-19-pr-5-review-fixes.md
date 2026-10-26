# Sửa 9 điểm reviewer đặc tả chỉ ra cho PR 5 (issue #19)

Worktree: ~/orca/workspaces/ticket/feat-pr-5-extractor (nhánh `minhdevtry/feat-pr-5-extractor`).
Hai báo cáo review: `/tmp/review-19/spec-report.md` (trục đặc tả) và `/tmp/review-19/standards-report.md` (trục chuẩn hoá).

Sáu điểm đã sửa rồi (đừng làm lại): conflict marker trong `ENGINE.md`, ca test rỗng ở
`extractor-dept-system-title.test.ts`, prompt hardcode tên sản phẩm, đổi tên `IntakeDocument` ->
`LegacyDraftDocument`, ghi chú ranh giới miền trong `taxonomy.ts` và CHANGELOG.

## Còn 9 điểm, sửa hết

1. **Mã CRM: lấy mã CUỐI thay vì ĐẦU.** `extractor/heuristics.ts` khoảng dòng 714-717 mất `break`
   so với legacy `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts:381-384`. Tin nhiều sự cố
   thì `customerId` lấy khác legacy. Sửa cho khớp legacy và thêm test port.

2. **Gộp triệu chứng lệch (MỨC CAO).** `extractor/merger.ts` khoảng dòng 181-183:
   - Giữ **30 triệu chứng CUỐI**, legacy giữ cuối (`legacy/merger.ts:137`), đừng giữ đầu.
   - Dedup: legacy so sánh KHÔNG phân biệt hoa thường ("Lỗi X" và "lỗi x" là một), đừng hợp nhất
     chúng thành một.
   - **Mất bộ lọc token nội bộ**: legacy `merger.ts:130-134` lọc `isInternalCallbackToken` (vd
     "noop") khỏi triệu chứng. Không lọc thì "noop" lọt vào triệu chứng và `rawText` — vi phạm
     ADR-0010 (mô tả ticket nguyên văn, không có nội bộ). Dùng `isInternalCallbackToken` sẵn có
     ở `@vuihoc/bot-core/core`.
   Thêm test cho cả ba: giữ cuối, dedup không hợp nhất hoa thường, "noop" không lọt.

3. **Chưa dùng `extract` của core.** Đặc tả giao yêu cầu bộ trích xuất DỰA TRÊN `extract` của core
   (`packages/core/src/llm/extract.ts`), không phải tự gọi model rồi tự parse. Hiện chỉ dùng
   `parseJsonLoose` (`extractor/llm-extractor.ts:19`) nên mất vòng "hỏi lại ĐÚNG MỘT lần kèm danh
   sách lỗi cụ thể" và "model từ chối trả lời thì dừng ngay". Dùng `extract` của core, hoặc nếu
   `extract` không hợp với nhu cầu (nhiều lượt hỏi lại, chuỗi model dự phòng) thì giải thích rõ
   vì sao trong report và dùng đường lùi tương đương.

4. **Chuỗi model yếu hơn legacy.** `extractor/llm-extractor.ts` khoảng dòng 124-158: `defaultComplete`
   chỉ gọi `/chat/completions`, trong khi `LlmConfig.api` khai `anthropic | openclaw` và
   `isLlmConfigured` (`:94`) chấp nhận `openclaw` — có thể fetch nhầm `"undefined/chat/completions"`.
   Và phân loại lỗi để chuyển model (`:186`) dựa vào REGEX message thay vì HTTP status, nên dừng
   sớm hoặc thử dư. Sửa theo legacy `apps/tieulinh-legacy/worker/llm.ts`: gọi đúng endpoint theo
   `api`, phân loại theo HTTP status.

5. **Danh mục mặc định là danh mục thứ ba.** `extractor/taxonomy.ts`: products
   (`Tutor, Duo, Vuihoc247, Care, Tiểu học, THCS, THPT`) và error categories (`Lỗi đăng nhập,
   Lỗi nạp bài…`) KHÁC legacy (`Tự học, Duo, Pas, Tutor, Exam…`; `Lỗi hệ thống, Lỗi kỹ thuật…`),
   thứ tự `VALID_SYSTEMS` cũng khác nên `detectSystem` first-match khác legacy. Hệ quả: mọi giá trị
   legacy của `product`/`errorCategory` bị loại rơi, và prompt quảng bá sai danh mục.
   Sửa: danh mục mặc định phải BẰNG legacy (đây là PR parity), lấy từ
   `apps/tieulinh-legacy/lib/intake-step/extractor-schema.ts` và `multi-incident.ts`. Thứ tự cũng phải
   khớp legacy vì `detectSystem` lấy khớp đầu tiên.

6. **`unrecognizedDept` bị rơi khi gộp.** Legacy `pipeline.ts:861` ghi `doc.unrecognizedDept`;
   `extractor/merger.ts` không ghi nên thông tin bộ phận ngoài danh mục mất. Sửa: merger ghi nó
   (đã có trường trong `LegacyDraftDocument`), và thêm test.

7. **Ngữ cảnh LLM mất câu báo.** `extractor/llm-extractor.ts:224` chỉ lấy
   `draftDescription ?? techQuestion ?? draftTitle`, bỏ câu "vừa hỏi ⇒ provide_info" của legacy
   `pipeline.ts:3233-3241`. Sửa: ghép lại câu báo ngữ cảnh như legacy.

8. **Số liệu tự mâu thuẫn trong `packages/core/docs/parity/ENGINE.md`.** Dòng `ported` ghi "PR 5 port
   thêm 45 dòng" trong khi bảng dưới và marker ghi 44. Sửa cho khớp (44).

9. **Chưa cập nhật `docs/` cho API công khai mới.** `packages/core/src/intake/index.ts` export cả
   module `extractor` (API công khai mới) mà `docs/` chưa có trang nào. Theo `AGENTS.md`: đổi hành
   vi hoặc API công khai thì cập nhật `docs/` trong cùng PR. Viết `docs/reference/intake-extractor.md`
   (tiếng Việt) mô tả: `FieldExtractor`, `FieldExtractorOptions` (kể cả `systemPrompt` và `domain`),
   `ExtractorDomainConfig`, heuristic tiếng Việt nào có, đường lùi khi LLM chết, và ranh giới miền
   (từ đồng nghĩa theo miền là dữ liệu của app, PR 14 đưa vào). Thêm trang vào sidebar
   `docs/.vitepress/config.ts` và vào `docs/reference/index.md` nếu có mục liệt kê. Mẫu `ts` trong docs
   phải có cờ `check`, `run` hoặc `no-check`.

## Ràng buộc

- Chỉ sửa trong worktree này. KHÔNG commit, KHÔNG push, KHÔNG mở PR (coordinator sẽ commit và push).
- Không sửa `apps/tieulinh-legacy/**`.
- Không dùng `any`, không dùng khoá non-null trong code mới. Không nới `biome.lint-baseline.json`.
- Port thêm test cho mỗi bản sửa ở mục 1, 2, 6; mục 4, 5, 7 cần test đi kèm nếu có thể.
- Cập nhật sổ đối chiếu `apps/tieulinh/receptionist-gap-register.test.ts` nếu có dòng liên quan, và
  số liệu `packages/core/docs/parity/ENGINE.md` (marker + bảng "số test deferred theo PR").

## Điều kiện hoàn thành

- `bun run verify` -> EXIT=0.
- `bun run docs:check` -> EXIT=0.
- Cả 9 mục trên đã xử lý, mỗi mục có bằng chứng (lệnh + kết quả) trong report.
- `orchestration/report-19-review-fixes.md`: liệt kê 9 mục, sửa gì ở đâu, lệnh đã chạy, kết quả thật.

Khi xong gửi đúng một lần:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 5: đã sửa 9 điểm review" \
  --body "<3 câu: đã sửa mục nào, verify/docs kết quả, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --report-path orchestration/report-19-review-fixes.md --json
```
