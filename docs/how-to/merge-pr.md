# Cách merge PR

Quy trình này ghi lại cách merge PR đã dùng và đã đau. Làm theo đúng thứ tự: chờ CI
xanh, kiểm tra trạng thái merge, rồi mới merge.

## 1. Chờ CI

Dùng một lệnh chặn, tự dừng khi xong, trả về mã khác 0 khi có job đỏ:

```bash
gh pr checks <số> --watch --interval 30
```

Không tự viết vòng lặp `sleep` rồi poll: vừa chậm vừa dễ bỏ sót. `gh pr checks` đã lo
phần chờ, và mã thoát của nó đã nói lên tình trạng.

## 2. Kiểm tra trạng thái trước khi merge

```bash
gh pr view <số> --json mergeable,mergeStateStatus,statusCheckRollup
```

- `mergeable`: `MERGEABLE` thì không xung đột.
- `mergeStateStatus`: `CLEAN` thì đủ điều kiện merge; `BLOCKED` là đang chờ review hoặc
  check; `BEHIND` là nhánh đã cũ hơn base.
- `statusCheckRollup`: từng job kèm trạng thái. Job đỏ thì chưa merge được.

## 3. Merge

```bash
gh pr merge <số> --squash --subject "..." --body "..."
```

Repo bật required status checks ở chế độ strict, nên lệnh merge có thể bị từ chối dù PR
đã `CLEAN` và 4/4 job xanh. Khi đó chạy lại với `--auto`:

```bash
gh pr merge <số> --squash --auto --subject "..." --body "..."
```

**Nhưng repo này đang TẮT auto-merge** (`enablePullRequestAutoMerge` false), nên `--auto`
trả lỗi `Auto merge is not allowed for this repository`. Khi gặp lỗi đó:

1. Kiểm tra PR đã đủ điều kiện chưa: `gh pr view <số> --json mergeable,mergeStateStatus,statusCheckRollup`.
2. Nếu `mergeable=MERGEABLE` và `mergeStateStatus=CLEAN` và mọi job xanh: merge bằng
   lệnh KHÔNG kèm `--auto` (như lệnh ở trên) là được.
3. Nếu chưa đủ: thường là nhánh chưa có `main` mới nhất. Làm một lệnh:

   ```bash
   gh pr update-branch <số>     # GitHub merge main vào nhánh PR
   gh pr checks <số> --watch --interval 30
   ```

   Rồi merge lại. Vì required status checks ở chế độ strict, một PR phải có `main` mới nhất
   mới merge được, nên **gần như mọi PR đều cần một vòng refresh này** — làm ngay sau khi
   mở PR, đừng đợi tới lúc merge mới thấy.

- `--squash`: repo chỉ nhận squash merge, nên đây là cách duy nhất.
- `--subject` / `--body`: nội dung commit merge. Ghi lý do thay đổi, không ghi "wip".

## 4. PR xếp chồng

PR mà base không phải `main` (nằm trên nhánh của PR trước) thì base phải trỏ đúng:

```bash
gh pr edit <số> --base <nhánh>
```

Sai base là nguyên nhân thường gặp khi PR "bị kẹt": PR nhìn thấy diff sai, hoặc đổi
chồng lên nhánh đã bị xoá.

## 5. Cập nhật issue

Nhãn issue theo [Triage Labels](/agents/triage-labels):

- Agent làm xong: gắn `ready-for-human`.
- PR đã merge: đóng issue và trỏ link PR.

## Trường JSON hợp lệ của `gh pr view`

`gh pr view --json <field>` in ra danh sách field hợp lệ khi sai tên field:

```bash
gh pr view --json bogus
```

Các field hay dùng: `number`, `title`, `body`, `state`, `labels`, `baseRefName`,
`headRefName`, `mergeable`, `mergeStateStatus`, `statusCheckRollup`, `url`, `files`,
`additions`, `deletions`, `commits`, `reviewDecision`.
