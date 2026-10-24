# Hướng dẫn chuyển sang `@vuihoc/bot-core`

Tài liệu này MÔ TẢ việc chủ bot cần làm để một bot thật dùng thư viện. Thư viện
không sửa gì trong bot: intake-agents, teacheragent, Bot-Sales đang chạy thật,
chỉ đọc. Mỗi quyết định chuyển là của chủ bot.

Mỗi bot có một hướng dẫn riêng:
- [`tieulinh-iris.md`](./tieulinh-iris.md) — Tiểu Linh / Iris (intake-agents), dùng tới `intake`.
- [`cm.md`](./cm.md) — Bot CM (teacheragent), dùng `core` + `itsaplan`.
- [`bot-sales.md`](./bot-sales.md) — Bot-Sales, chỉ `core` + `openclaw`.

## 1. Cài đặt

Thư viện nằm trong monorepo `ticket` tại `packages/core` và được app dùng qua
`workspace:*`:

```jsonc
// package.json của app
"dependencies": {
  "@vuihoc/bot-core": "workspace:*"
}
```

Bot đứng ngoài monorepo cần một cách phân phối khác (ví dụ publish package hoặc
vendoring); lựa chọn đó là quyết định của chủ bot.

## 2. Phiên bản

- Trước 1.0 cho phép breaking change nhưng phải ghi trong `CHANGELOG.md`. Đọc
  changelog trước khi nâng.
- Sau khi nâng, chạy lại suite của bot và đối chiếu baseline (xem từng guide)
  TRƯỚC khi deploy.

## 3. Luật dấu comment bot (bắt buộc đọc)

Thư viện ghi dấu mặc định `<!-- intake-bot -->`
(`src/core/formatting.ts`, `BOT_COMMENT_MARKER`). Dấu này đi vào mọi comment bot
viết lên tracker để worker không gửi lặp lại chính câu của mình (vòng echo:
comment bot → webhook → worker đẩy về kênh).

- Worker đang chạy chỉ nhận ĐÚNG dấu của mình. Nếu bot CM (hay bot khác intake)
  nạp thư viện mà KHÔNG đổi dấu, comment của nó mang `<!-- intake-bot -->` và
  worker intake sẽ coi nhầm — hoặc ngược lại worker CM coi comment thư viện là
  của NGƯỜI, học sai (ADR-0007 intake) và vòng echo quay lại.
- **CM phải gọi `setBotCommentMarker('<!-- cm-bot -->')` lúc khởi động**, trước
  khi ghi comment đầu tiên. `LEGACY_BOT_COMMENT_MARKERS` đã chứa cả hai dấu nên
  phía ĐỌC/nhận-diện (`isBotComment`) hiểu được cả hai; chỉ phía GHI cần đặt.
- Tiểu Linh/Iris giữ nguyên mặc định `<!-- intake-bot -->`, không cần gọi.

Nguồn: `src/core/formatting.ts` (`setBotCommentMarker`, `getBotCommentMarker`,
`BOT_COMMENT_MARKER`, `LEGACY_BOT_COMMENT_MARKERS`, `isBotComment`,
`markBotComment`).

## 4. Test preload (chặn gọi dịch vụ thật)

`bun test` phải không bao giờ chạm tracker/Telegram/KG thật. Thư viện có sẵn
file preload khai trong `bunfig.toml`:

```toml
[test]
preload = ["./node_modules/@vuihoc/bot-core/src/core/test-preload.ts"]
```

File này (`src/core/test-preload.ts`) xoá đúng bộ biến Tiểu Linh/CM dùng
(`TELEGRAM_`, `ITSAPLAN_`, `ONYX_`, `MEMGRAPH_`, `CRM_`, `CM_ITSAPLAN_API_KEY`,
`CM_TELEGRAM_BOT_TOKEN`, `OPENAI_` …). Bot có bộ biến khác thì tự viết preload
riêng gọi `scrubOutboundEnv()` với danh sách của mình
(`src/core/test-preload-helper.ts`). Giữ `RUN_LIVE_LLM=1` nếu cần chạy LLM thật.

## 5. Luật plugin OpenClaw: nạp theo BUNDLE (ADR-0002)

Gateway OpenClaw nạp plugin theo ĐƯỜNG DẪN FILE `.mjs`, không qua resolver
`node_modules` của bot. Vì vậy plugin production dùng `@vuihoc/bot-core/openclaw`
phải được `bun build` thành MỘT file bundle tự chứa
(`docs/adr/0002-openclaw-plugin-loads-kit-as-bundle.md`):

```sh
bun build <plugin>/index.mjs --target=node --format=esm \
  --outfile <plugin>/<name>.bundle.mjs
```

Rồi `openclaw.plugin.json` / `package.json` trỏ `main` vào file bundle. Đã đo:
bare specifier không tự resolve khi thiếu `node_modules/@vuihoc/bot-core` cạnh
file plugin; bundle (`--target=node`) chỉ còn import ngoài là `node:crypto`.
Nâng tag = build lại bundle từ tag mới.
