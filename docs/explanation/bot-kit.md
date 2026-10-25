# Bot kit: một khai báo, hai vai

Trang này giải thích cách nghĩ về bot kit và cách dùng nó. Thiết kế đầy đủ và các câu hỏi mở: [RFC 0001](/rfc/0001-bot-kit). Giao thức hàng đợi bên dưới: [agent-runs](/reference/agent-runs).

## Ý tưởng

Một bot VuiHoc làm hai việc khác bản chất:

- **Lễ tân** nói chuyện với người báo, hỏi cho đủ thông tin, xác nhận rồi tạo ticket.
- **Hậu cần** làm việc trên ticket đã tồn tại: ai đó @bot trong comment, ticket được giao cho bot, ticket đổi cột, tới giờ chạy.

Bot kit gom cả hai vào một khai báo và một vòng đời, để người viết bot chỉ viết phần nghiệp vụ (handler, luật) còn phần ống nước (poll, heartbeat, backoff, dừng êm, health, đọc env) dùng chung.

## Bắt đầu nhanh

```ts check
// bot.ts
import { defineEnv } from "@vuihoc/bot-core/core";
import { defineBot } from "@vuihoc/bot-core/bot";
import { z } from "zod";

export default defineBot({
  id: "minimal-bot",
  tracker: { team: "tech", project: "TECH" },
  env: defineEnv({ GREETING: z.string().default("Xin chào") }),
  backoffice: {
    agent: "minimal",
    on: {
      mention: async (ctx) => {
        await ctx.reply(`${ctx.config.GREETING}! Bạn hỏi: ${ctx.comment.text}`);
        return "đã trả lời";
      },
    },
  },
});
```

```ts check
// main.ts
import { type BotDefinition, createBot, runBot } from "@vuihoc/bot-core/bot";

// Trong bot thật: `import bot from "./bot";`
declare const bot: BotDefinition;

await runBot(createBot(bot, { env: process.env, envFile: ".env" }));
```

Ví dụ chạy được và có test: `packages/core/examples/minimal-bot/`.

Biến môi trường tối thiểu cho hậu cần: `ITSAPLAN_BASE_URL`, `ITSAPLAN_AGENT_KEY` (key của **agent**, không phải key người). Tuỳ chọn: `BOT_HEALTH_PORT` (bật `/healthz`), `BOT_WEBHOOK_PORT` + `ITSAPLAN_WEBHOOK_SECRET` (nhận webhook cho `rules`), `BOT_RUN_CONCURRENCY`, `BOT_POLL_INTERVAL_MS`, `BOT_DRAIN_TIMEOUT_MS` (xem "Sức khoẻ và dừng êm").

Webhook nghe ở địa chỉ ngoài loopback (`BOT_WEBHOOK_HOST` khác `127.0.0.1`) mà không có `ITSAPLAN_WEBHOOK_SECRET` thì `start()` từ chối chạy: không chữ ký nghĩa là ai trong mạng cũng giả được webhook.

**Bun tự nạp `.env`.** Bun đọc `.env` của thư mục hiện tại vào `process.env` trước khi code chạy, nên `env: process.env` không còn "tường minh" như mong muốn và biến trong file có thể che cấu hình khác. `createBot` ghi cảnh báo khi thấy `.env` cạnh nơi chạy. Chạy `bun --no-env-file run main.ts` nếu muốn chỉ đọc file qua `envFile`.

## Một run đi qua bot như thế nào

1. Ai đó comment `@minimal ...`. Itsaplan tạo một run `mention` trong hàng đợi của agent.
2. `AgentRunWorker` claim run (nhận lease), bắt đầu gửi heartbeat.
3. Dispatcher kiểm issue của run thuộc dự án của bot (theo `projectId`, không theo tiền tố mã), chọn `on.mention`, dựng `RunContext`, gọi handler.
4. `ctx.reply` ghi comment trả lời vào đúng luồng, gắn dấu bot và một dấu chống trùng theo số thứ tự lần gọi trong run (`reply#1`, `reply#2`…). Nếu run bị giao lại sau crash, mỗi `reply` đã ghi thấy dấu và không ghi lần hai. Kiểm-rồi-ghi này không nguyên tử: hai lượt chạy đồng thời của cùng một run có thể cùng ghi (bot huỷ lượt cũ khi bị giao lại và tracker của run từ chối ghi sau khi `ctx.signal` huỷ để giảm khả năng này).
5. Handler trả về; worker báo `success` (hoặc `failed` nếu ném lỗi). Run kết thúc, issue ghi "agent đã xong".

