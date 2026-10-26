# Task spec: PR 5 của RFC 0002 — llmExtractor và heuristic tiếng Việt (issue #19)

## Context

Repo: `minhdevtry/ticket` (công khai, Bun monorepo). Đây là PR 5 của chuỗi lễ tân trong
`docs/rfc/0002-receptionist.md` mục 5. PR 1-4 đã merge (PR #15, #14, #16, #36).

Worktree: `feat-pr-5-extractor`, nền là `main` (đã có PR 4: draft v2, chuẩn hoá đầu vào,
`ExtractInput.context`, bảng ánh xạ `action`).

Đọc trước khi sửa:
- `AGENTS.md` (bản đồ, lệnh, nguyên tắc) và `CODING_STANDARDS.md` (quy tắc phán đoán).
- `packages/core/GLOSSARY.md` (thuật ngữ) và `docs/rfc/0002-receptionist.md` mục 1.5
  (bảng E1-E5, A11-A14) — đó là nguồn đặc tả chi tiết.
- `docs/rfc/0002-receptionist.md` mục 2.1 (ranh giới máy trạng thái, luật: LLM chỉ ở ba
  cổng, mỗi cổng có đường lùi tất định).

## Target

- Mô-đun mới ở `packages/core/src/intake/` cho bộ trích xuất và heuristic tiếng Việt.
- `packages/core/src/intake/ports.ts` (cổng `FieldExtractorPort` và `ExtractInput.context`).
- `packages/core/src/intake/gate/normalize.ts` và `packages/core/src/intake/priority/priority.ts`
  (đã có một phần theo RFC; xem có dùng lại được không).
- Test tương ứng đặt cạnh file nguồn.
- `packages/core/CHANGELOG.md`, `packages/core/docs/parity/ENGINE.md` (số liệu sổ đối chiếu).
- `apps/tieulinh/receptionist-gap-register.test.ts` (sổ đối chiếu của PR 1).
- `docs/` nếu đổi hành vi công khai.

## Change

Bộ trích xuất dựa trên `extract` của core (`packages/core/src/llm/extract.ts` — có sẵn:
parse JSON có sửa, hỏi lại đúng một lần kèm danh sách lỗi, dừng nếu model từ chối).
Cần làm được 5 phần (mã ở RFC mục 1.5):

- **E2 — chuẩn hoá sau LLM**: từ đồng nghĩa hệ thống/bộ phận về danh mục; bộ phận CHỈ nhận
  khi tin nhắn thực sự nhắc tới; luật SĐT (10 số 03/05/07/08/09 là tài khoản/SĐT phụ
  huynh, không phải mã KH); tiêu đề không được là tên/mã.
  Theo RFC mục 2.x: heuristic tiếng Việt tổng quát thuộc CORE, còn từ đồng nghĩa theo
  miền thuộc DỮ LIỆU của app — thiết kế cho phép app đưa từ đồng nghĩa vào mà core không
  cần biết miền nào.
- **E3 — suy ý định tĩnh**: xác nhận, huỷ, cảm ơn, từ chối trả lời, bổ sung, báo lỗi.
  KHÔNG cần LLM. `"ok"` và `"không vào được lớp"` KHÔNG phải huỷ.
- **E4 — bù bằng chứng**: khi LLM im, cụm rõ ràng trong lời kể thắng cờ `false` mặc định
  của model.
- **E5 — tín hiệu "LLM không dùng được"**: khi LLM chết, KHÔNG bịa tiêu đề. Cần chuỗi model
  dự phòng (xem `apps/tieulinh-legacy/worker/llm.ts` để biết legacy làm thế nào).
- **A14 — lệnh sửa tờ khai**: lệnh sửa tường minh ("sửa tiêu đề thành …") thắng LLM, tiêu đề
  do người đặt bị khoá (core đã có `titleExplicit` ở `ports.ts`).

Tiêu chí chấp nhận cụ thể (từ hàng PR 5 của RFC):
- Với `FakeLlm`: lược đồ hợp lệ, từ đồng nghĩa, bộ phận chỉ khi nhắc, luật SĐT;
  "LLM chết" không ra tiêu đề; heuristic không phụ thuộc LLM.

## Test phải port (giữ nguyên tên test của legacy để sổ đối chiếu trỏ tới được)

- `apps/tieulinh-legacy/lib/intake-step/extractor.test.ts` (2)
- `apps/tieulinh-legacy/lib/intake-step/extractor-rules.test.ts` (21)
- `apps/tieulinh-legacy/lib/intake-step/extractor-dept-system-title.test.ts` (12)
- `apps/tieulinh-legacy/lib/intake-step/extractor-evidence.test.ts` (10)

Cộng 45 ca. Mỗi ca port phải mở đầu bằng mã sự cố gốc nếu legacy có (ví dụ TECH-1146
cho E2) — `CODING_STANDARDS.md` yêu cầu thay đổi hành vi phải kèm mã sự cố.

Cập nhật sổ đối chiếu `apps/tieulinh/receptionist-gap-register.test.ts`: các dòng của bốn
file test trên đổi `deferred` -> `ported` và trỏ tới test mới; nếu có ca KHÔNG port được
thì giữ `deferred` và ghi lý do. Cập nhật số liệu trong `packages/core/docs/parity/ENGINE.md`
(marker `gap-register: total=... core=... ported=... deferred=... by-design=...` phải khớp).

## Ràng buộc

- Logic tất định ở tool và engine; LLM chỉ ở cổng `extract` của core, mỗi cổng có đường
  lùi tất định (LLM chết -> heuristic, không bịa tiêu đề).
- Không dùng `any` và không dùng khoá non-null (`!`) trong code mới: hai rule đó đang tắt
  nhưng có `lint:baseline` canh số lỗi không được tăng.
- `apps/tieulinh-legacy/**` là bản tham chiếu đóng băng: CHỈ ĐỌC, không sửa, không import
  code legacy vào app mới.
- Sửa `packages/core` thì phải thêm test trong core và ghi `packages/core/CHANGELOG.md`.
- Đổi hành vi hoặc API công khai thì cập nhật `docs/` trong cùng PR; CI chặn nếu thiếu.
  Mẫu `ts` trong docs phải có cờ `check`, `run` hoặc `no-check`.
- Tên và thuật ngữ theo `packages/core/GLOSSARY.md`.

## Ownership

Worker được phép sửa: `packages/core/**`, `docs/**` (phần liên quan),
`apps/tieulinh/receptionist-gap-register.test.ts` (đúng một file sổ đối chiếu),
`orchestration/report-19.md`.

Worker KHÔNG được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.

Worker KHÔNG được: chạy `git commit`, `git push`, mở PR, merge, chạm production, in secret,
ghi ra ngoài Ownership, hay nới `biome.lint-baseline.json`.

## Observable acceptance

Bằng chứng phải kèm theo, nêu rõ lệnh đã chạy và kết quả thật:

1. 45 ca port của bốn file test legacy, tên ca giữ nguyên, đều xanh.
2. Test mới cho: lược đồ hợp lệ (FakeLlm), từ đồng nghĩa, bộ phận chỉ khi nhắc, luật SĐT,
   "LLM chết" không ra tiêu đề, heuristic không phụ thuộc LLM.
3. Sổ đối chiếu xanh và số liệu `ENGINE.md` khớp.
4. `bun run verify` -> EXIT=0. `bun run docs:check` -> EXIT=0.
5. `packages/core/CHANGELOG.md` có mục cho PR 5, ghi rõ phần nào hoãn.

## Forbidden

- `docker image prune -a`, `docker system prune`, `docker volume prune`
- `pkill -f`, kill tiến trình Orca, restart Orca
- lệnh git có `-f` (`reset --hard`, `clean -fd`, `push --force`), `git commit`, `git push`
- sửa file ngoài Ownership
- in nội dung file `.env`, `*.key`, `secrets/`, `~/.openclaw/**`
- tự tạo issue, tự sửa issue, tự đóng issue
- nới `biome.lint-baseline.json` để cho xanh

## Báo cáo

Ghi `orchestration/report-19.md` trong worktree: đã làm gì, file nào đổi, lệnh đã chạy và kết
quả thật, test nào thêm, cái gì còn dở (kèm PR nào làm tiếp).

## Điều kiện hoàn thành

Đủ các mục trong "Observable acceptance", `verify` và `docs:check` EXIT=0, và
`orchestration/report-19.md` có mục báo cáo. Không cần báo cáo dài.

Khi xong, gửi đúng một lần:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 5 / issue #19 xong" \
  --body "<tóm tắt ba câu: đã làm gì, verify/docs:check kết quả, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-19.md --json
```

`DISPATCH_ID` và `TASK_ID` lấy từ preamble mà Orca đưa cho bạn. Nếu thất bại thì
`--outcome failed` và nêu rõ chỗ vướng. Trước khi gửi `worker_done`, chạy
`orca orchestration check --terminal <handle> --json` để đọc follow-up của coordinator.
