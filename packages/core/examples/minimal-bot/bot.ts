/**
 * Bot tối thiểu: một handler cho `mention`. Ai @bot trên issue của dự án TECH thì bot
 * trả lời đúng luồng comment đó.
 *
 * Chạy thật: `ITSAPLAN_BASE_URL=... ITSAPLAN_AGENT_KEY=... bun run main.ts`.
 */
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
