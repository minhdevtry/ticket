import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { ConfigError, defineEnv } from "../core/config";
import type { IntakeLogger } from "../core/logger";
import { skip, whenColumn, setPriority, comment } from "../backoffice";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { type CreateBotOptions, createBot } from "./create";
import { type BotDefinition, BotDefinitionError, defineBot } from "./define";
import { runBot } from "./run";

const logs: string[] = [];
const logger: IntakeLogger = {
  debug: () => {},
  info: (m, ...a) => void logs.push(`${m} ${JSON.stringify(a)}`),
  warn: (m, ...a) => void logs.push(`${m} ${JSON.stringify(a)}`),
  error: (m, ...a) => void logs.push(`${m} ${JSON.stringify(a)}`),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("until: quá hạn");
    await sleep(5);
  }
}

let fake: FakeItsaplan;
const bots: { stop(): Promise<void> }[] = [];
const envFor = (extra: Record<string, string> = {}) => ({
  ITSAPLAN_BASE_URL: fake.baseUrl,
  ITSAPLAN_AGENT_KEY: fake.agentKey,
  BOT_POLL_INTERVAL_MS: "0",
  ...extra,
});
const fastWorker = {
  minPollIntervalMs: 0,
  errorBackoff: { baseMs: 5, maxMs: 10 },
  drainTimeoutMs: 500,
};

beforeEach(() => {
  logs.length = 0;
  fake = new FakeItsaplan();
  fake.start();
});
afterEach(async () => {
  await Promise.all(bots.splice(0).map((b) => b.stop()));
  await fake.stop();
});

function make(def: BotDefinition<any>, extra: CreateBotOptions) {
  const bot = createBot(def, { logger, worker: fastWorker, ...extra });
  bots.push(bot);
  return bot;
}