Các lựa chọn khi handler xong: trả chuỗi hoặc không trả gì là thành công; `{ status: "failed", error }` là kết thúc thất bại (server **không** thử lại); `{ status: "retry" }` nhả lease để server giao lại sau vài phút (lỗi tạm thời). Trợ giúp: `skip(lý do)`, `fail(lỗi)`, `retryLater(lý do)`.

Lỗi tạm thời được xử lý hộ: itsaplan trả 5xx/429, lỗi mạng hay hết giờ (xem `isTransientError`) bị ném ra khỏi handler thì dispatcher đổi thành `retry`, không để run chết `failed` chỉ vì itsaplan chập chờn. Lệnh đọc của `ctx.tracker` còn tự thử lại vài lần; lệnh ghi không bao giờ tự thử lại (có thể ghi trùng). Biết lượt thử qua `ctx.attempt` và `ctx.maxAttempts`; ở lượt cuối, `retry` thành `failed` kèm lý do thay vì để lease hết hạn trong im lặng. Lỗi thường (bug trong handler) vẫn là `failed` ngay.

`ctx.comment` chỉ có ở trigger `mention` (handler `on.mention` nhận kiểu không-null). Trigger khác đọc `ctx.prompt`.

## Tracker khoá theo dự án

Mọi dự án nằm trong một team, nên `tracker` luôn khai cả `team` (slug, vd `tech`) lẫn `project` (mã in hoa, vd `TECH2`). Bot gọi itsaplan bằng ref đủ `<team>.<KEY>` (`ctx.tracker.ref`, vd `tech.TECH2`) vì khoá trần dễ trùng giữa các team. `defineBot` ném lỗi nếu thiếu team hoặc sai định dạng, và gom mọi chỗ sai vào một lần:

```ts run
import { strict as assert } from "node:assert";
import { BotDefinitionError, defineBot } from "@vuihoc/bot-core/bot";

try {
  // @ts-expect-error cố ý thiếu `team` để xem lỗi
  defineBot({ id: "demo", tracker: { project: "tech2" }, backoffice: { on: { mention: () => "ok" } } });
  assert.fail("lẽ ra phải ném BotDefinitionError");
} catch (err) {
  assert.ok(err instanceof BotDefinitionError);
  const paths = err.issues.map((i) => i.path);
  assert.deepEqual(paths, ["tracker.team", "tracker.project"]);
}
```

`ctx.tracker` chỉ đụng được issue của `tracker.project`, xác định bằng `projectId` do itsaplan trả (preflight lúc `start()`), không bằng tiền tố mã issue: mã chỉ duy nhất trong team và đổi khi issue chuyển dự án. Đọc issue dự án khác trả `null`; ghi ném `OutOfProjectError`. Chỉ 404 nghĩa là "không có"; lỗi tạm thời nổi lên thay vì bị đọc nhầm thành "ngoài dự án". Tracker của từng run từ chối ghi (`RunAbortedError`) ngay khi run bị huỷ (mất lease, quá hạn, đang tắt). Cần gì ngoài mặt tiền thì dùng `ctx.tracker.unscopedClient`, tự chịu trách nhiệm.

## Luật

Cho phản ứng tất định với thay đổi trên ticket mà không cần LLM:

```ts check
import {
  actions,
  whenColumn,
  whenCommentCreated,
} from "@vuihoc/bot-core/backoffice";

// Đưa mảng này vào `defineBot({ backoffice: { rules } })`.
export const rules = [
  whenColumn("Cần phân loại").do(
    actions.comment("Đã nhận, đang phân loại."),
    actions.setPriority("medium"),
  ),
  whenCommentCreated((c) => c.text.includes("gấp")).do(actions.setPriority("high")),
];
```

Hành động dựng sẵn nằm trong namespace `actions` (`actions.comment`, `moveTo`, `assign`, `setPriority`) để không lẫn với `ctx.comment`. Server thật phát `issue.state_changed` khi đổi cột (payload có `columnId` và `state`, không có cột cũ) và không có `issue.column_changed`. Engine chỉ đánh dấu một webhook là "đã thấy" sau khi xử lý không lỗi, nên giao lại sau lỗi vẫn chạy; payload không có `webhookTimestamp` thì không dedupe.

Luật chạy trên webhook. Hoặc đặt `BOT_WEBHOOK_PORT` để bot tự nghe, hoặc nếu host đã có webhook server thì gọi `bot.handleEvent(envelope)`. Hiện luật chưa có hẹn giờ (`closeAfter`); xem lộ trình trong RFC.

