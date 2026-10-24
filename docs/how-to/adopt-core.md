# Chuyển bot sang bot-core

Dùng khi một bot đã có (tự chép code hoặc viết riêng) và muốn dùng `@vuihoc/bot-core`. Thư viện không sửa gì trong bot: mỗi quyết định chuyển là của chủ bot. Với một ví dụ đã làm xong và những chỗ phải giữ adapter, xem [Chuyển Tiểu Linh sang bot-core](/how-to/migrate-tieulinh).

## 1. Cài đặt

Bot trong monorepo khai `workspace:*`:

```jsonc
// apps/<app>/package.json
{
  "dependencies": {
    "@vuihoc/bot-core": "workspace:*"
  }
}
```

Bot đứng ngoài monorepo cần cách phân phối khác (publish package hoặc vendoring). Đó là quyết định của chủ bot; hiện chưa có quy trình chính thức.

## 2. Nâng và đổi hành vi

Thư viện ở 0.x: cho phép breaking change nhưng phải ghi trong `packages/core/CHANGELOG.md`. Đọc changelog trước khi nâng, chạy lại bộ test của bot và so với baseline trước khi deploy. Sửa thư viện và bot trong cùng một PR: CI chạy test của cả hai.

Khi app đi trước thư viện ở một hành vi, đưa hành vi đó vào `packages/core` (kèm test) thay vì bỏ. Khi một bot cần giữ chính xác hành vi cũ, thư viện giữ mặc định tốt hơn và bot truyền tuỳ chọn tường minh.

## 3. Dấu comment bot (bắt buộc đọc)

Thư viện ghi một dấu vào mọi comment bot viết lên tracker (mặc định `<!-- intake-bot -->`, hằng `BOT_COMMENT_MARKER`) để worker không gửi lặp lại chính câu của mình: comment bot rồi webhook rồi worker đẩy về kênh sẽ thành vòng echo.

- Một bot dùng dấu khác intake thì phải gọi `setBotCommentMarker(...)` lúc khởi động, **trước** khi ghi comment đầu tiên. Nếu không, comment của bot mang dấu mặc định và worker intake có thể nhận nhầm, hoặc worker của bot coi comment của thư viện là của người.
- Phía đọc (`isBotComment`) hiểu mọi dấu trong `LEGACY_BOT_COMMENT_MARKERS`; chỉ phía ghi cần đặt.
- Bot dùng dấu mặc định (như Tiểu Linh) không cần gọi gì.

```ts check
import { getBotCommentMarker, setBotCommentMarker } from "@vuihoc/bot-core/core";

setBotCommentMarker("<!-- my-bot -->");
export const marker = getBotCommentMarker();
```

## 4. Test không được chạm dịch vụ thật

`bun test` không bao giờ được gọi tracker, Telegram hay LLM thật. Bun tự nạp `.env` của thư mục chạy, nên test chạy với token thật nếu không dọn. Cách làm: một file preload khai trong `bunfig.toml` của bot, gọi `scrubOutboundEnv` với danh sách tiền tố của bot (xem `apps/tieulinh/test-preload.ts` làm mẫu). Thư viện cũng có preload sẵn cho bộ biến phổ biến ở `packages/core/src/core/test-preload.ts`. Giữ `RUN_LIVE_LLM=1` nếu cần chạy LLM thật.

## 5. Ẩn chi tiết lỗi kỹ thuật khỏi người dùng

Mặc định `describeToolFailure` kèm dòng "Chi tiết". Bot không muốn người dùng thấy chi tiết kỹ thuật bật một lần lúc khởi động `setToolFailureOptions({ hideDetailFromUser: true })`: người dùng chỉ thấy mã lỗi và lời dặn chụp màn hình, còn log và trường chi tiết giữ nguyên cho kỹ thuật tra ngược.

## 6. Khử PII trước khi ghi log

`redactIncidentPII` (trong `@vuihoc/bot-core/core`) che số điện thoại VN, email, CCCD, id Telegram, token và mật khẩu trong một chuỗi. Áp nó lên mọi chuỗi trước khi ghi log hay file nhật ký, nhất là nội dung hội thoại có số điện thoại phụ huynh.

## 7. Plugin OpenClaw nạp theo bundle

Gateway OpenClaw nạp plugin theo **đường dẫn file** `.mjs`, không qua resolver `node_modules` của bot. Vì vậy plugin dùng `@vuihoc/bot-core/openclaw` phải được `bun build` thành một file bundle tự chứa, rồi `openclaw.plugin.json` hoặc `package.json` trỏ `main` vào file đó (lý do và số đo ở ADR-0002 của core, xem [chỉ mục ADR](/explanation/adr-index)):

```bash
bun build <plugin>/index.mjs --target=node --format=esm \
  --outfile <plugin>/<name>.bundle.mjs
```

Đã đo: bare specifier không tự resolve khi thiếu `node_modules/@vuihoc/bot-core` cạnh file plugin; bundle `--target=node` chỉ còn import ngoài là `node:crypto`. Nâng thư viện nghĩa là build lại bundle.
