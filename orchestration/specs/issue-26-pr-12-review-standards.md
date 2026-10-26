# Đặc tả: review trục chuẩn hoá code — PR 12 (issue #26)

## Vai

Reviewer độc lập, **chỉ đọc**. Không sửa file, không commit/push, không chạy lệnh git làm đổi
trạng thái.

## Bối cảnh

- Repo `minhdevtry/ticket`, worktree hiện tại, nhánh `feat/pr-12-cancel-close`,
  PR https://github.com/minhdevtry/ticket/pull/60, issue #26.
- PR 12 của RFC 0002: huỷ/đóng ticket theo yêu cầu người báo (D8). Base: `origin/main` có PR 11.
- Diff: `git diff origin/main...HEAD` (13 file, +1702/-82). Đọc trước
  `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`,
  `packages/core/GLOSSARY.md`, `orchestration/specs/issue-26-pr-12-cancel-close.md`.

## Target

Chất lượng code, test, tài liệu của PR 12. Không đánh giá lại thiết kế RFC.

## Việc phải làm

1. **Chuẩn hoá code**
   - Không `any`, không non-null `!` trong code mới; `bun run lint:baseline` không tăng.
   - Một hằng/hàm/kiểu một chủ: `classifyCancelOrCloseIntent`/`isCancelOrCloseTicketRequest` phải
     tái dùng từ `text.ts` của PR 11, không chép bản thứ hai. Kiểm tra `countSpecialistTimelineComments`
     có trùng helper nào đã có không.
   - **Không hardcode câu chữ gửi người dùng** trong `packages/core`: mọi chữ/nhãn nút qua
     `CopyCatalog`. Soi kỹ `engine.ts` (kể cả ghi chú tệp, nhãn "đóng"/"hủy", thông báo lỗi cột).
   - Core không hardcode tên bot/sản phẩm. Ngưỡng 3 phải cấu hình được.
   - Không sửa `apps/tieulinh-legacy/**`, `.github/**`, `scripts/**`,
     `biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.
2. **Test**
   - Test đặt cạnh nguồn; khẳng định đầu ra hệ thống; không phụ thuộc thời gian thật.
   - 12 ca port giữ nguyên tên/ý: 7 flow + 5 router; đối chiếu legacy.
   - Bảng quyết định: mỗi ô một ca; có ca chốt chặn lúc thực thi (ticket đổi trạng thái giữa
     preview và confirm), "Giữ lại" không đổi gì, chat khác không bấm hộ.
3. **Docs / CHANGELOG / sổ đối chiếu**
   - `packages/core/CHANGELOG.md` có mục PR 12.
   - `ENGINE.md` marker/bảng khớp sổ (ported +12).
   - `apps/tieulinh/receptionist-gap-register.test.ts`: đúng 12 dòng PR 12 sang `ported`.
   - `docs/rfc/0002-receptionist.md` chỉ sửa dòng D8.
4. **Chạy (chỉ mục tiêu)**
   - `bun run lint`
   - `bun run lint:baseline`
   - `bun test packages/core/src/intake/engine/pr12-cancel-close.test.ts`
   - `bun test packages/core/src/intake/engine/pr11-ticket-commands.test.ts`
   - `bun test apps/tieulinh/receptionist-gap-register.test.ts`

## Constraints

- Không chạy `bun run verify`/full suite: coordinator đã chạy full.
- Không chạm production, không in secret, không `pkill -f`, không prune docker.
- Không bắt bẻ style vô hại. Chỉ báo lỗi/rủi ro thật.

## Ownership

Chỉ đọc. Report: `orchestration/report-26-review-standards.md`.

## Observable acceptance

Report có: (1) verdict; (2) findings HIGH/MEDIUM/LOW kèm `file:dòng`, lý do, cách sửa;
(3) bảng lệnh + kết quả; (4) vùng đã kiểm nhưng không thấy lỗi. Rồi gửi đúng **một**
`worker_done` theo preamble, outcome `succeeded`, kèm `--report-path`; không ghi
`--files-modified`.
