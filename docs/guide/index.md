# Giới thiệu

`@vuihoc/bot-core` (thư mục `packages/core`) là thư viện TypeScript chạy bằng Bun, dùng chung cho các bot ticket của VuiHoc. Mỗi bot đứng ở hai đầu của một ticket trên [itsaplan](https://github.com/croffasia/itsaplan):

- **Lễ tân**: nhận tin từ kênh chat, hỏi bổ sung theo catalog, xin người báo xác nhận, rồi tạo ticket. Sau đó báo ngược mọi thay đổi của ticket về đúng chat.
- **Hậu cần**: xử lý ticket sau khi nó đã tồn tại, bằng agent ngoài chạy theo trigger và rule. Bot kit (`defineBot`/`createBot`) đã chạy được phần này, xem [Bot kit](/explanation/bot-kit).

Xem [Kiến trúc: lễ tân và hậu cần](/explanation/architecture) để hiểu vì sao tách hai vai.

## Trạng thái hiện tại

| Phần | Trạng thái |
|---|---|
| Lễ tân: gate tiếp nhận, engine hội thoại, tạo ticket, báo ngược (`intake`, `worker`, `telegram`, `itsaplan`) | Có trong thư viện, dùng được |
| Định danh người dùng, bộ công cụ plugin OpenClaw, khung eval | Có trong thư viện |
| `defineBot({...})` và `createBot`: một khai báo cho cả bot, vòng đời, health, đọc env (`bot`) | Có (milestone 1), 0.x nên chữ ký còn có thể đổi |
| Hậu cần: handler theo trigger, luật, tracker khoá theo dự án (`backoffice`), itsaplan giả để test (`testing`) | Có (milestone 1) |
| Vai lễ tân trong `createBot`, lịch cron do bot giữ, hẹn giờ bền, host OpenClaw | Chưa có (milestone 2 và 3), xem [RFC 0001](/rfc/0001-bot-kit) |
| Tiểu Linh (`apps/tieulinh-legacy`) dùng bot-core | Có, qua `workspace:*`. Còn vài adapter mỏng và phần chưa thay (pipeline hội thoại, dispatcher), xem [Chuyển Tiểu Linh sang bot-core](/how-to/migrate-tieulinh) |

Vai hậu cần dựng nhanh bằng `defineBot`. Vai lễ tân hôm nay vẫn ghép từ các phần (port) của thư viện, các trang [Cách làm](/how-to/) mô tả cách ghép đó.

## Cài đặt

Thư viện nằm trong monorepo `ticket` và các app dùng nó qua `workspace:*`:

```jsonc
// apps/<app>/package.json
{
  "dependencies": {
    "@vuihoc/bot-core": "workspace:*"
  }
}
```

Thư viện phát hành mã nguồn TypeScript, không có bước build. Import theo subpath của từng tầng (danh sách ở [Subpath và entry point](/reference/entry-points)):

```ts check
import { getLogger } from "@vuihoc/bot-core/core";
import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

getLogger().info("bot khởi động");

// Chữ ký đúng: (baseUrl, apiKey, opts). Không phải một object.
export const itsaplan = new ItsaplanClient("http://10.0.0.5:3100", "itsaplan_xxx");
```

## Nguyên tắc cần biết ngay

- **Code lõi thuần.** Phần mà MCP server import (và mọi thứ trong `core`) là TypeScript thuần, ít phụ thuộc: không runtime Telegram hay OpenClaw, không module native, không đọc file để tra bảng (hãy import bảng). Nhờ đó nhị phân `bun build --compile` nhỏ và tự chứa. Logger mặc định là một lớp console không phụ thuộc; bot gắn logger có cấu trúc bằng `setLogger`. Cảnh báo admin khi tool lỗi là hook tiêm vào (`setToolFailureAlert`), không import Telegram.
- **Không có chuỗi tiếng Việt trong logic thư viện.** Câu chữ hiển thị nằm trong `CopyCatalog` do bot cung cấp ([danh sách CopyKey](/reference/copy-keys)).
- **itsaplan là nguồn sự thật**, SQLite cục bộ chỉ là cache dựng lại được (ADR-0003 của core, xem [chỉ mục ADR](/explanation/adr-index)).
- Thư viện đang ở 0.x: cho phép breaking change nhưng phải ghi vào `packages/core/CHANGELOG.md`.

## Đọc tiếp

- [Dựng bot đầu tiên](/guide/first-bot)
- [Bot kit: defineBot và createBot](/explanation/bot-kit)
- [Cách làm](/how-to/): các việc cụ thể làm được ngay hôm nay
- [Tra cứu API](/reference/api/)
