# Chuyển project vào team

Bản itsaplan mới định tuyến theo team: link web của ticket có dạng `/<teamRef>/issue/<KEY>-<n>` thay vì `/project/<KEY>/issue/<n>`. Khi một project được chuyển sang team khác, những gì phía bot bị ảnh hưởng đều quanh `teamRef`. Trang này ghi những gì code bảo đảm; các bước thao tác trên itsaplan thì chưa được xác minh.

## Bot lấy `teamRef` thế nào

`projectTeamRef` lấy `teamRef` từ kết quả `getProject()` theo thứ tự: trường `teamRef`, phần trước dấu chấm của `ref`, `teamSlug`, rồi `teamId`. `resolveProjectTeamRef(client, projectKey)` gọi `getProject` và **nhớ kết quả theo từng client** (kể cả khi không có). `issueWebUrl` dùng nó để dựng link:

```ts run
import assert from "node:assert/strict";
import { issueWebUrl } from "@vuihoc/bot-core/itsaplan";

const web = "https://itsaplan.example.com";

// Có teamRef: link theo team.
assert.equal(
  issueWebUrl(web, "OP", "OP-7", undefined, "ops-team"),
  "https://itsaplan.example.com/ops-team/issue/OP-7",
);

// Không lấy được teamRef (API cũ hoặc gọi lỗi): giữ đường dẫn cũ.
assert.equal(issueWebUrl(web, "OP", "OP-7"), "https://itsaplan.example.com/project/OP/issue/7");
```

## Sau khi chuyển project, cần làm gì ở bot

1. **Khởi động lại mọi tiến trình dài hạn** dùng project đó (worker, MCP server). `teamRef` được nhớ theo client cho tới khi tiến trình chết, nên tiến trình không khởi động lại sẽ tiếp tục dựng link với team cũ.
2. **Kiểm link thật.** Mở một thông báo mới nhất từ bot và bấm link ticket. Nếu bot dựng link dạng `/project/<KEY>/issue/<n>`, nghĩa là `getProject` không trả `teamRef` (phiên bản itsaplan cũ hoặc lỗi gọi) và bot đang dùng đường dẫn dự phòng.
3. **Webhook thuộc về project**, không thuộc team: `ensureItsaplanWebhook` làm việc theo `projectKey` (liệt kê, đăng ký, bật lại webhook của project). Không có bước đăng ký lại riêng cho team, nhưng nên kiểm `GET /projects/<KEY>/webhooks` vẫn `isActive`.
4. **Ticket chuyển giữa các *project*** thì mã đổi sang mã của project mới. `findIssueByIdentifier` chỉ tra trong project được yêu cầu và so khớp `identifier` trả về, để một mã cũ (alias sau khi ticket chuyển project) không đọc hay ghi nhầm sang project khác.

## Đang viết

::: warning Đang viết
Các bước thao tác chuyển project sang team **trên itsaplan** (ai có quyền, bấm đâu, có đổi `key` hay không, tác động lên thành viên và API key) chưa được xác minh nên chưa viết ra. Chỉ phần phía bot ở trên là chắc chắn, vì lấy từ code và được CI chạy.
:::