## Cấu hình

`defineEnv` khai báo schema zod; `loadConfig` kiểm tra một lần và ném `ConfigError` liệt kê **mọi** biến sai. Giá trị secret không bao giờ xuất hiện trong lỗi hay log: dùng `secret(z.string().optional())` (bọc schema cuối cùng) hoặc đặt tên biến có `KEY`/`SECRET`/`TOKEN`/`PASSWORD`. Chuỗi rỗng coi như chưa đặt, kể cả khi che biến cùng tên trong `envFile`. Ngoài lọc theo mẫu, bot che theo **giá trị** mọi secret đã khai (key agent, secret webhook, `secret()` của bot) và mật khẩu nhúng trong URL (`postgres://user:pass@…`) trong log, `health()`, và thông báo lỗi gửi lên itsaplan; secret ngắn hơn 6 ký tự không được lọc theo giá trị.

```ts run
import { strict as assert } from "node:assert";
import { ConfigError, defineEnv, loadConfig, secret } from "@vuihoc/bot-core/core";
import { z } from "zod";

const schema = defineEnv({
  PORT: z.coerce.number().int().default(8080),
  API_TOKEN: secret(z.string().min(20)),
  MODE: z.enum(["live", "dry"]),
});

try {
  loadConfig(schema, { env: { API_TOKEN: "ngan", MODE: "sai" } });
  assert.fail("lẽ ra phải ném ConfigError");
} catch (err) {
  assert.ok(err instanceof ConfigError);
  assert.deepEqual(err.issues.map((i) => i.name).sort(), ["API_TOKEN", "MODE"]);
  assert.ok(!err.message.includes("ngan"), "giá trị secret không được lộ trong lỗi");
}
```

## Sức khoẻ và dừng êm

- `bot.health()` trả `ok`/`degraded`/`down`/`starting`/`stopped` và lý do. `GET /healthz` (khi bật) trả 200 cho `ok`/`degraded`, 503 cho còn lại.
- Key agent bị từ chối (401/403) liên tiếp 3 lần thì bot `down`; `runBot` dừng êm rồi thoát mã 1 (`exitOnFatal`, mặc định bật) để orchestrator khởi động lại và cảnh báo.
- `health()` không báo "chưa poll" khi bot đang bận hết `BOT_RUN_CONCURRENCY` (lúc đó cố ý không poll).
- `bot.stop()` ngừng nhận việc, chờ run đang chạy tối đa `BOT_DRAIN_TIMEOUT_MS` (mặc định **5 giây**). Quá hạn thì huỷ handler (`ctx.signal`) và **không báo kết quả**, nên handler phải chạy lại được; handler phớt lờ `signal` cũng không giữ bot quá thêm 1 giây. Tổng thời gian dừng tối đa là `bot.stopBudgetMs` (mặc định 7,5 giây, trong hạn 10 giây của `docker stop`), và `runBot` lấy chính số đó làm hạn thoát cưỡng bức: chỉ có một nguồn. Handler chạy lâu (gọi LLM) cần nâng `BOT_DRAIN_TIMEOUT_MS` cùng `docker stop -t` hoặc `TimeoutStopSec` của systemd.

## LLM trong handler

Khi bot đặt `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `createBot` dựng client LLM và đưa vào `ctx.llm` (không đặt thì là `undefined`). Handler dùng `runAgentLoop(ctx, ...)` để cho model gọi tool trên `ctx.tracker`; mỗi bước hiện trong lịch sử run trên itsaplan. Xem [Gọi LLM trong handler hậu cần](/how-to/call-llm) và [Tham chiếu LLM](/reference/llm).

## Test

`@vuihoc/bot-core/testing` có `FakeItsaplan`: một server HTTP thật nói giao thức agent-runs và phần tracker tối thiểu (project, issue, comment, timeline). Có `fake.mention(issueId, text)` để xếp một run mention, `fake.fail(/regex/, status, times)` để chèn lỗi, và `fake.run(id)` để kiểm kết quả. `FakeLlm` cùng gói là LLM giả nói cả hai kiểu API. Xem `examples/minimal-bot/bot.test.ts` và `examples/llm-bot/bot.test.ts`.

## Chưa có (milestone 2)

Runtime lễ tân trong `createBot`, lịch cron do bot giữ, `closeAfter` và hẹn giờ bền, đăng ký webhook tự động, host OpenClaw. `defineBot` đã nhận `receptionist` để khai báo trước; `createBot` ghi cảnh báo rằng vai này chưa chạy.
