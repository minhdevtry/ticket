# @vuihoc/bot-core

Thư viện TypeScript/Bun dùng chung cho các bot ticket của VuiHoc. Một package, mỗi tầng là một subpath: `core`, `itsaplan`, `intake`, `identity`, `openclaw`, `telegram`, `worker`, `eval`, cùng bot kit `bot`, `backoffice`, `testing` (và `prose/*` cho markdown dùng chung).

Package nằm trong monorepo `ticket` và được app dùng qua `"@vuihoc/bot-core": "workspace:*"`. Mã nguồn TypeScript được phát hành trực tiếp, không có bước build.

## Tài liệu

Toàn bộ tài liệu ở site docs: <https://minhdevtry.github.io/ticket/> (nguồn trong thư mục `docs/` ở gốc repo).

- Bắt đầu: `docs/guide/`
- Việc cụ thể (catalog, kênh chat, worker báo ngược, deploy): `docs/how-to/`
- API, biến môi trường, sự kiện webhook, CopyKey: `docs/reference/` (API sinh bằng TypeDoc lúc build)
- Vì sao thiết kế như vậy: `docs/explanation/`

## Phát triển

```bash
bun install            # từ thư mục gốc monorepo
bun run test           # bun test src
bun run check          # tsc --noEmit -p .
```

Trước 1.0 cho phép breaking change nhưng phải ghi trong [`CHANGELOG.md`](CHANGELOG.md). Đổi hành vi hoặc API thì cập nhật docs trong cùng PR (CI kiểm, xem `CONTRIBUTING.md`).
