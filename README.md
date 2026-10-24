# ticket

Monorepo cho các bot tiếp nhận và xử lý ticket nội bộ của VuiHoc, chạy trên [itsaplan](https://github.com/croffasia/itsaplan) và [OpenClaw](https://openclaw.ai).

| Thư mục | Nội dung |
|---|---|
| [`packages/core`](packages/core) | `@vuihoc/bot-core`: thư viện dùng chung (logger, MCP server, itsaplan client, intake engine, Telegram, worker, eval) |
| [`apps/tieulinh`](apps/tieulinh) | **Tiểu Linh**: bot tiếp nhận sự cố kỹ thuật qua Telegram → ticket itsaplan |
| `apps/op`, `apps/po`, `apps/cm` | Dự kiến: các bot vận hành, product, CM dùng chung core |

## Bắt đầu

Yêu cầu: [Bun](https://bun.sh) ≥ 1.4.

```bash
bun install
bun run verify        # lint + typecheck + test + quét vệ sinh repo công khai
bun run --cwd apps/tieulinh mcp:tieulinh   # chạy MCP server Tiểu Linh (cần .env, xem dưới)
```

Cấu hình qua biến môi trường. Mẫu ở [`apps/tieulinh/openclaw/.env.example`](apps/tieulinh/openclaw/.env.example). **Không commit file `.env`**; secret được đẩy lên máy chạy qua SSH, xem [`deploy/README.md`](deploy/README.md).

## Kiến trúc

```
Telegram ──► OpenClaw gateway ──► agent (persona, skills)
                                     │ MCP (stdio)
                                     ▼
                         apps/tieulinh/mcp/tieulinh ──► itsaplan REST API
                                     │                       │ webhook
                              bot-core (core)         apps/tieulinh/worker ──► Telegram
```

- Logic tất định (thu thập trường, xác nhận, tạo ticket) nằm trong MCP tool và engine; model chỉ diễn đạt.
- itsaplan là nguồn sự thật; SQLite cục bộ chỉ là cache/trạng thái hội thoại.
- Quyết định kiến trúc: [`docs/adr`](docs/adr) (cấp repo), `packages/core/docs/adr`, `apps/tieulinh/docs/adr`.

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md). Repo này **công khai**: đọc [SECURITY.md](SECURITY.md) trước khi commit.
