# Tham chiếu: external agent runs của itsaplan

Giao thức mà một **agent ngoài** (bot) dùng để nhận và xử lý việc do itsaplan giao. Tài liệu này tả giao thức theo hành vi quan sát được từ server (itsaplan v1.8) và SDK runner chính thức; client và worker trong `@vuihoc/bot-core/itsaplan` (`AgentRunsClient`, `AgentRunWorker`) cài đúng giao thức này.

Một agent là "ngoài" (`kind = external`) khi nó chạy ở máy của operator thay vì trong tiến trình của itsaplan. Server tạo run vào một hàng đợi theo agent; agent tự kéo (pull) về, không có callback.

## Xác thực

- Header `x-api-key: <API key của chính agent>`. Key định danh agent; server chỉ giao và chỉ nhận kết quả cho agent đó.
- Key của người dùng thường: `403 Only an agent key can drain an agent feed`. Agent nội bộ: `403 Internal agents run in-process`. Key sai: `401`.
- Không đưa key lên URL, issue hay log. `AgentRunsClient` không bao giờ in key.

## Điều gì tạo ra run (trigger)

Trường `trigger` của run mang một trong bảy giá trị. SDK chính thức mới khai năm giá trị đầu; schema server có đủ bảy.

| trigger | khi nào server tạo run | `issueId` | `prompt` nhận được |
|---|---|---|---|
| `mention` | comment @agent trên issue, hoặc trả lời comment của agent (không cần @ lại) | có | khung hướng dẫn trả lời + nguyên văn comment, kèm comment cha nếu là reply |
| `delegation` | issue được giao (delegate) cho agent | có | khung "issue đã được giao cho bạn" |
| `field` | agent được đặt vào một custom field kiểu member | có | khung "issue có bạn ở field X" |
| `schedule` | lịch cron (UTC) đến giờ | thường không | `Carry out the following task:` + prompt của lịch |
| `manual` | người dùng bấm chạy một lịch cron | không | như `schedule` |
| `status` | issue vào một cột mà lịch loại `status` theo dõi (chuyển tới hoặc tạo trong cột) | có | câu mô tả sự kiện + prompt của lịch + khung |
| `event` | loại do extension của instance thêm | có | tuỳ extension |

Ghi chú:

- Comment do chính một agent viết không tạo run, để các agent không tự kích hoạt nhau.
- Agent tự thực hiện thay đổi (tự gán, tự đổi cột) không tạo run cho chính nó.
- Với `schedule`/`status`, run có thể đợi `delaySec` trước khi được claim; issue rời cột trong lúc đợi thì run `status` chưa bắt đầu bị huỷ.
- Khung `prompt` do server dựng và có thể đổi theo phiên bản. `parseMentionPrompt` của `@vuihoc/bot-core/backoffice` đọc phần nhận ra được và, khi không nhận ra, coi cả prompt là nội dung comment.
- Cron tạo ở đâu: trên itsaplan, qua `POST /projects/:projectKey/agent-schedules` (và `PATCH`, `DELETE`, `POST .../:scheduleId/run` để chạy ngay, `.../runs/cancel` để huỷ run chưa bắt đầu). Bot kit milestone 1 chưa tự tạo lịch.

## Endpoint

Mọi endpoint là `POST`, base là gốc API của itsaplan.

### `POST /agent-runs/claim`

Nhận run kế tiếp của agent. Không body.

- `200 { "run": null }`: hàng đợi trống.
- `200 { "run": { id, trigger, prompt, systemPrompt, attempts, traceEvents, issueId, issueIdentifier } }`:
  - `prompt`: nhiệm vụ đã đóng khung. `systemPrompt`: chỉ dẫn về chính run (chạy tự động, dự án, người liên quan, chỉ dẫn của operator); runner đưa vào "system prompt" của công cụ nó gọi.
  - `attempts`: lần thử thứ mấy, bắt đầu từ 1.
  - `traceEvents`: server muốn nhận trace qua `/events`.
  - `issueId`/`issueIdentifier` (vd `TECH-42`): `null` nếu run không gắn issue hoặc issue đã bị xoá.
- `409`: agent có invocation URL (server tự đẩy việc tới URL đó), không cho claim. Lỗi cấu hình, thử lại vô ích.
- `401`/`403`: key không hợp lệ hoặc không phải agent ngoài. Lỗi chết.

Claim chạy trong một giao dịch `FOR UPDATE SKIP LOCKED`: hai claim cùng agent không bao giờ nhận cùng một run. Run được **thuê** (lease): `attempts` tăng 1, `nextAttemptAt` đẩy ra `now + lease`, `status` vẫn `pending`. Mỗi lần poll cũng ghi dấu "agent vừa online" (presence), nên đừng poll dày hơn một giây.

