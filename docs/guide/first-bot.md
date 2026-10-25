# Dựng bot đầu tiên

Bạn sẽ dựng một bot hậu cần nhỏ: ai nhắc (`@minimal`) trong một comment của dự án thì bot trả lời đúng luồng comment đó. Bot có cấu hình kiểm tra lúc khởi động, có test chạy không cần mạng, và chạy bằng một lệnh. Vai lễ tân (hỏi bổ sung, tạo ticket từ chat) chưa nằm trong `createBot`, xem [RFC 0001](/rfc/0001-bot-kit); trang này chỉ dựng vai hậu cần.

Bản hoàn chỉnh, có test, nằm ở `packages/core/examples/minimal-bot/`. Muốn hiểu vì sao kit thiết kế như vậy, đọc [Bot kit: defineBot và createBot](/explanation/bot-kit).

## Cần chuẩn bị

- Một agent đã tạo trên itsaplan, và **key của agent** (không phải key người). Username của agent (ví dụ `minimal`) là thứ người dùng gõ sau dấu `@`.
- Slug của team và mã dự án mà bot phụ trách, ví dụ team `tech`, dự án `TECH`. Bot gọi itsaplan bằng ref đủ `tech.TECH`.
- Bun, và package `@vuihoc/bot-core` (xem [Giới thiệu](/guide/)).

## 1. Khai báo bot

`defineBot` chỉ kiểm tra và đặt kiểu, không chạy gì và không đọc env. Tạo `bot.ts`:

```ts check
import { defineEnv } from "@vuihoc/bot-core/core";
import { defineBot } from "@vuihoc/bot-core/bot";
import { skip } from "@vuihoc/bot-core/backoffice";
import { z } from "zod";

export const env = defineEnv({
  GREETING: z.string().default("Xin chào"),
});

export default defineBot({
  id: "minimal-bot",
  tracker: { team: "tech", project: "TECH" },
  env,
  backoffice: {
    agent: "minimal",
    on: {
      mention: async (ctx) => {
        const question = ctx.comment.text;
        if (!question) return skip("comment rỗng sau khi gỡ mention");
        const issue = await ctx.issue();
        await ctx.reply(`${ctx.config.GREETING}! Mình đã đọc "${issue?.title}": ${question}`);
        return "đã trả lời";
      },
    },
  },
});
```

Mấy điểm cần để ý:

- `tracker` luôn có đủ `team` và `project`. Thiếu hoặc sai định dạng là `BotDefinitionError` ngay khi module được nạp.
- `ctx.config` có kiểu suy ra từ `env`: `ctx.config.GREETING` là `string`.
- `ctx.reply` ghi comment vào đúng luồng của comment gọi bot, gắn dấu bot, và **không ghi hai lần** nếu run bị giao lại sau khi bot sập giữa chừng.
- Handler trả chuỗi (hoặc không trả gì) là thành công; `skip(lý do)` đóng run mà không làm gì; ném lỗi hoặc trả `{ status: "failed", error }` là thất bại cuối cùng (server không thử lại). Lỗi tạm thời thì trả `retryLater(lý do)` (lỗi 5xx/429/mạng của itsaplan được bot đổi thành thử lại hộ bạn; ở lượt cuối run báo `failed` kèm lý do).

Khai báo sai bị bắt sớm và gom đủ một lần:

```ts run
import { strict as assert } from "node:assert";
import { BotDefinitionError, validateBotDefinition } from "@vuihoc/bot-core/bot";

const issues = validateBotDefinition({
  id: "Bot Sai",
  tracker: { team: "tech", project: "tech" },
  backoffice: { on: { mention: () => "ok" } },
});

assert.deepEqual(
  issues.map((i) => i.path),
  ["id", "tracker.project"],
);
assert.ok(new BotDefinitionError("Bot Sai", issues).message.includes("2 lỗi"));
```

## 2. Chạy bằng một lệnh

Tạo `main.ts`. `createBot` đọc env **truyền tường minh**; `.env` chỉ được đọc khi bạn đưa `envFile`. `runBot` chạy tới khi nhận tín hiệu dừng rồi dừng êm.

