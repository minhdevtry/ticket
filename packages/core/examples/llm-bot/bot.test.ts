import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBot } from "@vuihoc/bot-core/bot";
import { FakeItsaplan, FakeLlm } from "@vuihoc/bot-core/testing";
import type { LlmApi } from "@vuihoc/bot-core/llm";
import bot from "./bot";

let itsaplan: FakeItsaplan;
let llm: FakeLlm;
beforeEach(() => {
  itsaplan = new FakeItsaplan({ agentUsername: "llmbot" });
  itsaplan.start();
  llm = new FakeLlm();
  llm.start();
});
afterEach(async () => {
  await itsaplan.stop();
  await llm.stop();
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function start(env: Record<string, string> = {}) {
  return createBot(bot, {
    env: {
      ITSAPLAN_BASE_URL: itsaplan.baseUrl,
      ITSAPLAN_AGENT_KEY: itsaplan.agentKey,
      BOT_POLL_INTERVAL_MS: "0",
      ...env,
    },
    worker: { minPollIntervalMs: 0, drainTimeoutMs: 500 },
    logger: silent,
  });
}

async function settle(runId: number, ms = 3000) {
  const deadline = Date.now() + ms;
  while (itsaplan.run(runId).status === "pending" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.each(["anthropic-messages", "openai-chat"] as LlmApi[])("llm-bot (%s)", (api) => {
  test("mention → model gọi get_issue → trả lời đúng luồng; trace và token lên itsaplan", async () => {
    const issue = itsaplan.addIssue({
      title: "Không vào được app",
      description: "Bấm đăng nhập thì quay mãi.",
    });
    const run = itsaplan.mention(issue.id, "issue này nói gì?");
    llm.script(
      {
        text: "Để mình đọc issue.",
        toolCalls: [{ name: "get_issue", args: { identifier: issue.identifier }, id: "call_1" }],
        usage: { input: 100, output: 20 },
      },
      { text: "Issue nói app đăng nhập quay mãi.", usage: { input: 180, output: 30 } },
    );

    const running = start({
      LLM_BASE_URL: llm.baseUrl(api),
      LLM_API_KEY: "proxy-injects-the-real-key",
      LLM_MODEL: "MiniMax-M3.1-Flash",
      LLM_API: api,
    });
    await running.start();
    try {
      await settle(run.id);
    } finally {
      await running.stop();
    }

    const done = itsaplan.run(run.id);
    expect(done.status).toBe("success");
    expect(done.output).toBe("Issue nói app đăng nhập quay mãi.");
    expect(done.usage).toEqual({ inputTokens: 280, outputTokens: 50 });

    // tool get_issue thực sự đọc issue (kết quả tới model ở lượt sau)
    const secondRequest = JSON.stringify(llm.requests[1]!.body.messages);
    expect(secondRequest).toContain("Bấm đăng nhập thì quay mãi.");

    const reply = itsaplan.comments.find((c) => c.actorUserId === "agent-user");
    expect(reply?.body).toContain("Issue nói app đăng nhập quay mãi.");
    expect(reply?.replyToId).toBe(itsaplan.comments[0]?.id);

    // trace AG-UI: RUN_STARTED, văn bản, gọi tool + kết quả, tổng kết, RUN_FINISHED
    const events = done.events as Array<{ type: string; toolCallName?: string; content?: string }>;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(events.find((e) => e.type === "TOOL_CALL_START")?.toolCallName).toBe("get_issue");
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")?.content).toContain(
      "Không vào được app",
    );
    expect(types.filter((t) => t === "TEXT_MESSAGE_START").length).toBeGreaterThanOrEqual(2);
  });
});

describe("llm-bot (lỗi)", () => {
  test("bot chưa cấu hình LLM: run failed với thông điệp rõ ràng", async () => {
    const issue = itsaplan.addIssue({ title: "x" });
    const run = itsaplan.mention(issue.id, "hỏi gì đó");
    const running = start();
    expect(running.llm).toBeUndefined();
    await running.start();
    try {
      await settle(run.id);
    } finally {
      await running.stop();
    }
    expect(itsaplan.run(run.id).status).toBe("failed");
    expect(itsaplan.run(run.id).error).toContain("LLM_BASE_URL");
  });

  test("LLM 503 sau khi hết lần thử lại: run KHÔNG bị đóng failed (nhả lease để giao lại)", async () => {
    const issue = itsaplan.addIssue({ title: "x" });
    const run = itsaplan.mention(issue.id, "hỏi gì đó");
    llm.respond(() => ({ status: 503 }));
    const running = start({
      LLM_BASE_URL: llm.baseUrl("anthropic-messages"),
      LLM_API_KEY: "proxy-injects-the-real-key",
      LLM_MODEL: "m",
      LLM_MAX_RETRIES: "0",
    });
    await running.start();
    try {
      await settle(run.id, 500);
    } finally {
      await running.stop();
    }
    expect(itsaplan.run(run.id).status).toBe("pending");
    expect(itsaplan.run(run.id).error).toBeNull();
    expect(llm.requests).toHaveLength(1);
  });
});
