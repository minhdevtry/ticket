# Đặc tả: review trục đặc tả và hành vi — PR 12 (issue #26)

## Vai

Reviewer độc lập, **chỉ đọc**. Không sửa file, không commit/push, không chạy lệnh git làm đổi
trạng thái.

## Bối cảnh

- Repo `minhdevtry/ticket`, worktree hiện tại, nhánh `feat/pr-12-cancel-close`,
  PR https://github.com/minhdevtry/ticket/pull/60, issue #26.
- PR 12 port **D8** theo ADR-0006 bản 10/10. Nguồn sự thật:
  `docs/rfc/0002-receptionist.md` mục 1.3 (D8), 2.1-2.4, 5 hàng PR 12;
  `orchestration/specs/issue-26-pr-12-cancel-close.md`; ADR-0006, ADR-0008.
- Legacy tham chiếu (chỉ đọc): `apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.ts`
  (`classifyCancelOrCloseIntent`, `countSpecialistTimelineComments`,
  `MIN_SPECIALIST_COMMENTS_FOR_DONE`), `pipeline.ts` (`proposeCancelOrClose`,
  `countSpecialistComments`, `executeTicketAction` nhánh cancel/close), test flow nhóm huỷ/đóng
  và router.

## Target

Hành vi quan sát được so với đặc tả/ADR. Không đánh giá lại chuẩn code.

## Việc phải làm

Đối chiếu **bảng quyết định từng ô**:

| # | Trạng thái | Ý định | Kỳ vọng |
|---|---|---|---|
| 1 | done/canceled | bất kỳ | từ chối, không chuyển, không comment |
| 2 | khác | hủy rõ | Canceled |
| 3 | resolved | đóng | Done |
| 4 | khác, ≥3 comment chuyên viên | đóng | Done |
| 5 | khác, <3 | đóng | Canceled |
| 6 | bất kỳ, không phải chủ | bất kỳ | từ chối, không đổi |
| 7 | done/canceled | bấm nút cũ | từ chối khi thực thi |
| 8 | bất kỳ | "Giữ lại" | không đổi gì |
| 9 | bất kỳ | xác nhận | chuyển đúng cột + comment lý do đã escape + ảnh |

Kiểm thêm:
- **ADR-0008**: chỉ ghi sau cú bấm khớp nhãn; chat khác không bấm hộ; nhãn từ chối là "Giữ lại",
  không phải "Huỷ".
- **Chốt chặn lúc thực thi**: preview lúc Resolved → trước khi bấm bị kéo về In Progress với 1
  comment chuyên viên → phải Canceled, không Done.
- **Cột**: tìm Done/Canceled qua `listProjectColumns` + `classifyColumn`, không hardcode 4/5;
  thiếu cột thì từ chối an toàn.
- **Ngưỡng**: `minSpecialistCommentsForDone` cấu hình được; đếm đúng chuyên viên thật, bỏ bot/
  người báo/admin.
- **Không hồi quy**: PR 1-11 xanh (nhất là PR 11 command router, PR 10 post-create).

Cách làm khuyến khích: tự viết script `/tmp` chạy qua `IntakeEngine`/fakes cho từng ô; **không
tin report của worker implement**.

## Constraints

- Không sửa repo, kể cả test. Script tạm ở `/tmp`.
- Chỉ chạy test mục tiêu, không full suite:
  - `bun test packages/core/src/intake/engine/pr12-cancel-close.test.ts`
  - `bun test packages/core/src/intake/engine/pr11-ticket-commands.test.ts`
  - `bun test packages/core/src/intake/engine/pr10-post-create.test.ts`
  - `bun test apps/tieulinh/receptionist-gap-register.test.ts`
- Không chạm production, không in secret, không `pkill -f`, không prune docker.

## Ownership

Chỉ đọc. Report: `orchestration/report-26-review-spec.md`.

## Observable acceptance

Report có: (1) verdict; (2) bảng 9 ô → code/test chứng minh → đạt/không; (3) findings theo mức
kèm kịch bản tái hiện; (4) bảng lệnh + kết quả; (5) lệch legacy có chủ ý. Rồi gửi đúng **một**
`worker_done` theo preamble, outcome `succeeded`, kèm `--report-path`; không ghi
`--files-modified`.
