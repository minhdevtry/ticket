import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { ConfigError, defineEnv } from "../core/config";
import type { IntakeLogger } from "../core/logger";
import { actions, skip, whenColumn } from "../backoffice";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { type CreateBotOptions, createBot } from "./create";
import { type BotDefinition, BotDefinitionError, defineBot } from "./define";
import { runBot } from "./run";
import { createCatalog } from "../intake/gate/catalog";

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
  fatalAfter: 2,
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
      tracker: { team: "tech", project: "TECH" },
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
      createBot({ id: "X", tracker: { team: "tech", project: "T" } } as any, { env: {}, logger }),
    ).toThrow(BotDefinitionError);
  });

  it("vòng đời: created → start → running → stop; start/stop lặp lại an toàn", async () => {
    const bot = make(
      defineBot({
        id: "life",
        tracker: { team: "tech", project: "TECH" },
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
        tracker: { team: "tech", project: "NOPE" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor() },
    );
    await expect(bot.start()).rejects.toThrow(/Không truy cập được dự án tech\.NOPE/);
    expect(bot.state).toBe("failed");
    expect(bot.health().status).toBe("down");
  });

  it("log không chứa secret: tiền tố bot, config đã che", async () => {
    const bot = make(
      defineBot({
        id: "logs",
        tracker: { team: "tech", project: "TECH" },
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
        tracker: { team: "tech", project: "TECH" },
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
    // bot luôn gọi dự án bằng ref đủ team.KEY (khoá trần là mơ hồ giữa các team)
    const projectPaths = fake.requests.map((r) => r.path).filter((p) => p.startsWith("/projects/"));
    expect(projectPaths.length).toBeGreaterThan(0);
    expect(projectPaths.every((p) => /^\/projects\/tech\.TECH(\/|$)/.test(p))).toBe(true);
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
          tracker: { team: "tech", project: "TECH" },
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
    const foreign = fake.addIssue({ title: "B", projectId: 2, identifier: "OTHER-9" });
    const bot = make(
      defineBot({
        id: "skip",
        tracker: { team: "tech", project: "TECH" },
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
        tracker: { team: "tech", project: "TECH" },
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
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          rules: [
            whenColumn("Cần phân loại").do(
              actions.comment("Đã nhận."),
              actions.setPriority("high"),
            ),
          ],
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
        tracker: { team: "tech", project: "TECH" },
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
        tracker: { team: "tech", project: "TECH" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor({ ITSAPLAN_AGENT_KEY: "sai" }), preflight: false },
    );
    await bad.start();
    await until(() => bad.health().status === "down");
  });
  it("khai báo receptionist: createBot không cảnh báo declared-not-running, health không mang receptionist", async () => {
    const bot = make(
      defineBot({
        id: "recep-bot",
        tracker: { team: "tech", project: "TECH" },
        receptionist: {
          catalog: createCatalog({
            fields: {
              nhanh: {
                default: {
                  truong: { desc: { kieu: "text" } },
                },
              },
            },
          }),
        },
      }),
      { env: envFor() },
    );
    expect(logs.some((l) => l.includes("declared-not-running"))).toBe(false);
    expect(logs.some((l) => l.includes("CHƯA chạy"))).toBe(false);
    const h = bot.health();
    expect((h.components as Record<string, unknown>).receptionist).toBeUndefined();
  });
});

describe("createBot: độ bền và an toàn", () => {
  const reads = { trackerReads: { retries: 1, baseDelayMs: 1 } };
  const quickEnv = (q: FakeItsaplan) => ({
    ITSAPLAN_BASE_URL: q.baseUrl,
    ITSAPLAN_AGENT_KEY: q.agentKey,
    BOT_POLL_INTERVAL_MS: "0",
  });

  it("lỗi tạm thời của itsaplan (5xx) → run được thử lại chứ không failed ngay, rồi thành công", async () => {
    const quick = new FakeItsaplan({ leaseMs: 50 });
    quick.start();
    try {
      const issue = quick.addIssue({ title: "A" });
      const run = quick.mention(issue.id, "x");
      // lượt 1: đọc issue lỗi 503 hết số lần thử lại của tracker; lượt 2 trở lại bình thường
      quick.fail(/^GET \/issues\/\d+$/, 503, 2);
      let calls = 0;
      const bot = make(
        defineBot({
          id: "transient",
          tracker: { team: "tech", project: "TECH" },
          backoffice: {
            on: {
              mention: async (ctx) => {
                calls++;
                return `xong ở lượt ${ctx.attempt}/${ctx.maxAttempts}`;
              },
            },
          },
        }),
        { env: quickEnv(quick), ...reads },
      );
      await bot.start();
      await until(() => quick.run(run.id).status === "success", 5000);
      expect(calls).toBe(1); // handler chỉ chạy ở lượt 2: lượt 1 chết ở bước kiểm issue
      expect(quick.run(run.id).output).toBe("xong ở lượt 2/3");
      expect(quick.run(run.id).attempts).toBe(2);
    } finally {
      await quick.stop();
    }
  });

  it("lỗi tạm thời ở handler cũng được thử lại; hết lượt thì failed kèm lý do (không im lặng)", async () => {
    const quick = new FakeItsaplan({ leaseMs: 30 });
    quick.start();
    try {
      const issue = quick.addIssue({ title: "A" });
      const run = quick.mention(issue.id, "x");
      const attempts: number[] = [];
      const bot = make(
        defineBot({
          id: "exhaust",
          tracker: { team: "tech", project: "TECH" },
          backoffice: {
            on: {
              mention: async (ctx) => {
                attempts.push(ctx.attempt);
                // mô phỏng itsaplan sập khi ghi: 503 từ lệnh ghi (không được tự thử lại)
                quick.fail(/^POST \/issues\/\d+\/comments$/, 503, 1);
                await ctx.reply("không ghi được");
                return "không tới đây";
              },
            },
          },
        }),
        { env: quickEnv(quick), ...reads },
      );
      await bot.start();
      await until(() => quick.run(run.id).status === "failed", 5000);
      expect(attempts).toEqual([1, 2, 3]);
      expect(quick.run(run.id).error).toContain("Hết lượt thử (3/3)");
      expect(quick.run(run.id).error).toContain("503");
    } finally {
      await quick.stop();
    }
  });

  it("lỗi thường (bug của handler) vẫn failed ngay, không thử lại", async () => {
    const issue = fake.addIssue({ title: "A" });
    const bot = make(
      defineBot({
        id: "bug",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          on: {
            mention: async () => {
              throw new TypeError("Cannot read properties of undefined");
            },
          },
        },
      }),
      { env: envFor() },
    );
    const run = fake.mention(issue.id, "x");
    await bot.start();
    await until(() => fake.run(run.id).status === "failed");
    expect(fake.run(run.id).attempts).toBe(1);
  });

  it("ctx.comment chỉ có ở mention (null ở trigger khác, đọc ctx.prompt); ctx.bot.ref là ref đủ", async () => {
    const issue = fake.addIssue({ title: "A" });
    const seen: Record<string, unknown> = {};
    const bot = make(
      defineBot({
        id: "ctx",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          on: {
            delegation: async (ctx) => {
              seen.comment = ctx.comment;
              seen.prompt = ctx.prompt;
              seen.ref = ctx.bot.ref;
              seen.attempt = [ctx.attempt, ctx.maxAttempts];
            },
          },
        },
      }),
      { env: envFor() },
    );
    const run = fake.enqueueRun({ trigger: "delegation", prompt: "làm đi", issueId: issue.id });
    await bot.start();
    await until(() => fake.run(run.id).status === "success");
    expect(seen).toEqual({ comment: null, prompt: "làm đi", ref: "tech.TECH", attempt: [1, 3] });
  });

  it("reply: khoá mặc định theo số thứ tự lần gọi: nhiều câu trong một run đều được ghi, chạy lại không ghi trùng", async () => {
    const quick = new FakeItsaplan({ leaseMs: 50 });
    quick.start();
    try {
      const issue = quick.addIssue({ title: "A" });
      const run = quick.mention(issue.id, "x");
      let calls = 0;
      const bot = make(
        defineBot({
          id: "replies",
          tracker: { team: "tech", project: "TECH" },
          backoffice: {
            on: {
              mention: async (ctx) => {
                calls++;
                await ctx.reply("câu một");
                await ctx.reply("câu hai");
                return calls === 1 ? { status: "retry" } : "xong";
              },
            },
          },
        }),
        { env: quickEnv(quick) },
      );
      await bot.start();
      await until(() => quick.run(run.id).status === "success");
      expect(calls).toBe(2);
      const bodies = quick.comments
        .filter((c) => c.actorUserId === "agent-user")
        .map((c) => c.body);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain("câu một");
      expect(bodies[1]).toContain("câu hai");
    } finally {
      await quick.stop();
    }
  });

  it("issue cùng tiền tố mã nhưng khác dự án (projectId) bị bỏ qua, handler không chạy", async () => {
    const lookalike = fake.addIssue({ title: "Team khác", projectId: 9 });
    let called = false;
    const bot = make(
      defineBot({
        id: "scope",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          on: {
            mention: async () => {
              called = true;
            },
          },
        },
      }),
      { env: envFor() },
    );
    const run = fake.mention(lookalike.id, "x");
    await bot.start();
    await until(() => fake.run(run.id).status === "success");
    expect(called).toBe(false);
    expect(fake.run(run.id).output).toContain("không thuộc dự án tech.TECH");
  });

  it("secret không lọt vào log, health, lỗi run gửi lên itsaplan hay thông báo preflight", async () => {
    const issue = fake.addIssue({ title: "A" });
    const key = fake.agentKey; // chuỗi tuỳ ý, không khớp mẫu secret nào
    const bot = make(
      defineBot({
        id: "leak",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          on: {
            mention: async (ctx) => {
              ctx.logger.info(`đang dùng ${key}`, { key });
              throw new Error(`gọi lỗi với khoá ${key}`);
            },
          },
        },
      }),
      { env: envFor() },
    );
    const run = fake.mention(issue.id, "x");
    await bot.start();
    await until(() => fake.run(run.id).status === "failed");
    expect(fake.run(run.id).error).toContain("[REDACTED]");
    expect(fake.run(run.id).error).not.toContain(key);
    expect(logs.join("\n")).not.toContain(key);
    expect(JSON.stringify(bot.health())).not.toContain(key);

    const bad = make(
      defineBot({
        id: "leak2",
        tracker: { team: "tech", project: "NOPE" },
        backoffice: { on: { mention: async () => "x" } },
      }),
      { env: envFor(), itsaplanClient: undefined },
    );
    await expect(bad.start()).rejects.toThrow(/Không truy cập được dự án/);
  });

  it("inbound: /internal/reporter-ok, /internal/reporter-reply và /telegram-webhook (secret) tới handler của bot", async () => {
    const seen: string[] = [];
    const def = defineBot({
      id: "inb",
      tracker: { team: "tech", project: "TECH" },
      backoffice: {
        inbound: {
          reporterOk: async (ctx, req) => {
            seen.push(`ok:${req.issueId}:${req.chatId}:${req.userName}:${ctx.bot.project}`);
            return { outcome: "recorded", replyText: "đã ghi" };
          },
          reporterReply: async (ctx, req) => {
            seen.push(`reply:${req.chatId}:${req.messageId}:${req.text}:${typeof ctx.keys}`);
            return { handled: true, outcome: "recorded", replyText: "đã chuyển" };
          },
          telegramUpdate: async (_ctx, update) => {
            seen.push(`tg:${JSON.stringify(update)}`);
          },
        },
      },
    });
    const bot = make(def, {
      env: envFor({ TELEGRAM_WEBHOOK_SECRET: "tg-secret-test" }),
      webhook: { port: 0 },
    });
    await bot.start();
    const base = `http://127.0.0.1:${bot.addresses().webhook!.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    const ok = await post("/internal/reporter-ok", {
      issueId: 7,
      chatId: "-1000000000001",
      userName: "An",
    });
    expect(await ok.json()).toEqual({ outcome: "recorded", replyText: "đã ghi" });
    const reply = await post("/internal/reporter-reply", {
      chatId: "-1000000000001",
      replyToMessageId: 41,
      text: "chưa ổn",
      senderName: "An",
    });
    expect(await reply.json()).toMatchObject({ handled: true, outcome: "recorded" });

    expect((await post("/telegram-webhook", { update_id: 1 })).status).toBe(401);
    expect(
      (
        await post(
          "/telegram-webhook",
          { update_id: 2 },
          { "x-telegram-bot-api-secret-token": "tg-secret-test" },
        )
      ).status,
    ).toBe(200);
    await until(() => seen.some((x) => x.startsWith("tg:")));
    expect(seen).toEqual([
      "ok:7:-1000000000001:An:TECH",
      "reply:-1000000000001:41:chưa ổn:function",
      'tg:{"update_id":2}',
    ]);
  });

  it("inbound: nhận tin Telegram ngoài loopback mà thiếu TELEGRAM_WEBHOOK_SECRET thì từ chối khởi động", async () => {
    const def = defineBot({
      id: "inb2",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { inbound: { telegramUpdate: async () => {} } },
    });
    const bot = make(def, {
      env: envFor({ ITSAPLAN_WEBHOOK_SECRET: "whsec_test_test" }),
      webhook: { port: 0, host: "0.0.0.0" },
    });
    await expect(bot.start()).rejects.toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it("webhook nghe ngoài loopback mà không có secret thì từ chối khởi động", async () => {
    const def = defineBot({
      id: "wh",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { rules: [whenColumn("A").do(actions.setPriority("low"))] },
    });
    const open = make(def, { env: envFor(), webhook: { port: 0, host: "0.0.0.0" } });
    await expect(open.start()).rejects.toThrow(/ngoài loopback.*ITSAPLAN_WEBHOOK_SECRET/);
    expect(open.state).toBe("failed");

    const signed = make(def, {
      env: envFor({ ITSAPLAN_WEBHOOK_SECRET: "whsec_test_test" }),
      webhook: { port: 0, host: "127.0.0.1" },
    });
    await signed.start();
    expect(signed.addresses().webhook?.port).toBeGreaterThan(0);
  });

  it("health: không báo 'chưa poll' khi đang bận hết concurrency (cố ý không poll)", async () => {
    let now = Date.now();
    const clock = { now: () => now };
    const issue = fake.addIssue({ title: "A" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const bot = make(
      defineBot({
        id: "busy",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          on: {
            mention: async () => {
              started = true;
              await gate;
            },
          },
        },
      }),
      { env: envFor(), clock },
    );
    const run = fake.mention(issue.id, "x");
    await bot.start();
    await until(() => started);
    now += 10 * 60_000; // 10 phút không poll vì đang bận
    expect(bot.health().status).toBe("ok");
    expect(bot.health().reasons).toEqual([]);
    release();
    await until(() => fake.run(run.id).status === "success");
  });

  it("stopBudgetMs: mặc định nằm trong hạn 10 giây của docker stop; BOT_DRAIN_TIMEOUT_MS đổi được", () => {
    const def = defineBot({
      id: "budget",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { on: { mention: async () => "x" } },
    });
    const dflt = createBot(def, { env: envFor(), logger });
    expect(dflt.stopBudgetMs).toBeLessThanOrEqual(10_000);
    const long = createBot(def, { env: envFor({ BOT_DRAIN_TIMEOUT_MS: "60000" }), logger });
    expect(long.stopBudgetMs).toBeGreaterThan(60_000);
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
        tracker: { team: "tech", project: "TECH" },
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

  it("lỗi chết (key bị từ chối liên tiếp): dừng êm rồi thoát mã 1; exitOnFatal=false thì ném lỗi", async () => {
    const mkProc = () => {
      const codes: number[] = [];
      const proc = {
        on() {},
        off() {},
        exit: (code?: number) => void codes.push(code ?? 0),
      } as any;
      return { proc, codes };
    };
    const badBot = (id: string) =>
      make(
        defineBot({
          id,
          tracker: { team: "tech", project: "TECH" },
          backoffice: { on: { mention: async () => "x" } },
        }),
        { env: envFor({ ITSAPLAN_AGENT_KEY: "sai-key-123" }), preflight: false },
      );

    const a = mkProc();
    const bot = badBot("fatal-exit");
    await runBot(bot, { proc: a.proc });
    expect(a.codes).toEqual([1]);
    expect(bot.state).toBe("stopped");

    const b = mkProc();
    await expect(
      runBot(badBot("fatal-throw"), { proc: b.proc, exitOnFatal: false }),
    ).rejects.toThrow(/401/);
    expect(b.codes).toEqual([]);
  });
});
