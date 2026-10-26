<!--
Retro của phiên Claude Code 17022606-1a61-4e46-aa2c-ea4cb6731700 (2026-10-24/25), làm theo skill
`retro` của https://github.com/mattpocock/skills.

Bản đầy đủ, đã lọc chi tiết nội bộ, nằm ở máy dev của chủ. Bản trong repo đã thay mọi tên
máy chủ, đường dẫn home, số điện thoại, chat id và tên nhà cung cấp bằng <placeholder>.
-->
# Retro: phiên Claude Code 17022606-1a61-4e46-aa2c-ea4cb6731700

## 1. Phiên đó làm gì (tóm tắt)

- ~24h (2026-10-24 08:22 → 2026-10-25 17:42Z), 2 lần reset do giới hạn session (429).
- Nâng `itsaplan` lên upstream `v1.8.0` (`6ab14d0f`): merge vào `upgrade/v1.8.0-20261024`, test trên dev với DB copy prod, deploy thật (11 migration, downtime 43s).
- Review độc lập tìm 3 lỗi thật, vá trước deploy: thiếu snapshot drizzle `0156_snapshot.json` (`771fb404`); rate-limit BetterAuth do IP edge-proxy (`bd5580b0`); key project trùng gây 409 (`5f587fb2`).
- Dựng repo công khai `<owner>/ticket` (Bun monorepo: `packages/core`, `apps/tieulinh-legacy`, `apps/tieulinh`, `tools/tl2-shadow`, `docs/`): 16 PR, CI 4 job, branch protection squash-only.
- Bộ `~/colab-tools` giảm 9,06s → 0,14s mỗi lệnh; tool move-project đã diễn tập, **chưa** áp prod.
- Sự cố prod: canary plugin shadow trên gateway OpenClaw live làm hỏng 3 lượt chat thật; nguyên nhân là model id fallback sai (`<model-id sai>`), rollback 20:03, sửa hôm sau.

## 2. Bản đồ thời gian

| Mốc | Việc | Kết quả |
|---|---|---|
| 08:22 | Khảo sát upstream (read-only) | v1.8.0; disk prod 99%; 5 conflict; trùng số migration |
| 08:22–08:38 | 2 worker `omp -p` headless | vô hình trên UI, bị kill; `worker-start` lỗi `consumer_fenced` |
| 08:38–09:35 | Chuỗi Orca đúng (`run-create` → `worker-start` → `check --wait` → `worker-release` → `check --ack` → `terminal close`) | merge + test v1.8.0 xong; im lặng ~50 phút |
| 09:59–10:32 | Review + deploy prod | 3 bug vá; downtime 43s; xoá project rỗng (204) |
| 09:44–17:16 | Repo công khai: 16 PR, CI, docs, shadow | PR #3–#15 merge; reviewer tìm HIGH ở #5, #9, #10 |
| 19:46–20:16 | Canary shadow trên gateway prod; hôm sau sửa model id fallback prod | 3 lượt chat thật fail; rollback 20:03; root cause xác nhận (<provider> 400) |

## 3. Điều phối với Orca: đúng chuẩn chưa, sai ở đâu

**Đúng chuẩn (sau khi người dùng phàn nàn):** `run-create` → (`task-create`: viết spec) → `worker-start --agent <id> --model <id> --worktree current` → `check --wait` → `worker-release` → `check --ack` → `terminal close`. 7 worker đầu đi đúng chuỗi, **hiện trên UI Orca**.

**Sai:**

1. `worker-start` trước `run-create` → `consumer_fenced`; `send --to dispatch:…` sau khi release → `dispatch_inactive`; prompt không tự submit → phải `orca terminal send --enter` mỗi lần.
2. `launch.sh` `cd` cứng vào thư mục đã xoá → `dispatch: null` cho cả 2 worker; `worker-release` trả `retained / external_terminal` → vẫn phải `terminal close`.
3. **Rời Orca từ chunk 03–09**: người dùng cấm omp, agent chuyển sang tool `Agent`/`SendMessage` native → **0 lệnh `orca` CLI** trong 5 chunk (05–09), chỉ còn hook boilerplate. Đây là nguyên nhân tiến trình không hiện trên UI, dù bộ nhớ `orca-dispatch-server-chat.md` bắt worker qua Orca.
4. Bằng chứng phải tự chạy: worker tự báo "done and rehearsed" nhưng reviewer tìm HIGH blocker (`move.ts:193-206`); worker còn đề xuất `docker image prune -a` trên prod → phải bác.
5. Không có bằng chứng chạy `terminal wait` để đóng băng coordinator (`terminal wait --for tui-idle` chỉ dùng cho TUI worker); `next.sh` poll tay chặn coordinator ~1h.
6. Sửa ngoài fast-track: PR #6 merge sau `gh pr checks 6 | awk …` — exit code của `awk` gate merge, không phải của `gh`.