Các run của **cùng một agent trên cùng một issue** đi tuần tự, cũ trước: run sau chờ run trước xong (hoặc hết lease).

### `POST /agent-runs/:runId/heartbeat`

Gia hạn lease khi vẫn đang làm. Body tuỳ chọn `{ "attempt": <int >= 1> }`.

- `204`: đã gia hạn.
- `404 Run not found`: run không phải của agent, đã kết thúc, hoặc `attempt` không còn khớp (lease hết hạn và run đã sang lượt khác). Với client này là `lost`: **dừng việc và đừng báo kết quả**.

Bắt buộc phải gửi nếu việc có thể lâu hơn lease (mặc định 300 giây). Chu kỳ mặc định của worker: 60 giây.

### `POST /agent-runs/:runId/result`

Báo kết quả. Body:

```json
{ "attempt": 1, "status": "success" | "failed", "output": "…", "error": "…",
  "usage": { "inputTokens": 1200, "outputTokens": 80 } }
```

- `attempt` (tuỳ chọn, nên gửi): chỉ ghi nếu còn đúng lượt này. `output` bị cắt còn 10 000 ký tự, `error` còn 500. `usage` là số token của lần gọi model cuối; bỏ hoặc `null` nếu không có.
- `204`: đã ghi. Issue nhận mục "agent đã xong" (`success` hoặc `failed`) trên dòng thời gian.
- `404`: run đã kết thúc, đã huỷ, không phải của agent, hoặc sai `attempt`. Với client này là `stale`: bỏ qua an toàn.

**`failed` là kết thúc**: server không giao lại, vì chạy lại sẽ lặp lại đúng lỗi. Muốn run được thử lại, **không báo gì** và để lease hết hạn.

### `POST /agent-runs/:runId/events`

Gửi trace (tuỳ chọn) theo giao thức AG-UI để hiện trong lịch sử run của issue. Body:

```json
{ "attempt": 1, "offset": 0, "events": [ { "type": "RUN_STARTED" } ], "sessionId": "<uuid>" }
```

