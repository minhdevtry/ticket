<!--
Retro của phiên OMP 01a17b07-b68a-72e4-86d8-265104632cc8 (2026-10-27 01:45 → 02:54Z),
soạn theo skill `retro` của https://github.com/mattpocock/skills và kết hợp với hợp đồng điều phối Orca.
Repo công khai: Không chứa secret, IP nội bộ, token hay tên người thật.
-->
# Retro: phiên OMP 01a17b07-b68a-72e4-86d8-265104632cc8

## 1. Tóm tắt phiên & Số liệu cốt lõi

- **Thời gian**: ~1h09m (2026-10-27 01:45:31Z → 02:54:54Z).
- **Mục tiêu**:
  1. Đọc và tóm tắt phiên OpenCode trước (`ses_e86f7c9b8ffeaV1f9CIm5tpCip`).
  2. Chuẩn bị môi trường điều phối: liên kết `mattpocock/skills`, nạp `orca-cli` và `orca-orchestration`.
  3. Dọn dẹp tài nguyên treo: giải phóng worker `ctx_d7b552134f84` trong run `run_f181df8d20f1`, xoá 5 worktree cũ.
  4. Đóng gói, kiểm thử toàn diện và merge **PR 15** (PR #64: `feat(core/bot): defineBot lễ tân thành pack MCP và skill`).
  5. Thiết lập và kích hoạt **PR 16** (issue #30: adapter OpenClaw cho pack lễ tân, run `run_fb18ca0e3bdf`, worker `ctx_5d5409ba75a9`).
  6. Xử lý cảnh báo lỗi toán tử ngoặc `botDisplayName` từ Auditor độc lập gửi qua hòm thư điều phối Orca.
- **Thống kê công cụ & Tài nguyên**:
  - **Messages**: 144 (User: 7, Assistant: 137).
  - **Tool calls**: 130 (`bash`: 87, `eval`: 20, `read`: 12, `grep`: 4, `edit`: 4, `wait`: 2, `write`: 1).
  - **Tool errors**: 10 lỗi.
  - **Token**: Input: 1,096,128; Output: 51,969; Cache Read: 14,844,729; Reasoning: 27,919.
  - **Chi phí**: ~$2.13 USD.
  - **Model chính**: `google-antigravity/gemini-3.8-flash` (high reasoning).

---

## 2. Bản đồ thời gian

| Mốc (UTC) | Hoạt động | Kết quả & Bằng chứng |
|---|---|---|
| **01:45–01:57** | Tìm và đọc dữ liệu phiên OpenCode `ses_e86f7c9b8ffeaV1f9CIm5tpCip` | Lỗi `history://` và scan đĩa bằng `find` tốn 57.4s; sau 15 tool call truy vấn SQLite `~/.local/share/opencode/opencode.db` thành công qua Python Eval. |
| **01:57–02:08** | Báo cáo tóm tắt phiên OpenCode cho người dùng | 16h chạy, merge 6 PR (#55, #56, #58, #60, #61, #62), PR 15 dang dở ở commit `2c23e29`. |
| **02:08–02:35** | Nhận chỉ đạo chuẩn bị, dọn dẹp hệ thống, kiểm tra PR 15 | - Chạy `link-skills.sh` tạo symlink 35 skills từ `~/.agents/skills/mattpocock`.<br>- Thu hồi worker `ctx_d7b552134f84` (gặp lỗi `consumer_fenced` khi check run cũ `run_f181df8d20f1`).<br>- Xoá 5 worktree cũ (`chore-flaky-test-script`, `feat-pr-11-ticket-commands`, v.v.).<br>- Chạy verify PR 15 (`bun test`, `bun run check:docs:refs`, `bun run scan`, `bun run verify`) → 100% pass. |
| **02:38** | Người dùng phê duyệt: *"ok làm đi nhé"* | Bắt đầu chu kỳ tạo PR 15 & khởi tạo PR 16. |
| **02:38–02:43** | Đẩy nhánh, mở PR #64, theo dõi CI và merge vào `main` | - Commit & push `feat/pr-15-define-bot-pack`.<br>- Mở PR #64 bằng `gh pr create`.<br>- CI xanh sau 1m03s; gọi `gh pr merge --delete-branch` gặp lỗi branch bị khoá bởi worktree; tháo worktree và squash-merge vào `main` (`ec354cb`). |
| **02:43–02:50** | Thiết lập PR 16 (RFC 0002 §1.7, issue #30) | - Đọc issue #30, tham chiếu 2 plugin legacy (`iris-tuong-tac`, `xac-nhan-xong`).<br>- Tạo worktree `feat-pr-16-openclaw-adapter`.<br>- Viết đặc tả `orchestration/specs/issue-30-pr-16-openclaw-adapter.md`.<br>- Tạo run `run_fb18ca0e3bdf`, dispatch worker `ctx_5d5409ba75a9` (Gemini 3.8 Flash high). |
| **02:50–02:54** | Nhận 2 tin nhắn điều phối từ Orca ("You have 1 orchestration message") | - Chạy `orca orchestration check`, nhận cảnh báo từ Auditor về lỗi logic `botDisplayName` trong PR 15 vừa merge.<br>- Coordinator chủ động sửa lỗi toán tử ngoặc `??` trong worktree PR 16, viết test kiểm chứng (`5 pass, 0 fail`).<br>- Ack đầy đủ các delivery `delivery_b120ae035bcd`, `delivery_f8274e219ac6`. |

---

## 3. Điều phối Orca & Thực thi kỹ năng Matt Pocock

### 3.1 Về phía Orca CLI & Orchestration
- **Đúng chuẩn**:
  - Vòng đời Run và Worker được khởi tạo bài bản qua `run-create` và `worker-start`.
  - Phản ứng kịp thời với tin nhắn điều phối qua `check --run` và `check --ack`.
  - Không làm nghẽn tiến trình coordinator (không dùng `terminal wait` hay vòng lặp poll vô tận).
- **Lệch chuẩn / Lỗi**:
  - `consumer_fenced`: Cố check trên Run `run_f181df8d20f1` thuộc quyền sở hữu của coordinator terminal phiên trước.
  - Xung đột Git Worktree: `gh pr merge --delete-branch` thất bại do nhánh vẫn đang được gắn với worktree đang mở.

### 3.2 Về phía vận dụng bộ kỹ năng Matt Pocock
- **Hiện tượng**: Agent chỉ thực hiện liên kết hình thức (`link-skills.sh`), nhưng **không gọi hay áp dụng bất kỳ skill Matt Pocock nào** trong suốt phiên (số lần đọc `skill://pr`, `skill://code-review`, `skill://tdd`, `skill://implement-spec` = 0).
- **Hệ quả cụ thể**:
  1. **Bỏ qua `code-review`**: Không chạy review độc lập 2 trục (**Standards** & **Spec**) trước khi merge PR 15 → lọt bug logic ngoặc toán tử `botDisplayName` vào `main` (`ec354cb`).
  2. **Bỏ qua `tdd`**: Không kiểm tra tại public seam của `exportSkillPack` với options tuỳ biến, để lại test tautological (chỉ test giá trị mặc định `"tieulinh"`, che giấu lỗi logic).
  3. **Bỏ qua `pr`**: Body của PR #64 soạn tự do bằng tiếng Việt, thiếu 3 mục bắt buộc: `Summary` (diff/tree), `Evidence` (Before/After), và `Merge Danger` (Door & Blast Radius).
  4. **Bỏ qua `writing-for-agents`**: File spec để phân tán trong worktree, không commit đồng thời vào git tree khiến việc tham chiếu ở coordinator gốc bị gãy đường dẫn.

---

## 4. Sai lầm và ma sát

| Mức độ | Vấn đề | Bằng chứng | Hạng mục (Skill Taxonomy) |
|---|---|---|---|
| **Cao** | Lọt lỗi logic vào `main` (PR 15): `(options.botDisplayName ?? def.id === "tieulinh") ? "Tiểu Linh" : def.id` nuốt chửng tên bot tuỳ biến. | Merge commit `ec354cb`; Auditor gửi cảnh báo qua tin nhắn `msg_9d6b85781895`. | Automated checks / Coding standards |
| **TB** | Quét mù transcript OpenCode: Gọi `read(history://ses_...)` rồi chạy `find ~` tốn 57.4s wall time. | Tool calls 1–3, mất ~15 lượt thoại để định vị file database SQLite. | Navigation / Information access |
| **TB** | Đoán mò schema SQLite của OpenCode: `SELECT count(*), role FROM message` bị lỗi `no such column: role`. | Tool call 8 trên `opencode.db`. | Information access / Tool economy |
| **TB** | Orca `consumer_fenced`: Coordinator mới cố gọi `check` trên Run của phiên trước. | `orca orchestration check --run run_f181df8d20f1` trả `consumer_fenced`. | Điều phối Orca |
| **TB** | Nhánh Git bị khoá bởi Worktree: `gh pr merge --delete-branch` văng lỗi vì worktree chưa được tháo. | `error: cannot delete branch used by worktree at ...` | Tool economy / Quy trình Git |
| **TB** | Thất lạc file đặc tả (Specs): Coordinator tìm file `orchestration/specs/issue-29...` ở main repo bị lỗi `No such file or directory`. | `head: cannot open orchestration/specs/...` | Navigation / File layout |
| **Thấp** | Lỗi syntax trong script Eval Python: Biến `c` bị gán nhầm thành string thay vì cursor. | `AttributeError: 'str' object has no attribute 'execute'`. | Tool economy |
| **Thấp** | Lệch neo hashline: `edit` báo lỗi dòng 385 chưa được hiển thị trong `read` trước đó. | Tool call `edit` trên `intake-step.test.ts`. | Tool use |

---

## 5. Ứng viên cải thiện (Xếp theo mức độ nghiêm trọng)

### **C1 (Cao) — Kiểm thử tự động & Review 2 trục bắt buộc (`skill://code-review` & `skill://tdd`)**
- **Vấn đề**: Toàn bộ 2,782 test suite của monorepo đều xanh dù có bug logic, vì không có test nào truyền `options.botDisplayName` tuỳ biến. Coordinator merge PR #64 mà không chạy review 2 trục.
- **Giải pháp**:
  1. Bắt buộc chạy sub-agent review 2 trục (**Standards** & **Spec**) độc lập trước khi mở hoặc merge PR.
  2. Bổ sung test bắt buộc cho mọi seam nhận `options`: 1 ca mặc định VÀ 1 ca tuỳ biến hoàn toàn.

### **C2 (TB) — Chuẩn hoá quy trình Worktree & Merge PR**
- **Vấn đề**: `gh pr merge <num> --squash --delete-branch` thất bại khi local branch đang checkout tại worktree.
- **Giải pháp**:
  1. Tháo worktree (`git worktree remove`) trước khi thực hiện merge PR.
  2. Sử dụng hoặc tạo script `scripts/merge-pr.sh` để kiểm tra điều kiện an toàn và đóng worktree tự động.

### **C3 (TB) — Con trỏ điều hướng lưu trữ dữ liệu các Agent (Navigation Pointer)**
- **Vấn đề**: Agent mất nhiều thời gian và tài nguyên quét đĩa tìm transcript vì không biết quy tắc lưu trữ của từng công cụ.
- **Giải pháp**:
  - Thêm một con trỏ điều hướng ngắn gọn vào tài liệu nội bộ: OMP lưu tại `~/.omp/agent/sessions/`, OpenCode lưu tại `~/.local/share/opencode/opencode.db`, Claude lưu tại `~/.claude/projects/`.

### **C4 (TB) — Ranh giới quyền hạn Run trong Orca Coordinator**
- **Vấn đề**: Coordinator gọi lệnh `check` trên Run của terminal khác dẫn tới lỗi `consumer_fenced`.
- **Giải pháp**:
  - Coordinator chỉ gọi `check` hoặc mutate trên Run do chính terminal hiện tại tạo ra. Với các Run cũ cần dọn dẹp, chỉ cần giải phóng worker (`worker-release`) và đóng terminal tương ứng.

### **C5 (Thấp) — Quản lý và lưu trữ Spec tập trung**
- **Vấn đề**: File spec nằm trong worktree của worker và không được commit cùng nhánh dẫn đến mất dấu vết ở coordinator.
- **Giải pháp**:
  - Mọi file spec trong `orchestration/specs/` phải được commit trực tiếp vào git của PR đó theo chuẩn `writing-for-agents`.

---

## 6. Kế hoạch hành động tiếp theo

1. [x] Thông báo chỉ đạo và cam kết áp dụng bộ skill Matt Pocock cho Điều phối viên chính (đã thực hiện qua message `msg_c07d09b94b60`).
2. [ ] Hoàn tất PR 16 với đầy đủ 2 trục review độc lập (`skill://code-review`) và mô tả PR 3 khối (`skill://pr`).
3. [ ] Soạn thảo trước đặc tả PR 17 (`orchestration/specs/issue-31-pr-17-runbook-shadow-canary.md`) để phiên chính sẵn sàng dispatch worker ngay sau khi PR 16 hoàn tất.