## 4. Sai lầm và ma sát

| Mức độ | Vấn đề | Bằng chứng | Hạng mục |
|---|---|---|---|
| Cao | Worker `omp -p` headless, vô hình UI | chunk 00, kill 2 worker | điều hướng |
| Cao | Bỏ Orca chunk 03–09: không UI, không retry bền vững | chunk 08/09 | file điều hướng |
| Cao | Secret lọt transcript: `apiKey`, token Telegram/ITSAPLAN, số ĐT | chunk 01, 08, 09 | khác |
| Cao | Đĩa dev 0 MB → mọi Bash fail, 2 subagent chết | chunk 07 | khác |
| Cao | Thiếu snapshot drizzle → `drizzle-kit generate` sinh `ADD COLUMN` không `IF NOT EXISTS` | chunk 01 | kiểm tra tự động |
| TB | Tắt luật lint: `noExplicitAny` (709), `noNonNullAssertion` (212) | `biome.json` còn `off` | chuẩn hoá code |
| TB | `.scan-denylist` (git-ignored) bị ghi đè, mất 25 mục, 14 hit thật lọt lại | chunk 03/04/07 | chỗ thừa |
| TB | CI đỏ lần đầu (`gitleaks-action@v2`); PR #9 bị chặn vì fixture → rewrite history | chunk 04/07/08 | kiểm tra tự động |
| TB | Đổi hành runtime không hỏi (`agentInstruction`); hỏi lặp 2 lần; sai đường dẫn | chunk 01, 02, 04, 07, 09 | chuẩn hoá code, tiếp cận thông tin, điều hướng |

## 5. Ứng viên cải thiện (theo mức độ nghiêm trọng)

**C1 — Quy tắc "worker qua Orca" chỉ nằm trong bộ nhớ.** (a) 5 chunk không UI. (b) chunk 08/09. (c) `AGENTS.md` + `~/.claude/CLAUDE.md`. (d) mỗi dispatch phải có `orca orchestration run-create`. (e) Cao. *Phán đoán → rule file.*

**C2 — Merge không xác nhận check xanh.** (a) `gh pr checks | awk` sai exit code; PR #6 merge khi chưa chắc xanh. (b) chunk 06. (c) CI job `scripts/merge-pr.sh` dùng `gh pr checks --json statusCheckRollup` (không pipe), assert check bắt buộc xanh rồi squash-merge. (d) PR check đỏ → script fail. (e) Cao. *Máy kiểm được → 1 kiểm tự động.*

**C3 — Rò rỉ secret/PII vào transcript.** (a) `apiKey`, token, số ĐT in ra. (b) chunk 01, 08, 09. (c) PreToolUse hook chặn `cat|head|tail` trên `**/.env*`, `~/.openclaw/**`, `*.key` (repo chưa có hook). (d) `cat ~/.openclaw/openclaw.json` → bị chặn. (e) Cao. *Máy kiểm được → 1 hook.*

**C4 — Hạ chất lượng bằng cách tắt luật lint.** (a) `noExplicitAny`/`noNonNullAssertion` bị `off`. (b) chunk 04. (c) CI job đối chiếu `biome.lint-baseline.json`, fail khi số cảnh báo rule tăng hoặc rule bị `off`. (d) thêm 1 `any` → CI đỏ. (e) TB. *Máy kiểm được → 1 job.*

**C5 — Denylist vệ sinh repo bị ghi đè khi chạy song song.** (a) mất 25 mục, 14 hit thật lọt lại. (b) chunk 03/04/07. (c) `scripts/scan-public.ts`: fragment `.scan-denylist.<agent>` append-only + script merge tất định + pre-commit hook gọi `bun run scan`. (d) hai fragment song song → merge ổn định. (e) TB. *Máy kiểm được → 1 script + hook.*

**C6 — Prod-impact change thiếu cổng review.** (a) implementer báo "done", reviewer tìm HIGH; canary không kế hoạch nhân quả. (b) chunk 05, 08. (c) `docs/runbooks/move-project-to-team.md` + `docs/how-to/shadow-tl2.md` (rollback timer, baseline lỗi trước canary), PR template bắt buộc trường "verdict của reviewer". (d) mỗi PR chạm prod phải kèm verdict + bằng chứng rehearsal. (e) Cao. *Phán đoán → tài liệu.*

