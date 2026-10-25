/**
 * Bot trả lời mention bằng LLM: model đọc câu hỏi trong comment và có MỘT tool `get_issue` để
 * xem nội dung issue; câu trả lời đi lên issue đúng luồng comment, và mọi bước (tool, token)
 * hiện trong lịch sử run trên itsaplan nhờ `runAgentLoop`.
 *
 * Cấu hình LLM qua env (`createBot` tự đọc): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
 * tuỳ chọn `LLM_API` (`anthropic-messages` mặc định, hoặc `openai-chat`).
 * Chạy thật: `ITSAPLAN_BASE_URL=... ITSAPLAN_AGENT_KEY=... LLM_BASE_URL=... LLM_API_KEY=...
 * LLM_MODEL=... bun run main.ts` (test dùng itsaplan giả và LLM giả, không mạng).
 */
import { defineBot } from "@vuihoc/bot-core/bot";
import { skip } from "@vuihoc/bot-core/backoffice";
import type { RunContext } from "@vuihoc/bot-core/backoffice";
import type { MentionComment } from "@vuihoc/bot-core/backoffice";
import { defineLlmTool, requireLlm, runAgentLoop, toRunUsage } from "@vuihoc/bot-core/llm";
import { z } from "zod";

const SYSTEM = [
  "Bạn là trợ lý hậu cần của đội vận hành. Trả lời ngắn gọn bằng tiếng Việt.",
  "Chỉ dùng thông tin lấy được từ tool get_issue; không biết thì nói không biết.",
].join("\n");

/** Handler `mention`: tách ra để test và để bot khác dùng lại. */
export async function answerMention(ctx: RunContext<unknown, MentionComment>) {
  const question = ctx.comment.text;
  if (!question) return skip("comment rỗng sau khi gỡ mention");
  requireLlm(ctx); // báo lỗi rõ ràng nếu bot chưa cấu hình LLM

  const getIssue = defineLlmTool({
    name: "get_issue",
    description: "Đọc tiêu đề, mô tả, độ ưu tiên của một issue trong dự án theo mã (vd TECH-1).",
    schema: z.object({ identifier: z.string().describe("Mã issue, vd TECH-1") }),
    run: async ({ identifier }) => {
      const issue = await ctx.tracker.getIssue(identifier);
      if (!issue) return `Không thấy issue ${identifier} trong dự án này.`;
      return {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
      };
    },
  });

  const result = await runAgentLoop(ctx, {
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Issue hiện tại: ${ctx.run.issueIdentifier ?? "(không có)"}\nCâu hỏi: ${question}`,
      },
    ],
    tools: [getIssue],
    maxSteps: 4,
    maxTotalTokens: 20_000,
  });

  if (!result.text)
    return {
      status: "failed" as const,
      error: `LLM dừng (${result.finishReason}) mà chưa trả lời`,
    };
  await ctx.reply(result.text);
  return { status: "success" as const, output: result.text, usage: toRunUsage(result.usage) };
}

export default defineBot({
  id: "llm-bot",
  tracker: { team: "tech", project: "TECH" },
  backoffice: {
    agent: "llmbot",
    on: { mention: answerMention },
  },
});
