# Đặc tả: review trục đặc tả và hành vi — PR 9 (issue #23)

## Vai

Reviewer độc lập, **chỉ đọc**. Không sửa file, không commit, không push, không mở/merge PR,
không chạy lệnh git làm đổi trạng thái (checkout/reset/clean/stash/merge/rebase).

## Bối cảnh

- Repo: `minhdevtry/ticket`. Worktree hiện tại ở nhánh `minhdevtry/feat-pr-9-split`,
  PR https://github.com/minhdevtry/ticket/pull/55, issue #23.
- PR 9 port **B7** của RFC 0002: tách báo cáo nhiều học sinh/sự cố.
- Nguồn sự thật: `docs/rfc/0002-receptionist.md` mục 1.5 (B7), 2.1, 5;
  `orchestration/specs/issue-23-pr-9-split.md`.
- Legacy tham chiếu (chỉ đọc): `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts`,
  `multi-incident.test.ts`, `split-adversarial.test.ts`, các nhánh liên quan trong
  `apps/tieulinh-legacy/lib/intake-step/pipeline.ts`.
- Đọc trước: `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.

## Target

Hành vi quan sát được của engine mới so với đặc tả B7 và legacy. Không đánh giá lại chuẩn code
(reviewer trục chuẩn hoá lo phần đó).

## Việc phải làm

Đối chiếu **từng** yêu cầu của B7 với code + test mới:

1. **Bộ tách**: tin < 30 ký tự không tách; dấu hiệu "ví dụ/dưới đây/các HS" là một sự cố kèm
   ví dụ; phải có từ chỉ lỗi; tách theo ≥ 2 dòng trống, nếu không thì theo mẫu mở đầu khối
   (số thứ tự `1.`/`2.`, `**Tên**`, `Code:`, mã CRM 7-10 số trần); chỉ định danh **có nhãn**
   (khách hàng/học sinh); SĐT không tạo việc tách; khối phải có câu chữ riêng; cùng một học
   sinh nhắc lại không tách.
2. **Câu hỏi tách/gộp**: đúng câu chữ + 2 nút `Tách N ticket` / `Gộp 1 ticket`; hành động
   tương ứng legacy.
3. **Phủ định và "thôi/khỏi" trần**: luôn gộp, tuyệt đối không tách; "không tách" không rơi
   vào nhánh tách.
4. **Trả lời không rõ**: hỏi lại **đúng một lần**; lần hai vẫn không rõ thì gộp. Mọi nhánh
   (tách/gộp/không rõ/huỷ) **không được rơi chữ hay ảnh**.
5. **Hàng đợi tạo lần lượt**: chọn tách thì tạo từng ticket, kế thừa bộ phận người báo; gói tin
   hỗn hợp `createdIssue` + `nextDraft` đúng contract; ticket sau chỉ cần xác nhận.
6. **`mediaAmbiguous`**: ảnh gắn cho mọi ticket khi không chia được, kèm ghi chú trong mô tả.
7. **Huỷ giữa câu hỏi tách**: thoát câu hỏi, xoá `pendingSplit` + hàng đợi, không tạo ticket.
8. **TTL 24h**: hết hạn thì tin mới mở sự cố mới, không hồi sinh tờ khai cũ.
9. **Không hồi quy**: PR 1-8 vẫn xanh, đặc biệt các nhánh `detectPark`/`resolvePark`,
   hỏi bổ sung, chuẩn hoá đầu vào; PR 9 không được làm đổi hành vi ngoài B7.

Cách làm khuyến khích: tự viết script so sánh ngoài repo (`/tmp/...`) chạy cùng một bộ input
qua legacy và core mới, rồi tự kết luận — **không tin report của worker implement**.

## Constraints

- Không sửa repo, kể cả file test. Script tạm đặt ở `/tmp`.
- Chỉ chạy test mục tiêu, không `bun run verify`/full suite (máy dev thiếu RAM):
  - `bun test packages/core/src/intake/split/split.test.ts`
  - `bun test packages/core/src/intake/engine/pr9-split.test.ts`
  - `bun test packages/core/src/intake/engine/split-adversarial.test.ts`
  - `bun test packages/core/src/intake/engine/engine.test.ts`
- Không chạm production, không in secret, không `pkill -f`, không prune docker.

## Ownership

Chỉ đọc. Report ghi tại `orchestration/report-23-review-spec.md`.

## Observable acceptance

Report có:
1. Verdict: `APPROVE` / `APPROVE WITH CHANGES` / `REQUEST CHANGES`.
2. Bảng đối chiếu B7: yêu cầu → code/test chứng minh → đạt/không đạt.
3. Findings theo mức, mỗi mục `file:dòng`, kịch bản tái hiện, hậu quả, cách sửa.
4. Bảng lệnh đã chạy + kết quả thật.
5. Chỗ lệch legacy có chủ ý (nếu có) và lý do.

Rồi gửi đúng **một** `worker_done` theo preamble: outcome `succeeded`, kèm `--report-path`,
`--dispatch-id`; không ghi `--files-modified`.
