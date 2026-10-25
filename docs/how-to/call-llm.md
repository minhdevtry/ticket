# Gọi LLM trong handler hậu cần

Việc cần làm: trong handler `mention` (hoặc trigger khác) của bot, cho model đọc issue bằng một tool, trả lời lên issue, và để lịch sử run trên itsaplan hiện từng bước model đã làm. Phần tra cứu (lỗi, thử lại, giới hạn trace): [Tham chiếu LLM](/reference/llm).

## 1. Cấu hình

Đặt ba biến trong môi trường của bot (hoặc `.env` đọc qua `envFile`). `createBot` tự đọc chúng:

```bash
LLM_BASE_URL=http://127.0.0.1:18999     # anthropic-messages: không có /v1; openai-chat: có /v1
LLM_API_KEY=...                         # secret; qua proxy dev thì chỉ là chuỗi giả
LLM_MODEL=MiniMax-M3.1-Flash
LLM_API=anthropic-messages              # hoặc openai-chat (mặc định anthropic-messages)
```

Không đặt biến nào thì `ctx.llm` là `undefined`; đặt thiếu thì `createBot` dừng với `ConfigError` nêu biến thiếu. Bot nào không chạy được nếu thiếu LLM thì khai thêm `llmEnv({ required: true })` vào `defineEnv` để lỗi hiện ngay lúc khởi động:

```ts check
import { defineEnv } from "@vuihoc/bot-core/core";
import { llmEnv } from "@vuihoc/bot-core/llm";
import { mergeEnv } from "@vuihoc/bot-core/core";
import { z } from "zod";

export const env = mergeEnv(defineEnv({ GREETING: z.string().default("Xin chào") }), llmEnv({ required: true }));
```

## 2. Viết handler

Một tool `get_issue` cho model, `runAgentLoop` lo phần còn lại (dùng `ctx.llm`, huỷ theo `ctx.signal`, ghi trace qua `ctx.trace`):

```ts check
import { defineBot } from "@vuihoc/bot-core/bot";
import { skip } from "@vuihoc/bot-core/backoffice";
import { defineLlmTool, runAgentLoop, toRunUsage } from "@vuihoc/bot-core/llm";
import { z } from "zod";

export default defineBot({
  id: "tro-ly",
  tracker: { team: "tech", project: "TECH" },
  backoffice: {
    agent: "trolyvh",
    on: {
      mention: async (ctx) => {
        const question = ctx.comment.text;
        if (!question) return skip("comment rỗng sau khi gỡ mention");

        const getIssue = defineLlmTool({
          name: "get_issue",
          description: "Đọc tiêu đề và mô tả của một issue trong dự án theo mã, vd TECH-1.",
          schema: z.object({ identifier: z.string() }),
          run: async ({ identifier }) => {
            const issue = await ctx.tracker.getIssue(identifier);
            return issue ? { title: issue.title, description: issue.description } : "Không thấy issue.";
          },
        });

        const result = await runAgentLoop(ctx, {
          system: "Trả lời ngắn gọn bằng tiếng Việt, chỉ dựa vào thông tin từ tool.",
          messages: [{ role: "user", content: `Issue ${ctx.run.issueIdentifier}: ${question}` }],
          tools: [getIssue],
          maxSteps: 4,
          maxTotalTokens: 20_000,
        });

        if (!result.text) return { status: "failed", error: `LLM dừng (${result.finishReason})` };
        await ctx.reply(result.text);
        return { status: "success", output: result.text, usage: toRunUsage(result.usage) };
      },
    },
  },
});
```

Điều cần biết khi viết handler:

- **Tool đọc dữ liệu qua `ctx.tracker`** (đã khoá vào dự án), không gọi itsaplan trực tiếp.
- **Chạm trần không ném.** Hết `maxSteps` hoặc `maxTotalTokens` thì `runAgentLoop` trả kết quả với `finishReason` khác `end`; handler quyết định trả lời hay đóng `failed`.
- **Lỗi LLM tạm thời cứ để bay ra.** 429/5xx/mạng đã được client thử lại; nếu vẫn lỗi, ném ra ngoài thì run được nhả lease để giao lại. Lỗi vĩnh viễn (4xx, cấu hình) thì run đóng `failed` với thông điệp không chứa key.
- **Handler phải chạy lại được.** Run có thể được giao lại sau crash. `ctx.reply` đã chống trùng theo số thứ tự lần gọi; vòng lặp tool thì gọi lại model (tốn token) nhưng không ghi trùng comment.
- **Tool không được ném lỗi chứa secret**: thông điệp lỗi của tool đi tới model.

## 3. Trích trường từ văn bản (không cần tool)

Cho việc "đọc câu của người dùng, lấy ra trường" dùng `extract` thay cho vòng lặp tool:

```ts check
import { extract, type Llm } from "@vuihoc/bot-core/llm";
import { z } from "zod";

declare const llm: Llm;

const Incident = z.object({
  title: z.string().describe("Tiêu đề ngắn"),
  severity: z.enum(["low", "high"]),
});

const { data, repaired } = await extract({
  llm,
  schema: Incident,
  instruction: "Trích tiêu đề và mức độ của sự cố.",
  input: "App không đăng nhập được từ sáng, nhiều người báo",
});
console.log(data.title, data.severity, repaired);
```

JSON bọc trong code fence hay có dấu phẩy thừa được sửa tự động; sai schema thì hỏi lại đúng một lần, hỏng nữa thì ném `LlmExtractError`.

## 4. Test bằng itsaplan giả và LLM giả

`FakeLlm` và `FakeItsaplan` (cả hai trong `@vuihoc/bot-core/testing`) chạy trên HTTP thật, không mạng, không key thật. Kịch bản: lượt 1 model gọi tool, lượt 2 trả lời; sau đó khẳng định comment, `usage` và trace của run. Mẫu đầy đủ chạy được: `packages/core/examples/llm-bot/` (`bot.ts`, `bot.test.ts`).

```ts run
import assert from "node:assert/strict";
import { createBot } from "@vuihoc/bot-core/bot";
import { FakeItsaplan, FakeLlm } from "@vuihoc/bot-core/testing";
import { defineBot } from "@vuihoc/bot-core/bot";
import { requireLlm } from "@vuihoc/bot-core/llm";

const itsaplan = new FakeItsaplan({ agentUsername: "trolyvh" });
const llm = new FakeLlm();
itsaplan.start();
llm.start();

const bot = createBot(
  defineBot({
    id: "tro-ly",
    tracker: { team: "tech", project: "TECH" },
    backoffice: {
      agent: "trolyvh",
      on: {
        mention: async (ctx) => {
          const res = await requireLlm(ctx).complete({
            messages: [{ role: "user", content: ctx.comment.text }],
          });
          return res.text;
        },
      },
    },
  }),
  {
    env: {
      ITSAPLAN_BASE_URL: itsaplan.baseUrl,
      ITSAPLAN_AGENT_KEY: itsaplan.agentKey,
      BOT_POLL_INTERVAL_MS: "0",
      LLM_BASE_URL: llm.baseUrl("anthropic-messages"),
      LLM_API_KEY: "khoa-gia",
      LLM_MODEL: "MiniMax-M3.1-Flash",
    },
    worker: { minPollIntervalMs: 0, drainTimeoutMs: 500 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  },
);

try {
  llm.script({ text: "Mình đã nhận." });
  const issue = itsaplan.addIssue({ title: "Lỗi đăng nhập" });
  const run = itsaplan.mention(issue.id, "nhờ xem giúp");
  await bot.start();
  const deadline = Date.now() + 3000;
  while (itsaplan.run(run.id).status === "pending" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(itsaplan.run(run.id).status, "success");
  assert.equal(itsaplan.run(run.id).output, "Mình đã nhận.");
} finally {
  await bot.stop();
  await itsaplan.stop();
  await llm.stop();
}
```
