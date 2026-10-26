# Task spec: PR 4 của RFC 0002, draft v2 và chuẩn hoá đầu vào (issue #18)

## Context

Repo: `minhdevtry/ticket` (công khai, Bun monorepo). Đây là PR thứ 4 trong chuỗi lễ tân của `docs/rfc/0002-receptionist.md` mục 5. PR 1 (sổ đối chiếu) và PR 2 (khung kịch bản + bản ghi vàng) đã merge. PR 3 (kho binding tương thích) là PR #16, đang mở, phải merge trước khi có canary nào.

Repo này có hai bộ quy tắc bắt buộc: `AGENTS.md` ở gốc và `GLOSSARY.md` trong `packages/core/`. Đọc cả hai trước khi sửa.

## Target

- `packages/core/src/intake/**` (engine, draft store, chuẩn hoá đầu vào)
- `packages/core/src/bot/**` (hợp đồng `intake_step` mà persona và skill OpenClaw phụ thuộc)
- Test tương ứng trong `packages/core/src/intake/**/*.test.ts`
- `packages/core/CHANGELOG.md`
- `docs/` nếu thay đổi hành vi công khai

## Change

Làm đúng hàng "PR 4" của bảng ở `docs/rfc/0002-receptionist.md` mục 5, đọc mục 2.1 và mục 2.3 của cùng RFC để lấy chi tiết:

1. **Draft có phiên bản.** Thêm các trường mà `IntakeDraft` hiện thiếu so với legacy: `lastAskedFields`, `requestedPriority`, `techReviewDone`/`techQuestion`, `unrecognizedDept`, `pendingSplit` (kèm hàng đợi, `extraText`, `clarifyCount`), `mediaAmbiguous`, các trường `pendingNewIncident` đầy đủ, và dấu của việc nền. Cách thêm: **cộng thêm, có phiên bản**, và phải đọc được draft cũ (migrate khi đọc).
2. **Chuẩn hoá đầu vào** (tiền xử lý tất định, không LLM): tin vô nghĩa (A11), từ chối (A13), `appendRawText`, trần `rawText` theo legacy.
3. **`ExtractInput.context`**: thêm trường ngữ cảnh vào đầu vào của extractor.
4. **`StepOutput` có nút cho câu hỏi**: `messages` mang `{ text, buttons }`.
5. **Kết quả mới và bảng ánh xạ `action`** (mục 2.3): thêm `clarify`, `split_question`, `closed_refusal`, `canceled`; viết hàm ánh xạ giữa `action` của legacy và `StepOutcome` của core; **bảng ánh xạ phải có test** (mỗi dòng một test case).

## Constraints

- Logic tất định nằm ở tool và engine, không chuyển quyết định nghiệp vụ vào prompt (nguyên tắc của `AGENTS.md`).
- Câu chữ gửi người báo không do LLM sinh.
- Không vi phạm bất biến: không ghi vào ticket đã có nếu chưa có cú bấm khớp nhãn nút chính xác (ADR-0008), không tự xác nhận thay người báo, mô tả ticket là nguyên văn (ADR-0010), không ghi đè định danh của ticket đã tạo.
- Một lượt, một khoá chat (`withChatLock` ở `packages/core/src/intake/confirm/lock.ts`).
- Engine không biết Telegram, OpenClaw, itsaplan: hiệu ứng ra ngoài chỉ qua cổng.
- `apps/tieulinh-legacy` là **bản tham chiếu đóng băng**: chỉ đọc, không sửa. Không import code legacy vào app mới.
- Sửa core thì phải thêm test trong core và ghi `packages/core/CHANGELOG.md`.
- Đổi hành vi hoặc API công khai thì cập nhật `docs/` trong cùng PR; CI chặn nếu thiếu. Mẫu `ts` trong docs phải có cờ `check`, `run` hoặc `no-check`.

## Ownership

Worker được phép sửa: `packages/core/**`, `docs/**` (chỉ phần liên quan), `orchestration/report-18.md` (báo cáo).

Worker **không** được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/scan-public.ts`, `package.json` gốc, `bun.lock`.

Worker **không** được: chạy lệnh git push, mở PR, merge, đụng production, in secret, hay ghi ra ngoài `packages/core` và `docs`.

## Observable acceptance

Bằng chứng phải kèm theo, nêu rõ lệnh đã chạy và kết quả:

1. `bun run --cwd packages/core test` xanh, và **23 test cũ của engine vẫn xanh** (không được xoá hay nới lỏng để làm xanh).
2. Test mới cho: migrate draft cũ; bảng ánh xạ `action`; chuẩn hoá đầu vào (tin vô nghĩa, từ chối, `appendRawText`, trần `rawText`); `ExtractInput.context`; nút cho câu hỏi trong `StepOutput`.
3. Test legacy được port theo hàng PR 4: `noop-guard.test.ts` (6), `repository.test.ts` của tài liệu (6), và các flow: "ok chưa tóm tắt", "không biết", "không vào được lớp không huỷ", "xác nhận hai lần", "phong bì", "tin dài". Sổ đối chiếu (`packages/core/.../gap-register` hoặc file tương ứng của PR 1) phải được cập nhật nếu có dòng liên quan.
4. `bun run verify` sạch (lint + check + test + test:scripts + scan + kiểm docs).
5. `bun run docs:check` sạch nếu có đổi docs.
6. `packages/core/CHANGELOG.md` có mục cho thay đổi này.

## Forbidden

- `docker image prune -a`, `docker system prune`, `docker volume prune`
- `pkill -f`, kill tiến trình Orca, restart Orca
- chạy lệnh git có `-f` (`reset --hard`, `clean -fd`, `push --force`), `git commit`, `git push`
- sửa file ngoài `Ownership`
- in nội dung file `.env`, `*.key`, `secrets/`, `~/.openclaw/**`
- tự tạo issue, tự sửa issue, tự đóng issue

## Báo cáo

Ghi `orchestration/report-18.md` trong worktree: đã làm gì, file nào đổi, lệnh đã chạy và kết quả thật, test nào thêm, cái gì còn dở.

Khi xong, gửi đúng một lần:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done --subject "PR 4 / issue #18 xong" --body "<tóm tắt ba câu>" --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --files-modified "<danh sách file>" --report-path orchestration/report-18.md --json
```

`DISPATCH_ID` và `TASK_ID` lấy từ preamble mà Orca đưa cho bạn. Nếu thất bại thì `--outcome failed` và nêu rõ chỗ vướng. Trước khi gửi `worker_done`, chạy `orca orchestration check --terminal <handle> --json` để đọc follow-up của coordinator.
