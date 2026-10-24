# Đóng góp

## Quy trình

1. Tạo nhánh từ `main`: `feat/<chủ-đề>`, `fix/<chủ-đề>`, `chore/<chủ-đề>`, `docs/<chủ-đề>`.
2. Commit theo [Conventional Commits](https://www.conventionalcommits.org): `feat(tieulinh): ...`, `fix(core): ...`, `docs: ...`. Scope là tên package: `core`, `tieulinh`, `deploy`, `ci`.
3. Chạy `bun run verify` trước khi đẩy.
4. Mở Pull Request vào `main`. CI phải xanh. Squash merge.

## Quy ước code

- TypeScript strict, chạy bằng Bun. Format và lint bằng Biome (`bun run format`).
- Test đặt cạnh file nguồn: `foo.ts` → `foo.test.ts`. Test không được gọi dịch vụ thật; `test-preload.ts` xoá biến môi trường thật trước khi chạy.
- Config đọc từ biến môi trường, kiểm tra khi khởi động; thiếu thì dừng với thông báo rõ ràng.
- Thay đổi `packages/core` là thay đổi cho mọi bot: thêm test, ghi vào `packages/core/CHANGELOG.md`.
- Quyết định kiến trúc quan trọng → viết ADR ngắn trong `docs/adr` (bối cảnh, quyết định, hệ quả, phương án đã loại).

## Chạy việc nặng ngoài máy dev

Máy dev yếu có thể đẩy `bun install`/`bun test` sang máy khác (ví dụ Colab qua `crun`). Chỉ code được đồng bộ; secret và DB không bao giờ rời máy dev.
