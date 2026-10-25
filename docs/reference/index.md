# Tra cứu

Thông tin để tra, không để đọc từ đầu tới cuối. Phần lớn được sinh hoặc được CI đối chiếu với code, nên đáng tin hơn văn xuôi.

| Trang | Nguồn |
|---|---|
| [Subpath và entry point](/reference/entry-points) | `exports` của `packages/core/package.json` (CI đối chiếu) |
| [API (TypeDoc)](/reference/api/) | Sinh lúc build từ TSDoc trong `packages/core/src`, không commit |
| [Cấu hình và biến môi trường](/reference/config-env) | Code của `apps/tieulinh-legacy` (CI đối chiếu) |
| [Giao thức agent-runs](/reference/agent-runs) | `packages/core/src/itsaplan/agent-runs` và `FakeItsaplan` (server giả nói đúng giao thức) |
| [Sự kiện webhook itsaplan](/reference/webhook-events) | `packages/core/src/itsaplan/webhook` (CI đối chiếu) |
| [Danh sách CopyKey](/reference/copy-keys) | Sinh lúc build từ `packages/core/src/intake/ports.ts` |

Trang API và danh sách CopyKey không nằm trong git: chạy `bun run docs:gen` (hoặc `bun run docs:dev`) để sinh ra ở máy bạn.
