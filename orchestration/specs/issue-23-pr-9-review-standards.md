# Đặc tả: review trục chuẩn hoá code — PR 9 (issue #23)

## Vai

Reviewer độc lập, **chỉ đọc**. Không sửa file, không commit, không push, không mở/merge PR,
không chạy lệnh git làm đổi trạng thái (checkout/reset/clean/stash/merge/rebase).

## Bối cảnh

- Repo: `minhdevtry/ticket`. Worktree hiện tại đang ở nhánh `minhdevtry/feat-pr-9-split`,
  PR https://github.com/minhdevtry/ticket/pull/55, issue #23.
- PR 9 của chuỗi lễ tân `docs/rfc/0002-receptionist.md`: port B7 — tách báo cáo nhiều sự cố.
- Diff cần soi: `git diff origin/main...HEAD` (18 file, +1783/-61).
- Đọc trước: `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`,
  `packages/core/GLOSSARY.md`, và `orchestration/specs/issue-23-pr-9-split.md`.

## Target

Chất lượng code, test, tài liệu của PR 9. Không đánh giá lại thiết kế RFC (reviewer trục đặc
tả lo phần hành vi).

## Việc phải làm

1. **Chuẩn hoá code**
   - Không `any`, không non-null `!` trong code mới; `bun run lint:baseline` không tăng.
   - Một hằng/hàm/kiểu một chủ: grep trước khi kết luận là trùng lặp.
   - Tên theo `packages/core/GLOSSARY.md`; core không hardcode tên sản phẩm/công ty/hệ thống
     của một app — dữ liệu miền đi qua tham số.
   - Logic tất định ở engine/tool; prompt chỉ diễn đạt (PR này không có prompt).
   - Không sửa `apps/tieulinh-legacy/**`; không đụng `.github/**`, `scripts/**`,
     `biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.
2. **Test**
   - Test đặt cạnh file nguồn; khẳng định trên đầu ra hệ thống, không tự dựng chuỗi rồi assert
     chính nó; không phụ thuộc thời gian thật; không nới lỏng test cũ.
   - 22 ca port giữ nguyên tên và ý so với legacy; đối chiếu `multi-incident.test.ts` và
     `split-adversarial.test.ts` của legacy.
   - Có ca đối kháng thật (không phải bản sao của ca thường).
3. **Docs / CHANGELOG / sổ đối chiếu**
   - `packages/core/CHANGELOG.md` có mục cho thay đổi.
   - `packages/core/docs/parity/ENGINE.md`: marker và bảng deferred khớp sổ.
   - `apps/tieulinh/receptionist-gap-register.test.ts`: `ported` chỉ khi hành vi đã port thật.
   - Docs đổi hành vi/API công khai trong cùng PR.
4. **Chạy (chỉ mục tiêu, không full suite)**
   - `bun run lint`
   - `bun run lint:baseline`
   - `bun test packages/core/src/intake/split/split.test.ts`
   - `bun test packages/core/src/intake/engine/pr9-split.test.ts`
   - `bun test packages/core/src/intake/engine/split-adversarial.test.ts`
   - `bun test apps/tieulinh/receptionist-gap-register.test.ts`

## Constraints

- Không chạy `bun run verify` hay `bun test` toàn repo: máy dev đang thiếu RAM, coordinator đã
  chạy full và ghi bằng chứng.
- Không `docker ... prune`, `pkill -f`, xoá worktree, chạm production, in secret/file cấu hình.
- Không bắt bẻ style vô hại. Chỉ báo lỗi thật hoặc rủi ro thật.

## Ownership

Chỉ đọc. Report ghi tại `orchestration/report-23-review-standards.md`.

## Observable acceptance

Report có:
1. Verdict: `APPROVE` / `APPROVE WITH CHANGES` / `REQUEST CHANGES`.
2. Findings theo mức HIGH/MEDIUM/LOW, mỗi mục có `file:dòng`, lý do, cách sửa.
3. Bảng lệnh đã chạy + kết quả thật.
4. Những vùng đã kiểm nhưng không thấy lỗi.

Rồi gửi đúng **một** `worker_done` theo preamble của Orca: outcome `succeeded` (đã review xong,
kể cả khi verdict là request changes), kèm `--report-path` và `--dispatch-id`; không ghi
`--files-modified` (không sửa file).
