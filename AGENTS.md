# Hướng dẫn cho agent

Repo **công khai**. Trước mọi commit: không secret, không IP/host nội bộ, không số điện thoại, chat ID, tên người thật. `bun run scan` phải sạch. Chi tiết: [SECURITY.md](SECURITY.md).

## Bản đồ

- `packages/core`: `@vuihoc/bot-core`, import qua subpath (`@vuihoc/bot-core/core`, `/itsaplan`, `/intake`, `/identity`, `/openclaw`, `/telegram`, `/worker`, `/eval`). Logic dùng chung cho mọi bot đặt ở đây, không chép sang app.
- `apps/tieulinh`: bot tiếp nhận sự cố kỹ thuật.
  - `mcp/tieulinh`: MCP server và domain (catalog, rules JSON, formatter).
  - `lib/intake-step`: engine hội thoại (`pipeline.ts`).
  - `worker`: webhook itsaplan → Telegram, vòng đời ticket.
  - `skills/tieulinh`: persona và workspace OpenClaw (đồng bộ bằng `openclaw/sync-workspace.ts`).
  - `openclaw-plugin`: plugin nút bấm, xác nhận xong.
- `deploy/`: unit systemd, template, script deploy qua SSH.
- `docs/adr`: quyết định cấp repo. Mỗi package có `docs/adr` riêng.

## Lệnh

```bash
bun install
bun run verify                      # lint + check + test + scan
bun run --cwd packages/core test
bun run --cwd apps/tieulinh test
```

## Nguyên tắc

- Logic tất định ở tool và engine; prompt chỉ lo diễn đạt. Đừng chuyển quyết định nghiệp vụ vào prompt.
- itsaplan là nguồn sự thật; SQLite cục bộ là cache.
- Test không gọi dịch vụ thật. Script `live:*` phải bật tay.
- Sửa core → thêm test trong core và ghi `packages/core/CHANGELOG.md`.
- Commit theo Conventional Commits, scope là tên package.