describe("createBot", () => {
  it("fail-fast: env thiếu → ConfigError gom lỗi, secret không lộ; khai báo sai → BotDefinitionError", () => {
    const def = defineBot({
      id: "demo",
      tracker: { project: "TECH" },
      env: defineEnv({ OTHER: z.string() }),
      backoffice: { on: { mention: async () => "x" } },
    });
    let err: unknown;
    try {
      createBot(def, { env: { ITSAPLAN_AGENT_KEY: "bí-mật-123" }, logger });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const names = (err as ConfigError).issues.map((i) => i.name).sort();
    expect(names).toEqual(["ITSAPLAN_BASE_URL", "OTHER"]);
    expect((err as Error).message).not.toContain("bí-mật-123");

    expect(() =>
      createBot({ id: "X", tracker: { project: "T" } } as any, { env: {}, logger }),
    ).toThrow(BotDefinitionError);
  });

  it("vòng đời: created → start → running → stop; start/stop lặp lại an toàn", async () => {
    const bot = make(
      defineBot({
        id: "life",
        tracker: { project: "TECH" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor() },
    );
    expect(bot.state).toBe("created");
    expect(bot.health().status).toBe("starting");
    await bot.start();
    await bot.start();
    expect(bot.state).toBe("running");
    await until(() => bot.health().components.backoffice?.worker.lastPollAt != null);
    expect(bot.health().status).toBe("ok");
    await bot.stop();
    await bot.stop();
    expect(bot.state).toBe("stopped");
    expect(bot.health().status).toBe("stopped");
    await expect(bot.start()).rejects.toThrow(/đã stopped/);
  });

  it("preflight: key sai hoặc dự án không tồn tại thì start() ném và bot ở trạng thái failed", async () => {
    const bot = make(
      defineBot({
        id: "pre",
        tracker: { project: "NOPE" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor() },
    );
    await expect(bot.start()).rejects.toThrow(/Không truy cập được dự án NOPE/);
    expect(bot.state).toBe("failed");
    expect(bot.health().status).toBe("down");
  });

  it("log không chứa secret: tiền tố bot, config đã che", async () => {
    const bot = make(
      defineBot({
        id: "logs",
        tracker: { project: "TECH" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor() },
    );
    await bot.start();
    const all = logs.join("\n");
    expect(all).toContain("[bot:logs]");
    expect(all).toContain("[REDACTED]");
    expect(all).not.toContain(fake.agentKey);
  });

  it("e2e: run mention → handler dùng ctx (comment, reply, issue) → comment trả lời và run success", async () => {
    const issue = fake.addIssue({ title: "Không đăng nhập được" });
    const seen: Record<string, unknown> = {};
    const bot = make(
      defineBot({
        id: "e2e",
        tracker: { project: "TECH" },
        env: defineEnv({ GREETING: z.string().default("Xin chào") }),
        backoffice: {
          agent: "testbot",
          on: {
            mention: async (ctx) => {
              seen.text = ctx.comment.text;
              seen.title = (await ctx.issue())?.title;
              await ctx.reply(`${ctx.config.GREETING}! Mình đã nhận: ${ctx.comment.text}`);
              return "đã trả lời";
            },
          },
        },
      }),
      { env: envFor() },
    );
    const run = fake.mention(issue.id, "kiểm tra giúp");
    await bot.start();
    await until(() => fake.run(run.id).status === "success");

    expect(seen).toEqual({ text: "kiểm tra giúp", title: "Không đăng nhập được" });
    expect(fake.run(run.id).output).toBe("đã trả lời");
    const reply = fake.comments.find((c) => c.actorUserId === "agent-user")!;
    expect(reply.body).toContain("Xin chào! Mình đã nhận: kiểm tra giúp");
    expect(reply.replyToId).toBe(fake.comments[0]!.id); // trả lời đúng luồng
    expect(reply.body).toContain("<!-- bot-kit:agent-run:");
  });

  it("run giao lại (cùng id) không ghi comment trả lời hai lần", async () => {
    const quick = new FakeItsaplan({ leaseMs: 50 });
    quick.start();
    try {
      const issue = quick.addIssue({ title: "A" });
      const run = quick.mention(issue.id, "x");
      let calls = 0;
      const bot = make(
        defineBot({
          id: "idem",
          tracker: { project: "TECH" },
          backoffice: {
            on: {
              mention: async (ctx) => {
                calls++;
                await ctx.reply("một lần thôi");
                // lần đầu: bỏ lease để server giao lại (mô phỏng crash trước khi báo)
                return calls === 1 ? { status: "retry" } : "xong";
              },
            },
          },
        }),
        {
          env: {
            ITSAPLAN_BASE_URL: quick.baseUrl,
            ITSAPLAN_AGENT_KEY: quick.agentKey,
            BOT_POLL_INTERVAL_MS: "0",
          },
        },
      );
      await bot.start();
      await until(() => quick.run(run.id).status === "success");
      expect(calls).toBe(2);
      expect(quick.comments.filter((c) => c.actorUserId === "agent-user")).toHaveLength(1);
    } finally {
      await quick.stop();
    }
  });

  it("trigger chưa có handler → đóng success (không failed), run ngoài dự án bị bỏ qua", async () => {
    const issue = fake.addIssue({ title: "A" });
    const foreign = fake.addIssue({ title: "B" });
    foreign.identifier = "OTHER-9";
    const bot = make(
      defineBot({
        id: "skip",
        tracker: { project: "TECH" },
        backoffice: { on: { mention: async () => skip("x") } },
      }),
      { env: envFor() },
    );
    const delegation = fake.enqueueRun({ trigger: "delegation", prompt: "p", issueId: issue.id });
    const other = fake.enqueueRun({ trigger: "mention", prompt: "p", issueId: foreign.id });
    await bot.start();
    await until(
      () => fake.run(delegation.id).status === "success" && fake.run(other.id).status === "success",
    );
    expect(fake.run(delegation.id).output).toContain("không có handler cho trigger delegation");
    expect(fake.run(other.id).output).toContain("không thuộc dự án TECH");
  });

  it("handler ném lỗi → run failed với thông điệp", async () => {
    const issue = fake.addIssue({ title: "A" });
    const bot = make(
      defineBot({
        id: "boom",
        tracker: { project: "TECH" },
        backoffice: {
          on: {
            mention: async () => {
              throw new Error("hỏng giữa chừng");
            },
          },
        },
      }),
      { env: envFor() },
    );
    const run = fake.mention(issue.id, "x");
    await bot.start();
    await until(() => fake.run(run.id).status === "failed");
    expect(fake.run(run.id).error).toBe("hỏng giữa chừng");
  });

  it("rules: bot.handleEvent chạy luật; /healthz và webhook server nghe trên cổng ngẫu nhiên", async () => {
    const issue = fake.addIssue({ title: "A" });
    const bot = make(
      defineBot({
        id: "rules",
        tracker: { project: "TECH" },
        backoffice: {
          rules: [whenColumn("Cần phân loại").do(comment("Đã nhận."), setPriority("high"))],
        },
      }),
      { env: envFor(), healthServer: { port: 0 }, webhook: { port: 0 } },
    );
    await bot.start();
    const addr = bot.addresses();
    expect(addr.health?.host).toBe("127.0.0.1");

    const res = await fetch(`http://127.0.0.1:${addr.health!.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.bot).toBe("rules");
    expect(body.components.backoffice.rules).toBe(1);
    expect(JSON.stringify(body)).not.toContain(fake.agentKey);
    expect((await fetch(`http://127.0.0.1:${addr.health!.port}/nope`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${addr.health!.port}/healthz`, { method: "POST" })).status,
    ).toBe(405);

    const out = await bot.handleEvent({
      action: "update",
      type: "Issue",
      event: "issue.state_changed",
      data: { id: issue.id, identifier: issue.identifier, columnId: 2 },
      createdAt: new Date().toISOString(),
      webhookTimestamp: 5,
    });
    expect(out.map((r) => r.status)).toEqual(["done"]);
    expect(fake.issues[0]!.priority).toBe("high");

    // webhook thật qua HTTP (không ký vì không cấu hình secret)
    const post = await fetch(`http://127.0.0.1:${addr.webhook!.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update",
        type: "Issue",
        event: "issue.state_changed",
        data: { id: issue.id, identifier: issue.identifier, columnId: 2 },
        createdAt: new Date().toISOString(),
        webhookTimestamp: 6,
      }),
    });
    expect(post.status).toBeLessThan(300);
    await until(() => fake.comments.filter((c) => c.body.includes("Đã nhận.")).length === 2);

    await bot.stop();
    await expect(fetch(`http://127.0.0.1:${addr.health!.port}/healthz`)).rejects.toThrow();
  });

  it("health: degraded khi claim lỗi liên tiếp, down khi key bị từ chối", async () => {
    const bot = make(
      defineBot({
        id: "deg",
        tracker: { project: "TECH" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor() },
    );
    fake.fail(/claim/, 500, 50);
    await bot.start();
    await until(() => bot.health().status === "degraded");
    expect(bot.health().reasons[0]).toContain("claim lỗi");
    await bot.stop();

    const bad = make(
      defineBot({
        id: "bad",
        tracker: { project: "TECH" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor({ ITSAPLAN_AGENT_KEY: "sai" }), preflight: false },
    );
    await bad.start();
    await until(() => bad.health().status === "down");
  });
});

describe("runBot", () => {
  it("start, chờ tín hiệu, dừng êm rồi trả về", async () => {
    const handlers = new Map<string, () => void>();
    const proc = {
      on: (sig: string, fn: () => void) => void handlers.set(sig, fn),
      off: (sig: string) => void handlers.delete(sig),
      exit: (code?: number) => {
        throw new Error(`exit ${code}`);
      },
    } as any;
    const bot = make(
      defineBot({
        id: "sig",
        tracker: { project: "TECH" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor() },
    );
    const running = runBot(bot, { proc });
    await until(() => bot.state === "running");
    handlers.get("SIGTERM")!();
    await running;
    expect(bot.state).toBe("stopped");
    expect(handlers.size).toBe(0);
  });
});
