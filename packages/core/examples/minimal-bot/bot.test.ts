import { afterEach, beforeEach, expect, test } from "bun:test";
import { createBot } from "@vuihoc/bot-core/bot";
import { FakeItsaplan } from "@vuihoc/bot-core/testing";
import bot from "./bot";

let fake: FakeItsaplan;
beforeEach(() => {
  fake = new FakeItsaplan({ agentUsername: "minimal" });
  fake.start();
});
afterEach(() => fake.stop());

test("mention → bot trả lời đúng luồng comment và đóng run success", async () => {
  const issue = fake.addIssue({ title: "Không vào được app" });
  const run = fake.mention(issue.id, "giúp mình với");

  const running = createBot(bot, {
    env: {
      ITSAPLAN_BASE_URL: fake.baseUrl,
      ITSAPLAN_AGENT_KEY: fake.agentKey,
      GREETING: "Chào bạn",
      BOT_POLL_INTERVAL_MS: "0",
    },
    worker: { minPollIntervalMs: 0, drainTimeoutMs: 500 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
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
  const reply = fake.comments.find((c) => c.actorUserId === "agent-user");
  expect(reply?.body).toContain('Chào bạn! Mình đã đọc "Không vào được app": giúp mình với');
  expect(reply?.replyToId).toBe(fake.comments[0]?.id);
});
