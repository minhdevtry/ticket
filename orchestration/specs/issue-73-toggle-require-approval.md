# Đặc tả: Issue #73 — Hỗ trợ bật/tắt duyệt name code qua .env (mặc định không duyệt)

## Context

Repo: `minhdevtry/ticket`. Đây là Issue #73: Chuẩn hoá tính năng bật/tắt duyệt name code người báo trong thư viện `@vuihoc/bot-core` và ứng dụng.
- **Mục tiêu**: Thư viện phải hỗ trợ bật/tắt duyệt name code linh hoạt. Sau này bot chỉ cần cấu hình ở `.env` bật duyệt (`REQUIRE_APPROVAL=true`) là sẽ duyệt, còn lại **mặc định là không duyệt** (`requireApproval: false`).

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `packages/core/src/identity/service.ts` (`IdentityService`, `requireApproval`).
- `packages/core/src/identity/identity.test.ts`.
- `packages/core/src/bot/define.ts` (`ReceptionistDefinition`).
- `apps/tieulinh/env.ts` (`tieulinhEnv`).

---

## Problem Statement

Hiện tại:
- Trong `packages/core/src/identity/service.ts` (dòng 76), giá trị mặc định đang là `true`:
  `this.requireApproval = options.requireApproval ?? true;`
- Điều này khiến mọi bot dùng `@vuihoc/bot-core` nếu không cấu hình tường minh thì mặc định bị ép vào chế độ kiểm duyệt (`pending`), người dùng mới báo sự cố bị chặn lại đòi admin duyệt.
- Chưa có biến môi trường chuẩn trong `env.ts` để ứng dụng bot bật/tắt duyệt từ file `.env` một cách dễ dàng.
- Trong một số file cấu hình (như launcher cũ), cờ `REQUIRE_APPROVAL` bị gán cứng là `"true"`.

---

## Solution

1. **Ở thư viện `@vuihoc/bot-core/identity` (`packages/core/src/identity/service.ts`)**:
   - Đổi mặc định của `requireApproval` sang `false`:
     `this.requireApproval = options.requireApproval ?? false;`
   - Khi `this.requireApproval = false`:
     - Hàm `checkUserApproval(uid)` trả về `isApproved: true, requiresApproval: false`.
     - Hàm `registerIdentity()` tự động duyệt (`autoApproved: true, reason: "auto_approved_open"`).
2. **Ở khai báo Bot (`packages/core/src/bot/define.ts`)**:
   - Bổ sung trường tuỳ chọn vào `ReceptionistDefinition`:
     ```ts
     /**
      * Yêu cầu duyệt name code người báo (mặc định: false - không duyệt).
      * Bật khi cấu hình .env (REQUIRE_APPROVAL=true).
      */
     requireApproval?: boolean;
     ```
3. **Ở tầng cấu hình ứng dụng (`apps/tieulinh/env.ts`)**:
   - Thêm biến vào `tieulinhEnv`:
     ```ts
     /** Bật duyệt name code người báo (mặc định: false - không duyệt). */
     REQUIRE_APPROVAL: z.stringbool().default(false),
     ```
4. **Ở launcher máy dev (`deploy/dev/tl2-local.sh`)**:
   - Nạp biến `REQUIRE_APPROVAL` từ `.env` (mặc định `false`), truyền vào cấu hình của bot thay vì hardcode `"true"`.

---

## Testing Decisions

1. **Cập nhật `packages/core/src/identity/identity.test.ts`**:
   - Ca test 1: Khởi tạo `new IdentityService(repo)` không truyền options -> xác nhận `requireApproval` mặc định là `false`, đăng ký người dùng mới tự động được duyệt (`auto_approved_open`).
   - Ca test 2: Khởi tạo `new IdentityService(repo, { requireApproval: true })` -> xác nhận người dùng mới rơi vào trạng thái `pending`, lý do `"pending"`.
   - Toàn bộ 28 bài test của `identity.test.ts` pass 100%.
2. **Kiểm tra ứng dụng**:
   - `bun test apps/tieulinh` pass 100%.
3. **Kiểm định toàn cục**:
   - `bun run verify` pass hoàn toàn.
   - `bun run scan` sạch 100%.

---

## Ranh giới & Điều cấm (Worker Constraints)

- **Chỉ sửa trong**:
  - `packages/core/src/identity/service.ts`
  - `packages/core/src/identity/identity.test.ts`
  - `packages/core/src/bot/define.ts`
  - `apps/tieulinh/env.ts`
  - `deploy/dev/tl2-local.sh`
  - `packages/core/CHANGELOG.md`
- **CẤM**:
  - Không sửa mã legacy `apps/tieulinh-legacy/**`.
  - Không commit, không push (Coordinator phiên chính sẽ thực hiện).

---

## Tiêu chí chấp nhận (Acceptance Criteria)

- [ ] `IdentityService` mặc định `requireApproval = false` khi không có options.
- [ ] `ReceptionistDefinition` hỗ trợ `requireApproval?: boolean`.
- [ ] `apps/tieulinh/env.ts` có biến `REQUIRE_APPROVAL` với giá trị mặc định là `false`.
- [ ] `identity.test.ts` có test phủ ca mặc định (false) và ca bật duyệt (true).
- [ ] Ghi chú thay đổi vào `packages/core/CHANGELOG.md`.
- [ ] `bun run verify` và `bun run scan` pass 100%.
