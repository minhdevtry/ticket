# Hợp đồng worker (Orca)

Mọi worker được giao việc trong repo này đều tuân theo hợp đồng này. Đặc tả riêng của
từng việc (`orchestration/specs/*.md`) chỉ nói **việc cần làm**; phần **cách làm** nằm ở đây,
một nơi duy nhất, để không phải lặp lại trong từng đặc tả.

## 0. Trước khi sửa một dòng nào

```bash
git fetch origin
git log --oneline -1 origin/main        # base của bạn
git log --oneline -1 HEAD                # của bạn
```

Base phải là `main` (hoặc nhánh nền ghi trong đặc tả) **ở bản mới nhất**. Nếu lệch, merge
nền vào trước rồi mới làm:

```bash
git merge origin/main --no-edit
```

Lý do: làm trên base cũ là nguồn của hầu hết lỗi phát hiện muộn trong repo này — xung đột
khi merge lại, trùng tên hằng với code đã có, và dòng trùng trong sổ đối chiểu.

## 1. Ranh giới sửa

- Chỉ sửa trong phần **Ownership** của đặc tả. Không sửa file ngoài phần đó.
- `apps/tieulinh-legacy/**` là bản tham chiếu **đóng băng**: chỉ đọc, không sửa, không import
  code legacy vào app mới.
- Không đụng `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json`
  gốc, `bun.lock` trừ khi đặc tả nói rõ.

## 2. Cấm

- `git commit`, `git push`, mở PR, merge. Coordinator sẽ commit và push.
- Lệnh git có `-f` (`reset --hard`, `clean -fd`, `push --force`).
- Chạm production, in secret, in file cấu hình và khoá (tên biến môi trường, khoá, thư mục
  secret, cấu hình OpenClaw).
- `docker image prune -a`, `docker system prune`, `docker volume prune`, `pkill -f`.
- Tự tạo issue, tự sửa issue, tự đóng issue.

## 3. Chất lượng code

- Không dùng `any`, không dùng khoá non-null (`!`) trong code mới. Hai rule đó đang tắt trong
  `biome.json` nhưng `bun run lint:baseline` canh số lỗi không được tăng.
- Một hằng, một hàm, một kiểu: **một chủ duy nhất**. Trước khi thêm, grep xem đã có chưa.
- Tên theo `packages/core/GLOSSARY.md`. Không tự đặt tên mới cho khái niệm đã có tên.
- Core không hardcode tên sản phẩm, tên công ty hay tên hệ thống của một app. Dữ liệu miền đi
  qua tham số.
- Logic tất định ở tool và engine; prompt chỉ lo diễn đạt.

## 4. Test

- Test đặt cạnh file nguồn (`foo.ts` -> `foo.test.ts`).
- Test khẳng định trên **đầu ra của hệ thống**, không trên chuỗi mà chính test tự dựng ra.
- Test không gọi dịch vụ thật.
- Port test legacy thì **giữ nguyên tên ca test** và **giữ nguyên ý**; nếu buộc phải đổi dữ
  liệu đầu vào thì nói rõ trong CHANGELOG và trong báo cáo.
- Sổ đối chiểu (`apps/tieulinh/receptionist-gap-register.test.ts`): chỉ ghi `ported` cho hành
  vi **đã port thật**. Chưa port thì để `deferred` và ghi lý do.
- Đổi `packages/core` thì thêm test trong core và ghi `packages/core/CHANGELOG.md`.
- Đổi hành vi hoặc API công khai thì cập nhật `docs/` trong cùng PR (CI chặn nếu thiếu).
  Mẫu `ts` trong docs phải có cờ `check`, `run` hoặc `no-check`.

## 5. Bằng chứng

Mỗi lần báo xong phải kèm **lệnh đã chạy và kết quả thật**:

```bash
bun run --cwd packages/core test      # hoặc test của package đang sửa
bun run verify                        # lint + lint:baseline + typecheck + test + scan + docs
bun run docs:check                    # nếu có đụng docs
```

Lời tự báo không phải bằng chứng. Coordinator sẽ chạy lại.

## 6. Báo cáo

Ghi `<worktree>/orchestration/report-<số issue>.md`:

1. Đã làm gì (theo từng mục của đặc tả).
2. File nào đổi.
3. Lệnh đã chạy và kết quả thật.
4. Test nào thêm, test nào port.
5. Còn dở gì, và phần đó thuộc PR nào.

## 7. Báo xong

Đọc follow-up của coordinator trước khi báo:

```bash
orca orchestration check --terminal <handle> --json
```

Rồi gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "<việc> xong" \
  --body "<tóm tắt ba câu: đã làm gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-<số issue>.md --json
```

Thất bại thì `--outcome failed` và nêu rõ chỗ vướng. Sau `worker_done` thì dừng và nghỉ, đừng
tự bắt tay làm tiếp.