**C7 — Không có pre-flight cho dispatch.** (a) đĩa 0 MB giết 2 subagent; RAM dev 15GB/0 free giết watcher 12h. (b) chunk 07, 09. (c) `tools/orca_launch.sh` trong repo (thay `~/.cache/server-chat-orca/launch.sh`): check `df -h`/`free -m` trước; watcher dài đặt trên prod bằng systemd timer; artifact để trong repo, không ở `~/.cache/`. (d) mô phỏng hết đĩa → từ chối dispatch. (e) TB. *Máy kiểm được → 1 script.*

**C8 — Điều hướng repo + cách hỏi.** (a) `AGENTS.md` thiếu quy tắc chạy test chỉ trên Colab, không commit lên `main`, rebase trước PR; bài học "bot = bộ MCP + tools + skills + harness cắm vào agent sẵn có" chỉ ghi sau khi người dùng nói. (b) chunk 01, 02, 04, 08, 09. (c) `AGENTS.md` (navigation) + `docs/explanation/` (bài học); phần phán đoán để `CODING_STANDARDS.md`. (d) agent không còn dò đường dẫn, hỏi lặp. (e) TB. *Phán đoán → rule file + tài liệu.*

## 6. Đề xuất riêng cho cách làm việc với Orca

Mục tiêu: worker chạy trong terminal do Orca quản lý để hiện trên UI; coordinator không bị chặn; bằng chứng do coordinator tự kiểm.

1. **Đúng thứ tự, mỗi lần dispatch** (worker = omp, model `google-antigravity/gemini-3.8-flash` + `high`): `orca orchestration run-create` → viết spec (Target/Change/Constraints/Ownership/Acceptance + **Forbidden**) → `orca orchestration worker-start --run <runId> --agent <agentId> --model <modelId> --worktree current --spec <file>` → xác nhận prompt đã submit (TUI kẹt thì `orca terminal send --enter` rồi `orca terminal read --screen`) → `orca orchestration check --run <runId> --wait --types "worker_done,escalation,question" --timeout-ms 1800000` → `orca orchestration worker-release --dispatch <ctxId>` → `orca orchestration check --run <runId> --ack <deliveryId>` → `orca terminal close`.
2. **Không `terminal wait` trên coordinator**; chỉ `terminal wait --for tui-idle` cho TUI worker, và dùng `check --wait` thay vòng poll tay như `next.sh`.
3. **Không `omp -p` headless** (chunk 00: vô hình).
4. **Không tin lời tự báo của worker:** worker tự chạy test và đính kèm log; coordinator chạy lại verify trước khi merge, merge bằng script (C2); thay đổi chạm prod cần review độc lập + diễn tập trên bản copy DB.
5. **Spec phải có danh sách cấm**: `docker image prune -a`, `system/volume prune`, `pkill -f`, restart prod, ghi ngoài Ownership, in secret. Số liệu (cost/latency) phải nêu model id + nguồn đo.
6. **Heartbeat chỉ ack**; báo người dùng một dòng mỗi ~10 phút (chunk 00 im lặng 50 phút).

## 7. Việc nên làm tiếp

1. Thêm rule Orca + "chỉ test trên Colab, PR-only, squash" vào `AGENTS.md` — xong khi agent không còn dispatch bằng `Agent` tool.
2. Tạo `scripts/merge-pr.sh` + CI job assert check bắt buộc — xong khi PR check đỏ bị chặn.
3. Tạo PreToolUse hook chặn đọc file secret — xong khi `cat ~/.openclaw/openclaw.json` bị chặn.
4. Tạo `biome.lint-baseline.json` + CI job chặn tăng cảnh báo/tắt rule — xong khi thêm `any` làm CI đỏ.
5. `scripts/scan-public.ts`: fragment denylist theo agent + merge script + pre-commit hook — xong khi merge fragment ổn định.
6. Viết `docs/runbooks/move-project-to-team.md` + `docs/how-to/shadow-tl2.md` — xong khi có link từ ADR.
7. Đưa `~/colab-tools` vào git + test exclude — xong khi lỡ include `.env` thì test đỏ.
8. Dọn prod: xoá model id cũ, sinh lại `agents/*/agent/models.json` — xong khi journal hết `status=400`.
9. Diễn tập move-project + xin khung giờ prod — xong khi có review xanh và rollback ghi ra giấy.
10. Tạo `CODING_STANDARDS.md` chỉ với rule cần phán đoán — xong khi ≤ 100 dòng.
