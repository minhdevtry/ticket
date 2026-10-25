# Hướng dẫn cho agent

Repo **công khai**. Trước mọi commit: không secret, không IP/host nội bộ, không số điện thoại, chat ID, tên người thật. `bun run scan` phải sạch. Chi tiết: [SECURITY.md](SECURITY.md).

## Bản đồ

- `packages/core`: `@vuihoc/bot-core`, import qua subpath (`@vuihoc/bot-core/core`, `/itsaplan`, `/intake`, `/identity`, `/openclaw`, `/telegram`, `/worker`, `/eval`, và bot kit: `/bot`, `/backoffice`, `/testing`). Logic dùng chung cho mọi bot đặt ở đây, không chép sang app.
- `apps/tieulinh-legacy` (`@vuihoc/tieulinh-legacy`): Tiểu Linh hiện tại, **bản tham chiếu đóng băng** (hành vi = production, dùng làm mốc so sánh shadow). Chỉ sửa lỗi nghiêm trọng; tính năng mới làm ở `apps/tieulinh` (app mới, `defineBot`, chưa có trong repo). Bot tiếp nhận sự cố kỹ thuật.
  - `mcp/tieulinh`: MCP server và domain (catalog, rules JSON, formatter).
  - `lib/intake-step`: engine hội thoại (`pipeline.ts`).
  - `worker`: webhook itsaplan → Telegram, vòng đời ticket.
  - `skills/tieulinh`: persona và workspace OpenClaw (đồng bộ bằng `openclaw/sync-workspace.ts`).
  - `openclaw-plugin`: plugin nút bấm, xác nhận xong.
- `tools/tl2-shadow`: bộ chạy bóng Tiểu Linh 2 (relay, proxy giữ secret, tunnel, so sánh). Chỉ chạy trên máy dev; xem `docs/how-to/shadow-tl2.md`, ADR-0005.
- `deploy/`: script đẩy secret qua SSH và README deploy (chưa có unit systemd trong repo).
- `docs/`: site VitePress (tiếng Việt), published lên GitHub Pages. Gồm `guide/`, `how-to/`, `reference/`, `explanation/` và `adr/` (quyết định cấp repo). Mỗi package/app có `docs/adr` riêng cạnh code.
- `scripts/`: `scan-public.ts` (vệ sinh repo công khai), `gen-docs.ts`, `check-doc-snippets.ts`, `check-docs-refs.ts`, `check-docs-touched.ts` (kiểm docs).

## Lệnh

```bash
bun install
bun run verify                      # lint + check + test + scan + kiểm docs nhanh
bun run docs:dev                    # xem trước site docs
bun run docs:check                  # build site + TypeDoc + mẫu code + đối chiếu (như CI)
bun run --cwd packages/core test
bun run --cwd apps/tieulinh-legacy test
```

## Nguyên tắc

- Logic tất định ở tool và engine; prompt chỉ lo diễn đạt. Đừng chuyển quyết định nghiệp vụ vào prompt.
- itsaplan là nguồn sự thật; SQLite cục bộ là cache.
- Test không gọi dịch vụ thật. Script `live:*` phải bật tay.
- Sửa core → thêm test trong core và ghi `packages/core/CHANGELOG.md`.
- Đổi hành vi hoặc API công khai → cập nhật `docs/` trong cùng PR (CI chặn nếu thiếu; nhãn `no-docs` chỉ cho refactor thuần và test). Mẫu `ts` trong docs phải có cờ `check`, `run` hoặc `no-check`. Không bao giờ chép chữ ký hàm vào docs bằng tay khi TypeDoc đã sinh.
- Commit theo Conventional Commits, scope là tên package.
