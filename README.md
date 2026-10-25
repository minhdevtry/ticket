# ticket

Monorepo cho các bot tiếp nhận và xử lý ticket nội bộ của VuiHoc, chạy trên [itsaplan](https://github.com/croffasia/itsaplan) và [OpenClaw](https://openclaw.ai).

| Thư mục | Nội dung |
|---|---|
| [`packages/core`](packages/core) | `@vuihoc/bot-core`: thư viện dùng chung (logger, MCP server, itsaplan client, intake engine, Telegram, worker, eval) |
| [`docs`](docs) | Site tài liệu (VitePress, tiếng Việt), published lên GitHub Pages |
| [`apps/tieulinh-legacy`](apps/tieulinh-legacy) | **Tiểu Linh (bản tham chiếu đóng băng)**: bot tiếp nhận sự cố kỹ thuật qua Telegram → ticket itsaplan; hành vi = production, chỉ sửa lỗi nghiêm trọng |
| `apps/tieulinh` | Dự kiến: Tiểu Linh mới, xây bằng `defineBot` (chưa có trong repo) |
| `apps/op`, `apps/po`, `apps/cm` | Dự kiến: các bot vận hành, product, CM dùng chung core |

## Tài liệu

Site: <https://minhdevtry.github.io/ticket/>. Nguồn ở [`docs/`](docs): hướng dẫn, cách làm, tra cứu (API sinh từ code) và giải thích kiến trúc (bot có hai vai: lễ tân và hậu cần). CI giữ docs khớp code, xem [CONTRIBUTING.md](CONTRIBUTING.md).

## Bắt đầu

Yêu cầu: [Bun](https://bun.sh) ≥ 1.4.

```bash
bun install
bun run verify        # lint + typecheck + test + quét vệ sinh repo công khai + kiểm docs nhanh
bun run docs:dev      # xem trước site docs ở máy bạn
bun run --cwd apps/tieulinh-legacy mcp:tieulinh   # chạy MCP server Tiểu Linh (cần .env, xem dưới)
```

Cấu hình qua biến môi trường. Mẫu ở [`apps/tieulinh-legacy/openclaw/.env.example`](apps/tieulinh-legacy/openclaw/.env.example). **Không commit file `.env`**; secret được đẩy lên máy chạy qua SSH, xem [`deploy/README.md`](deploy/README.md).

## Kiến trúc

```
Telegram ──► OpenClaw gateway ──► agent (persona, skills)
                                     │ MCP (stdio)
                                     ▼
                         apps/tieulinh-legacy/mcp/tieulinh ──► itsaplan REST API
                                     │                       │ webhook
                              bot-core (core)         apps/tieulinh-legacy/worker ──► Telegram
```

- Logic tất định (thu thập trường, xác nhận, tạo ticket) nằm trong MCP tool và engine; model chỉ diễn đạt.
- itsaplan là nguồn sự thật; SQLite cục bộ chỉ là cache/trạng thái hội thoại.
- Quyết định kiến trúc: [`docs/adr`](docs/adr) (cấp repo), `packages/core/docs/adr`, `apps/tieulinh-legacy/docs/adr`; chỉ mục đầy đủ trên site docs.
- Kiến trúc đầy đủ (lễ tân và hậu cần): trang "Kiến trúc" trong site docs.

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md). Repo này **công khai**: đọc [SECURITY.md](SECURITY.md) trước khi commit.
