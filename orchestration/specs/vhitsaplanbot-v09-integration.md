# Đặc tả: Tích hợp và nâng cấp Thư viện độc lập @vuihoc/bot-core (vhitsaplanbot v0.9.0)

## Context

Thư viện `@vuihoc/bot-core` là repo độc lập tại `~/Documents/vhitsaplanbot` (remote: `minhdevtry/vhitsaplanbot.git`).
Đây là nguồn sự thật duy nhất phục vụ toàn bộ các bot thật của VuiHoc:
- **Bot OP (`operationbot`)**: Đang chạy phục vụ `@vhops_bot` cho phòng Vận hành (Sales & Quản lý lớp), phụ thuộc `vhitsaplanbot#v0.8.0` với 456 bài test xanh 100%.
- **Tiểu Linh (`apps/tieulinh`)**: Sẽ sử dụng bản phát hành độc lập này để cắm vào OpenClaw.
- **Các bot tiếp theo (PO, CM)**: Sẽ lấy thư viện này làm khung mẫu mực.

**Mục tiêu tối thượng**:
1. Tích hợp toàn bộ tinh hoa đã được tôi luyện bằng mồ hôi xương máu từ:
   - GitLab server `newticketagent` (chống trùng lặp, chống bão callback query, chống noop, tương tác 2 chiều Itsaplan ➔ Telegram).
   - Chuỗi RFC 0002 (khung `defineBot` / `createBot` chuẩn mực, `exportSkillPack`, cơ chế `requireApproval: false` mặc định).
2. **BẢO ĐẢM TUYỆT ĐỐI**: Không làm gãy bất kỳ API hay hợp đồng nào mà Bot OP (`operationbot`) đang dùng. Toàn bộ 456 test của `operationbot` phải giữ nguyên 100% pass!
3. Chuẩn bị phát hành git tag `v0.9.0` độc lập.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `README.md` và `docs/adoption/op-bump-v0.8.md` trong `vhitsaplanbot`.
- `packages/core/src/bot/` và `packages/core/src/intake/mcp/skill-pack.ts` trong monorepo `ticket`.
- `~/Documents/operationbot/package.json` và `bot/main.ts`.

---

## Deliverables (Các việc cần làm)

### 1. Tích hợp tầng `bot` (`defineBot`, `createBot`, `runBot`)
- Bổ sung thư mục `src/bot/` vào `vhitsaplanbot`:
  - `define.ts`: Định nghĩa bot 1-file chuẩn chỉnh (`id`, `tracker`, `persona`, `receptionist`, `backoffice`).
  - `create.ts`: Factory khởi tạo runtime.
  - `run.ts`: Khởi chạy bot bền vững.
- Cập nhật `package.json` của `vhitsaplanbot` để export subpath: `"./bot": "./src/bot/index.ts"`.

### 2. Tinh chỉnh cơ chế duyệt Identity (`requireApproval = false` mặc định)
- Trong `src/identity/service.ts`:
  - Đổi giá trị mặc định của `requireApproval` sang `false` (mặc định mở, không bắt admin duyệt):
    `this.requireApproval = options.requireApproval ?? false;`
  - Khi cấu hình bật duyệt (`requireApproval: true`), người dùng mới rơi vào `pending`.
- Cập nhật bài test trong `src/identity/identity.test.ts` kiểm chứng cả 2 ca.

### 3. Tích hợp Skill Pack Generator (`exportSkillPack`)
- Bổ sung `exportSkillPack` vào `src/intake/mcp/skill-pack.ts` (và re-export tại `src/intake/mcp/index.ts`):
  - Xuất trọn vẹn bộ file OpenClaw (`bot.json`, `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `skills/`).
  - Không hardcode tiếng Việt hay tên bot trong core (lấy qua `CopyCatalog` và options).

### 4. Đảm bảo toàn vẹn cơ chế 2 chiều & Chống trùng (Từ server GitLab `newticketagent`)
- Rà soát các module đã có trong `vhitsaplanbot`:
  - `src/intake/noop-guard.ts`: Chặn tin nhắn rỗng và token nội bộ của nút đã khóa.
  - `src/worker/notifier.ts`: Dispatch thông báo từ Itsaplan webhook ngược về Telegram người báo.
  - `src/core/outbox.ts`: Cơ chế outbox gửi lại có kiểm soát.
  - Đảm bảo các cơ chế này sẵn sàng để Bot OP và các bot khác thừa hưởng luồng 2 chiều mượt mà.

### 5. Kiểm thử chéo bắt buộc (Verification Gates)
- **Cổng 1 (Nội bộ thư viện)**:
  `cd ~/orca/workspaces/vhitsaplanbot/feat-v0.9-core-hardening && bun test src` ➔ Toàn bộ 517 tests cũ + các tests mới phải xanh 100%!
  `bunx tsc --noEmit` ➔ Typecheck nghiêm ngặt không lỗi.
- **Cổng 2 (Kiểm tra chéo với Bot OP)**:
  `cd ~/Documents/operationbot && bun test` ➔ Toàn bộ 456 tests của `operationbot` phải xanh 100%! Không được phép có bất kỳ breaking change nào làm gãy Bot OP đang chạy.

### 6. Cập nhật tài liệu & Bản phát hành
- Cập nhật `CHANGELOG.md` của `vhitsaplanbot` cho mục `## [0.9.0]`.
- Cập nhật `docs/adoption/README.md`.

---

## Ranh giới & Điều cấm (Worker Constraints)

- **Thư mục làm việc**: `~/orca/workspaces/vhitsaplanbot/feat-v0.9-core-hardening`.
- **CẤM**:
  - Không commit, không push (Coordinator sẽ thực hiện sau khi review 2 trục).
  - Không xoá hoặc thay đổi chữ ký hàm của các export cũ mà `operationbot` đang gọi (`getLogger`, `describeToolFailure`, `inspectBindingDb`, `ItsaplanWebhookServer`, `AgentRunWorker`).
  - Không đưa secret, IP nội bộ hay token thật vào mã nguồn hoặc test fixture.

---

## Tiêu chí chấp nhận (Acceptance Criteria)

- [ ] `src/bot/` được tích hợp hoàn chỉnh và export tại subpath `./bot`.
- [ ] `src/identity/service.ts` mặc định `requireApproval = false`.
- [ ] `exportSkillPack` xuất được Skill Pack OpenClaw hợp lệ.
- [ ] Toàn bộ test của `vhitsaplanbot` pass 100%.
- [ ] Toàn bộ 456 test của `operationbot` pass 100% không hồi quy.
- [ ] `bunx tsc --noEmit` sạch 100%.
- [ ] `CHANGELOG.md` được cập nhật đầy đủ cho `v0.9.0`.