- `events`: 1–200 phần tử. `offset`: vị trí của phần tử đầu trong dòng sự kiện của lần thử này. `sessionId` (UUID, tuỳ chọn) gắn một lần với lần thử.
- Loại sự kiện nhận: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR {message<=2000, code?}`, `TEXT_MESSAGE_START/CONTENT/END` (delta <= 12 000 ký tự), `TOOL_CALL_START/ARGS/END`, `TOOL_CALL_RESULT` (args/result <= 32 000 ký tự).
- `200 { nextOffset, truncated }`. **Idempotent**: gửi lại lô đã nhận (`offset < nextOffset` và lô nằm gọn trong phần đã nhận) trả lại ack hiện tại.
- `404 Active run attempt not found`: lần thử không còn hoạt động (đã xong, hết lease, sai `attempt`).
- `409`: `offset` lệch so với `nextOffset` (nhảy cóc), hoặc phiên khác đã gắn vào lần thử này.
- Trần lưu: 2000 sự kiện hoặc 1 MB cho mỗi lần thử; vượt thì `truncated: true` và server bỏ phần dư, run vẫn chạy.
- Trace chỉ là phụ: `RunTrace` của bot kit tắt trace ở lỗi đầu tiên và không bao giờ làm hỏng run.

## Lease, số lần thử và lỗi

| Tham số (phía server, biến môi trường) | Mặc định |
|---|---|
| `AGENT_RUN_LEASE_SECONDS` | 300 |
| `AGENT_RUN_MAX_ATTEMPTS` | 3 |

- Run đang `pending` mà `nextAttemptAt` đã qua thì claim được lại; `attempts` tăng. Runner chết giữa chừng thì run tự quay lại sau khi lease hết.
- Khi `attempts >= maxAttempts` mà lease đã hết hạn, lần claim kế tiếp đánh run `failed` với lỗi `Runner did not report a result` và ghi lên issue.
- Chờ admission (instance có giới hạn đồng thời) không tốn lượt thử: claim trả `{ "run": null }` và run được hẹn lại.
- Khi claim bắt đầu run mà ghi dòng thời gian lỗi, run được hẹn thử lại sau backoff (30 giây nhân đôi, tối đa 30 phút) và claim trả `null`.
- `status` của run phía server: `pending` (kể cả đang chạy; `executionState` phân biệt `queued`/`running`), `success`, `failed`, `canceled`.

## Hành vi của client và worker trong bot-core

| Chủ đề | Quyết định |
|---|---|
| Timeout request | 30 giây (không lời gọi nào làm việc nặng ở server) |
| `claim` | không retry trong client; worker backoff luỹ thừa có jitter (5 s → 60 s) |
| Chữ ký client | tham số dạng object: `claim({ signal })`, `heartbeat({ runId, attempt, signal })`, `report({ runId, result, attempt })`, `appendEvents({ runId, attempt, offset, events })` |
| `heartbeat`, `result`, `events` | idempotent nên retry lỗi mạng/429/5xx, tôn trọng `Retry-After` (tối đa 60 s) |
| `attempt` | luôn gửi ở heartbeat/result/events để run đã đổi lượt không bị ghi đè |
| 401/403, 409 ở `/claim` | chỉ là lỗi chết sau `fatalAfter` lần liên tiếp (mặc định 3, có backoff giữa các lần): một lần 401 do key đang xoay hay proxy chập chờn không giết worker. Lỗi chết: worker dừng poll, `health` là `failed`, gọi `onFatal` |
| `heartbeat` → 404 | mất lease: huỷ `signal` của handler, không báo kết quả |
| Handler ném lỗi | báo `failed` với thông điệp |
| Outcome `retry` | không báo gì, nhả lease; server giao lại sau khi lease hết (tối đa số lần thử của instance). Ở lượt cuối (`maxAttempts`, mặc định 3) worker đổi thành `failed` kèm lý do thay vì để lease hết hạn trong im lặng |
| Run bị giao lại khi đang chạy | lease cũ hết hạn trong lúc heartbeat hỏng: worker huỷ handler cũ và chạy tiếp bằng lượt mới (không bỏ qua) |
| Lỗi bất ngờ trong worker (kể cả `RunLedger` đọc/ghi lỗi) | ledger hỏng thì coi như không có ledger; mọi lỗi khác bị chặn ở vỏ ngoài, tính vào `dropped`, không làm sập process |
| Báo kết quả lỗi sau mọi retry | kết quả giữ trong `RunLedger`; run được giao lại thì báo lại kết quả cũ, không chạy lại handler |
| Hạn một run | 30 phút mặc định; quá hạn thì huỷ và báo `failed` |
| `stop()` | ngừng claim, chờ run đang chạy tối đa `drainTimeoutMs` (mặc định 5 s, vừa trong hạn 10 s của `docker stop`), quá hạn thì huỷ và **không báo**, để lease hết hạn và server giao lại. Handler phớt lờ `signal` cũng chỉ giữ `stop()` thêm tối đa `abortGraceMs` (1 s) |
| Tuỳ chọn chu kỳ | worker từ chối `heartbeatIntervalMs` không dương hoặc lớn hơn nửa lease, `runTimeoutMs <= 0` |
| Concurrency | mặc định 1; server vẫn tuần tự hoá run cùng issue |
| Poll rỗng | 3 s mặc định, sàn 1 s |

Hệ quả cho người viết handler: handler phải **chạy lại được** (run có thể được giao lại sau crash hoặc khi `stop()` quá hạn). Việc ghi ra ngoài nên chống trùng theo `ctx.idempotencyKey` (`agent-run:<id>`); `ctx.reply` đã làm sẵn bằng một dấu ẩn trong comment.

## Dùng trực tiếp

```ts check
import { AgentRunsClient, AgentRunWorker } from "@vuihoc/bot-core/itsaplan";

declare const baseUrl: string;
declare const apiKey: string;

const worker = new AgentRunWorker({
  client: new AgentRunsClient({ baseUrl, apiKey }),
  concurrency: 2,
  handler: async ({ run, attempt, maxAttempts, trace }) => {
    await trace.text(`bắt đầu ${run.trigger}, lượt ${attempt}/${maxAttempts}`);
    return "xong"; // hoặc { status: "failed", error } / { status: "retry" }
  },
});
worker.start();
// ... khi tắt:
export const shutdown = () => worker.stop();
```

Cách thường dùng là qua `defineBot`/`createBot` (xem [bot kit](/explanation/bot-kit)). Test với `FakeItsaplan` của `@vuihoc/bot-core/testing`, nói đúng giao thức trên qua HTTP thật.

## So với runner ad-hoc cũ của Tiểu Linh

`apps/tieulinh/worker/agent-runner.ts` tự gọi `claim` và `result` bằng `fetch`: không heartbeat (run lâu hơn lease bị giao lại), không gửi `attempt`, không backoff khi lỗi, chỉ chạy một run một lúc, không dừng êm, và báo kết quả lỗi thì chỉ log (mất kết quả). Worker mới giải quyết cả sáu điểm; chuyển Tiểu Linh sang nó nằm ở milestone sau (xem RFC).