```ts check
import { type BotDefinition, createBot, runBot } from "@vuihoc/bot-core/bot";

// Trong bot thật: `import bot from "./bot";`
declare const bot: BotDefinition;

await runBot(createBot(bot, { env: process.env, envFile: ".env" }));
```

Biến môi trường tối thiểu: `ITSAPLAN_BASE_URL` và `ITSAPLAN_AGENT_KEY`. Biến của riêng bot (ở đây `GREETING`) khai trong `defineEnv`. Thiếu hoặc sai biến thì bot dừng với một `ConfigError` liệt kê mọi biến sai, không bao giờ in giá trị secret. Danh sách đủ các biến của kit (health, webhook, số run song song, chu kỳ poll) ở [Bot kit](/explanation/bot-kit).

```bash
ITSAPLAN_BASE_URL=https://itsaplan.example.com \
ITSAPLAN_AGENT_KEY=... \
bun run main.ts
```

Lúc khởi động bot kiểm tra kết nối bằng cách đọc cột của dự án; sai key, sai team hoặc sai mã dự án sẽ lộ ra ngay ở đây thay vì ở run đầu tiên.

## 3. Viết test không cần mạng

`@vuihoc/bot-core/testing` có `FakeItsaplan`: một server HTTP thật chạy trên cổng ngẫu nhiên, nói đúng [giao thức agent-runs](/reference/agent-runs). Test xếp một run `mention`, chạy bot, rồi kiểm kết quả:

```ts check
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type BotDefinition, createBot } from "@vuihoc/bot-core/bot";
import { FakeItsaplan } from "@vuihoc/bot-core/testing";

// Trong bot thật: `import bot from "./bot";`
declare const bot: BotDefinition;

let fake: FakeItsaplan;
beforeEach(() => {
  fake = new FakeItsaplan({ agentUsername: "minimal" });
  fake.start();
});
afterEach(() => fake.stop());

test("mention được trả lời và run đóng success", async () => {
  const issue = fake.addIssue({ title: "Không vào được app" });
  const run = fake.mention(issue.id, "giúp mình với");

  const running = createBot(bot, {
    env: {
      ITSAPLAN_BASE_URL: fake.baseUrl,
      ITSAPLAN_AGENT_KEY: fake.agentKey,
      BOT_POLL_INTERVAL_MS: "0",
    },
  });
  await running.start();
  try {
    const deadline = Date.now() + 3000;
    while (fake.run(run.id).status === "pending" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    await running.stop();
  }

  expect(fake.run(run.id).status).toBe("success");
  expect(fake.comments.at(-1)?.body).toContain("giúp mình với");
});
```

Chạy bằng `bun test`. `fake.fail(/regex/, status, times)` chèn lỗi để thử đường lỗi và thử lại; `fake.run(id)` cho thấy trạng thái, kết quả và vết của run.

## 4. Thêm luật không cần LLM

Phản ứng tất định với thay đổi trên ticket (đổi cột, comment mới) viết thành luật, chạy trên webhook của itsaplan:

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

Để luật chạy, đặt `BOT_WEBHOOK_PORT` và `ITSAPLAN_WEBHOOK_SECRET` (bot tự nghe webhook), hoặc nếu host đã có webhook server thì gọi `bot.handleEvent(envelope)`. Webhook phải được đăng ký trên itsaplan; việc đăng ký tự động từ luật nằm ở milestone 2.

## Làm gì tiếp

| Muốn | Xem |
|---|---|
| Hiểu mô hình run, lease, thử lại, dừng êm | [Bot kit](/explanation/bot-kit) và [agent-runs](/reference/agent-runs) |
| Thêm vai lễ tân (hỏi bổ sung, tạo ticket) bằng các mảnh sẵn có | [Viết catalog tiếp nhận](/how-to/write-catalog), [Thêm kênh chat](/how-to/add-channel) |
| Đưa bot lên máy chạy, đẩy secret an toàn | [Deploy và đẩy secret qua SSH](/how-to/deploy) |
| Chuyển một bot có sẵn sang thư viện | [Chuyển bot sang bot-core](/how-to/adopt-core) |
| Biết cái gì chưa có | [RFC 0001](/rfc/0001-bot-kit), mục lộ trình |
