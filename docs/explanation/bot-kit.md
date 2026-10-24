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

Biến môi trường tối thiểu cho hậu cần: `ITSAPLAN_BASE_URL`, `ITSAPLAN_AGENT_KEY` (key của **agent**, không phải key người). Tuỳ chọn: `BOT_HEALTH_PORT` (bật `/healthz`), `BOT_WEBHOOK_PORT` + `ITSAPLAN_WEBHOOK_SECRET` (nhận webhook cho `rules`), `BOT_RUN_CONCURRENCY`, `BOT_POLL_INTERVAL_MS`.

## Một run đi qua bot như thế nào

1. Ai đó comment `@minimal ...`. Itsaplan tạo một run `mention` trong hàng đợi của agent.
2. `AgentRunWorker` claim run (nhận lease), bắt đầu gửi heartbeat.
3. Dispatcher kiểm run thuộc dự án của bot, chọn `on.mention`, dựng `RunContext`, gọi handler.
4. `ctx.reply` ghi comment trả lời vào đúng luồng, gắn dấu bot và một dấu chống trùng. Nếu run bị giao lại sau crash, lần sau `reply` thấy dấu và không ghi lần hai.
5. Handler trả về; worker báo `success` (hoặc `failed` nếu ném lỗi). Run kết thúc, issue ghi "agent đã xong".

Các lựa chọn khi handler xong: trả chuỗi hoặc không trả gì là thành công; `{ status: "failed", error }` là kết thúc thất bại (server **không** thử lại); `{ status: "retry" }` nhả lease để server giao lại sau vài phút (lỗi tạm thời). Trợ giúp: `skip(lý do)`, `fail(lỗi)`, `retryLater(lý do)`.

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

`ctx.tracker` chỉ đụng được issue của `tracker.project`. Đọc issue dự án khác trả `null`; ghi ném `OutOfProjectError`. Cần gì ngoài mặt tiền thì dùng `ctx.tracker.unscopedClient`, tự chịu trách nhiệm.

## Luật

Cho phản ứng tất định với thay đổi trên ticket mà không cần LLM:

```ts check
import {
  comment,
  setPriority,
  whenColumn,
  whenCommentCreated,
} from "@vuihoc/bot-core/backoffice";

// Đưa mảng này vào `defineBot({ backoffice: { rules } })`.
export const rules = [
  whenColumn("Cần phân loại").do(comment("Đã nhận, đang phân loại."), setPriority("medium")),
  whenCommentCreated((c) => c.text.includes("gấp")).do(setPriority("high")),
];
```

Luật chạy trên webhook. Hoặc đặt `BOT_WEBHOOK_PORT` để bot tự nghe, hoặc nếu host đã có webhook server thì gọi `bot.handleEvent(envelope)`. Hiện luật chưa có hẹn giờ (`closeAfter`); xem lộ trình trong RFC.

## Cấu hình

`defineEnv` khai báo schema zod; `loadConfig` kiểm tra một lần và ném `ConfigError` liệt kê **mọi** biến sai. Giá trị secret không bao giờ xuất hiện trong lỗi hay log: dùng `secret(z.string().optional())` (bọc schema cuối cùng) hoặc đặt tên biến có `KEY`/`SECRET`/`TOKEN`/`PASSWORD`. Chuỗi rỗng coi như chưa đặt.

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
- `bot.stop()` ngừng nhận việc, chờ run đang chạy tối đa 30 giây. Quá hạn thì huỷ handler (`ctx.signal`) và **không báo kết quả**, nên handler phải chạy lại được.

## Test

`@vuihoc/bot-core/testing` có `FakeItsaplan`: một server HTTP thật nói giao thức agent-runs và phần tracker tối thiểu (project, issue, comment, timeline). Có `fake.mention(issueId, text)` để xếp một run mention, `fake.fail(/regex/, status, times)` để chèn lỗi, và `fake.run(id)` để kiểm kết quả. Xem `examples/minimal-bot/bot.test.ts`.

## Chưa có (milestone 2)

Runtime lễ tân trong `createBot`, lịch cron do bot giữ, `closeAfter` và hẹn giờ bền, đăng ký webhook tự động, host OpenClaw. `defineBot` đã nhận `receptionist` để khai báo trước; `createBot` ghi cảnh báo rằng vai này chưa chạy.
