# Hướng dẫn cho agent

Repo **công khai**. Trước mọi commit: không secret, không IP/host nội bộ, không số điện thoại, chat ID, tên người thật. `bun run scan` phải sạch. Chi tiết: [SECURITY.md](SECURITY.md).

## Bản đồ

- `packages/core`: `@vuihoc/bot-core`, import qua subpath (`@vuihoc/bot-core/core`, `/itsaplan`, `/intake`, `/identity`, `/openclaw`, `/telegram`, `/worker`, `/eval`, và bot kit: `/bot`, `/backoffice`, `/llm`, `/testing`). Logic dùng chung cho mọi bot đặt ở đây, không chép sang app.
- `apps/tieulinh-legacy` (`@vuihoc/tieulinh-legacy`): Tiểu Linh hiện tại, **bản tham chiếu đóng băng** (hành vi = production, dùng làm mốc so sánh shadow). Chỉ sửa lỗi nghiêm trọng; tính năng mới làm ở `apps/tieulinh`. Bot tiếp nhận sự cố kỹ thuật.
  - `mcp/tieulinh`: MCP server và domain (catalog, rules JSON, formatter).
  - `lib/intake-step`: engine hội thoại (`pipeline.ts`).
  - `worker`: webhook itsaplan → Telegram, vòng đời ticket.
  - `skills/tieulinh`: persona và workspace OpenClaw (đồng bộ bằng `openclaw/sync-workspace.ts`).
  - `openclaw-plugin`: plugin nút bấm, xác nhận xong.
- `apps/tieulinh` (`@vuihoc/tieulinh`): Tiểu Linh mới, nửa **hậu cần** dựng bằng `defineBot` (agent `tieulinh2`, dự án `TECH2` đổi được bằng env). Mention bằng LLM, báo người báo khi Resolved/Done và chuyển comment, nhắc SLA, gợi ý ticket trùng. Lễ tân chưa có (thiết kế ở `docs/rfc/0002-receptionist.md`). Xem `apps/tieulinh/README.md`. Test: `bun run --cwd apps/tieulinh test`.
- `tools/tl2-shadow`: bộ chạy bóng Tiểu Linh 2 (relay, proxy giữ secret, tunnel, so sánh) và chạy `apps/tieulinh` trên Colab không secret (`deploy/colab/cup-tieulinh.sh`). Chỉ chạy trên máy dev; xem `docs/how-to/shadow-tl2.md`, ADR-0005.
- `deploy/`: script đẩy secret qua SSH, README deploy, launcher dev (`deploy/dev/tl2-shadow.sh`) và Colab (`deploy/colab/cup-*.sh`).
- `docs/`: site VitePress (tiếng Việt), published lên GitHub Pages. Gồm `guide/`, `how-to/`, `reference/`, `explanation/` và `adr/` (quyết định cấp repo). Mỗi package/app có `docs/adr` riêng cạnh code.
- `scripts/`: `scan-public.ts` (vệ sinh repo công khai), `gen-docs.ts`, `check-doc-snippets.ts`, `check-docs-refs.ts`, `check-docs-touched.ts` (kiểm docs), `new-worktree.sh` (tạo worktree riêng cho nhánh mới).
- `packages/core/docs/parity/ENGINE.md`: bản đồ hành vi legacy -> core của engine tiếp nhận (số test theo trạng thái, PR nào sẽ port). Đọc trước khi sửa engine tiếp nhận.
- `orchestration/`: `WORKER-CONTRACT.md` (hợp đồng chung cho mọi worker Orca: kiểm base, ranh giới sửa, bằng chứng, cách báo xong), `specs/` (đặc tả từng việc), `report-*.md` (báo cáo của worker).

## Lệnh

```bash
bun install
bun run verify                      # lint + check + test + scan + kiểm docs nhanh
bun run docs:dev                    # xem trước site docs
bun run docs:check                  # build site + TypeDoc + mẫu code + đối chiếu (như CI)
bun run --cwd packages/core test
bun run --cwd apps/tieulinh-legacy test
bun run --cwd apps/tieulinh test
bun run --cwd apps/tieulinh-legacy golden:record   # ghi lại bản ghi vàng của lễ tân legacy (thêm --check để chỉ kiểm)
bun run setup:hooks                                # cài hook chặn trước commit (lint + scan) và trước push (typecheck + sổ đối chiểu)
```

## Nguyên tắc

- Logic tất định ở tool và engine; prompt chỉ lo diễn đạt. Đừng chuyển quyết định nghiệp vụ vào prompt.
- itsaplan là nguồn sự thật; SQLite cục bộ là cache.
- Test không gọi dịch vụ thật. Script `live:*` phải bật tay.
- Sửa core → thêm test trong core và ghi `packages/core/CHANGELOG.md`.
- Đổi hành vi hoặc API công khai → cập nhật `docs/` trong cùng PR (CI chặn nếu thiếu; nhãn `no-docs` chỉ cho refactor thuần và test). Mẫu `ts` trong docs phải có cờ `check`, `run` hoặc `no-check`. Không bao giờ chép chữ ký hàm vào docs bằng tay khi TypeDoc đã sinh.
- Commit theo Conventional Commits, scope là tên package.

## Quy trình PR và commit

