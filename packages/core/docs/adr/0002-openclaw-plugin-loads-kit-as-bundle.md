# ADR 0002 — Plugin `.mjs` do gateway nạp dùng `@vuihoc/bot-core/openclaw` qua BUNDLE vendored

Ngày: 2026-10-16 · Ticket: 07 (openclaw plugin kit) · Trạng thái: chấp nhận

## Bối cảnh

OpenClaw nạp plugin bằng một **đường dẫn tới file `.mjs`** (xem
`cm/openclaw-plugin/cm-support` + `openclaw.plugin.json`/`package.json` với
`"main": "index.mjs"`). Tiến trình gateway `import()` đúng file đó; nó KHÔNG chạy
qua bộ resolver module của repo bot. Vì vậy một plugin muốn dùng kit
`@vuihoc/bot-core/openclaw` phải trả lời: bare specifier `@vuihoc/bot-core/openclaw`
được resolve thế nào ở runtime của gateway?

Hai lựa chọn:

- **(A) import từ `node_modules`:** để plugin giữ nguyên câu `import ... from
  "@vuihoc/bot-core/openclaw"` và dựa vào `node_modules/@vuihoc/bot-core` nằm cạnh
  file plugin (consumer đã `bun install` git dep).
- **(B) vendor một BUNDLE:** `bun build` plugin + kit thành MỘT file `.mjs` tự
  chứa, rồi trỏ gateway vào file bundle đó.

## Bằng chứng (đo thật trong worktree này)

Qua `examples/openclaw-plugin-demo/` + `smoke.mjs`:

1. **Bare specifier KHÔNG tự resolve.** `bun build examples/.../index.mjs` thất bại
   `Could not resolve "@vuihoc/bot-core/openclaw"` khi không có
   `node_modules/@vuihoc/bot-core`. Nó chỉ resolve sau khi dựng self-link
   `node_modules/@vuihoc/bot-core -> <repo>` — tức đúng layout một consumer có SAU
   khi `bun install` git dependency.
2. **Bundle tự chứa.** `bun build --target=node --format=esm` ra một file
   (~0,68 MB, 102 module gộp lại) mà import NGOÀI duy nhất còn lại là `node:crypto`
   — một built-in của node. Không còn phụ thuộc `node_modules` nào.
3. **Bundle tải + chạy không cần gateway.** `import()` thẳng file bundle rồi chạy
   các hook với `api` giả: plugin ký `_identity` qua helper kit, token verify khớp,
   agent-gating loại đúng lượt agent khác.

## Quyết định

**Dùng (B): vendor bản BUNDLE** cho plugin `.mjs` chạy trên gateway.

Lý do:

- Gateway nạp theo đường dẫn file, không theo đồ thị `node_modules` của bot. (A)
  đòi mỗi lần deploy phải đảm bảo `node_modules/@vuihoc/bot-core` nằm **cạnh** file
  plugin trong workspace gateway (`~/.openclaw/...`) — một bất biến dễ gãy khi copy
  file plugin đi nơi khác, và chính là lớp lỗi "import hụt một cấp / token cứng"
  mà `layBotToken` (iris) từng dính.
- Bundle là MỘT file, không state ngoài, deploy = chép một file. `--target=node`
  giữ `node:*` ở dạng external built-in nên không phình thêm.
- Pin theo tag vẫn giữ được: bundle sinh ra từ một commit/tag cụ thể của thư viện;
  nâng phiên bản = build lại bundle từ tag mới (hợp spec: consumer tự quyết khi nào
  nâng).

## Hệ quả

- Mỗi plugin production kèm một bước build: `bun build <plugin>/index.mjs
  --target=node --format=esm --outfile <plugin>/<name>.bundle.mjs`, và
  `openclaw.plugin.json`/`package.json` trỏ `main` vào file bundle.
- Kit phải giữ **không phụ thuộc gói runtime OpenClaw** và chỉ dùng `node:*` +
  `zod` (đã thỏa) để bundle luôn tự chứa.
- (A) vẫn dùng được cho DEV trong repo thư viện (test, smoke) nơi self-link có sẵn;
  nó không phải đường deploy.

## Thay thế đã cân nhắc

- **(A) node_modules import** — bị loại cho production vì phụ thuộc layout
  node_modules cạnh file plugin, đúng lớp lỗi deploy đã gặp.
- **Giữ plugin dạng `.ts` để Bun chạy trực tiếp** — không khả thi: gateway nạp
  `.mjs`, không phải `.ts`.