- Trước khi mở PR: đã merge nhánh nền vào nhánh mình VÀ chạy `bun run verify` trên trạng thái đã merge đó rồi. Bằng chứng trong body PR phải khớp với HEAD lúc reviewer đọc.
- `git commit ... && git push` nối chuỗi trong một lệnh; chỉ push sau khi `git log --oneline -1` xác nhận HEAD đúng. Khi hook chặn commit mà `git push` vẫn chạy thì tạo nhánh remote rỗng.
- Ghi file mới: tạo thư mục trước (`mkdir -p`), dùng công cụ sửa file thay vì ghi đè bằng heredoc trong Bash, và kiểm tra lại file tồn tại sau khi ghi.

## Điều phối Orca

Agent điều phối việc khác trong repo này thì đi qua Orca, để tiến trình hiện trên UI và để có vòng đời, bằng chứng, và người nhận rõ ràng. Không chạy worker nền vô hình.

1. Tạo Run: `orca orchestration run-create --objective "<mục tiêu>" --json`.
2. Tạo worktree riêng cho từng việc: `orca worktree create --repo path:<đường dẫn repo> --name "<tên>" --base-branch main --issue <số> --json`. Không sửa trong checkout chính, trừ fast-track (typo, docs, ≤ 5 dòng). **Sau khi tạo, kiểm base**: `git -C <worktree> log -1 origin/main` so với `git -C <worktree> log -1 HEAD`; Orca hay dùng ref đã cache nên base có khi cũ — lệch thì `git -C <worktree> checkout -B <nhánh> origin/main` rồi mới giao việc. Nhánh mới luôn làm trong worktree riêng, tạo bằng `scripts/new-worktree.sh <nhánh>`.
3. Log phiên (transcript) hay chứa khoá API và token bot. Trước khi đưa log cho worker hoặc lưu vào repo, lọc: `bun run scan:transcript <file-or-dir> --redact` (xem `scripts/scan-transcript.ts`).
4. Trước khi giao việc, kiểm tra máy còn đủ chỗ và RAM (`df -h /`, `free -m`); máy hết đĩa làm worker chết giữa chừng.
5. Giao việc: `orca orchestration worker-start --run <runId> --spec "<spec>" --worktree "name:<tên worktree>" --agent omp --model google-antigravity/gemini-3.8-flash:high --json`. Model mặc định của worker là `google-antigravity/gemini-3.8-flash:high`; `minimax/MiniMax-M3.1-Flash:high` là lựa chọn thay thế; phải giữ `:high` (tắt suy luận thì worker làm hỏng việc). OMP không nhận cờ `--effort`, nên đừng truyền nó. Worker chạy trong terminal do Orca quản lý nên hiện trên UI. Spec phải tự chứa: mục tiêu, phần sửa, ràng buộc, phần được phép sửa, tiêu chí chấp nhận, danh sách cấm. Không dùng `omp -p` headless: không ai thấy và dễ bị kill.
6. Chờ bằng sự kiện, không quét vòng: `orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 1800000 --json`. Không `orca terminal wait` để đóng băng coordinator, không tự viết vòng poll, không ngồi đọc màn hình terminal của worker (dùng `orca-settle --run <runId>` để xem worker nào chưa xong).
7. Bằng chứng phải tự kiểm: coordinator chạy `bun run verify` và `bun run docs:check` trước khi tin lời tự báo của worker. Worker nói "xong" không phải bằng chứng.
8. Dọn sau khi nhận `worker_done`: `orca orchestration worker-release --dispatch <dispatchId> --json`, `orca orchestration check --ack <deliveryId> --json`, `orca terminal close --terminal <terminalId> --json`.
9. Nếu `worker-start` trả lỗi (dispatch hỏng): đọc `failedStage` trong receipt. Nếu terminal của lượt trước đã `exited` thì không tái dùng được — `worker-release` nó, `orca terminal close` nó, rồi giao worker MỚI. Nếu chỉ là thiếu deps trong worktree thì `bun install` trong worktree rồi giao lại.

Cạnh chặn giữa các việc nằm ở issue dependency của GitHub (xem `docs/agents/issue-tracker.md`). PR 7 đến 13 của `docs/rfc/0002-receptionist.md` cùng chạm `engine.ts` nên merge tuần tự, không song song.

Quy tắc cần phán đoán khi review nằm ở `CODING_STANDARDS.md`; quy tắc máy kiểm được nằm ở `bun run verify` và CI.

## Agent skills

Repo này dùng bộ skill của [mattpocock/skills](https://github.com/mattpocock/skills) để việc agent có một ngôn ngữ chung. Cấu hình cho repo:

### Issue tracker

Issue và spec nằm ở GitHub Issues của `minhdevtry/ticket` (dùng `gh` CLI). Xem `docs/agents/issue-tracker.md`.

### Triage labels

Năm nhãn trạng thái chuẩn (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) cùng hai nhãn loại (`bug`, `enhancement`). Mỗi issue mang đúng một nhãn trạng thái và một nhãn loại. Xem `docs/agents/triage-labels.md`.

### Domain docs

Repo đa ngữ cảnh: `GLOSSARY-MAP.md` ở gốc trỏ tới `GLOSSARY.md` của từng ngữ cảnh, ADR hệ thống ở `docs/adr/`, ADR theo ngữ cảnh ở `packages/core/docs/adr/` và `apps/tieulinh-legacy/docs/adr/`. Xem `docs/agents/domain.md`.
