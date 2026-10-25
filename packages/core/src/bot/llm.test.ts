import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, type defineEnv } from "../core/config";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { FakeLlm } from "../llm/fake-llm";
import { z } from "zod";
import { type Llm, createLlm, defineLlmTool, llmEnv, requireLlm, runAgentLoop } from "../llm";
import { actions, anyHumanIsReporter, whenColumn } from "../backoffice";
import { createBot } from "./create";
import { defineBot } from "./define";

let itsaplan: FakeItsaplan;
let llm: FakeLlm;
beforeEach(() => {
  itsaplan = new FakeItsaplan({ agentUsername: "bot" });
  itsaplan.start();
  llm = new FakeLlm();
  llm.start();
});
afterEach(async () => {
  await itsaplan.stop();
  await llm.stop();
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const baseEnv = () => ({
  ITSAPLAN_BASE_URL: itsaplan.baseUrl,
  ITSAPLAN_AGENT_KEY: itsaplan.agentKey,
  BOT_POLL_INTERVAL_MS: "0",
});
const LLM_ENV = () => ({
  LLM_BASE_URL: llm.baseUrl("openai-chat"),
  LLM_API_KEY: "llmkey-llmkey-llmkey-2",
  LLM_MODEL: "m",
  LLM_API: "openai-chat",
});

function defWith(handler: (ctx: any) => unknown, env?: ReturnType<typeof defineEnv<any>>) {
  return defineBot({
    id: "llm-test",
    tracker: { team: "tech", project: "TECH" },
    env,
    backoffice: { agent: "bot", on: { mention: handler as never } },
  });
}

async function runOne(def: ReturnType<typeof defWith>, env: Record<string, string>, options = {}) {
  const issue = itsaplan.addIssue({ title: "t" });
  const run = itsaplan.mention(issue.id, "hi");
  const bot = createBot(def, {
    env: { ...baseEnv(), ...env },
    worker: { minPollIntervalMs: 0, drainTimeoutMs: 300 },
    logger: silent,
    ...options,
  });
  await bot.start();
  const deadline = Date.now() + 3000;
  while (itsaplan.run(run.id).status === "pending" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await bot.stop();
  return { run: itsaplan.run(run.id), bot };
}

describe("ctx.llm", () => {
  test("có khi LLM_* đủ; handler gọi được model thật qua HTTP; không có biến LLM trong ctx.config", async () => {
    llm.script({ text: "chào từ model" });
    let seenConfig: unknown;
    const { run, bot } = await runOne(
      defWith(async (ctx) => {
        seenConfig = ctx.config;
        const res = await requireLlm(ctx).complete({ messages: [{ role: "user", content: "hi" }] });
        return res.text;
      }),
      LLM_ENV(),
    );
    expect(run.output).toBe("chào từ model");
    expect(bot.llm?.api).toBe("openai-chat");
    expect(seenConfig).toEqual({});
  });

  test("gộp llmEnv({ required }) vào env của bot: LLM_* vẫn không vào ctx.config (nhất là LLM_API_KEY)", async () => {
    llm.script({ text: "ok" });
    let seenConfig: Record<string, unknown> | undefined;
    const { run } = await runOne(
      defWith(
        (ctx) => {
          seenConfig = ctx.config;
          return "ok";
        },
        llmEnv({ required: true }),
      ),
      LLM_ENV(),
    );
    expect(run.status).toBe("success");
    expect(seenConfig).toBeDefined();
    expect(Object.keys(seenConfig ?? {}).filter((k) => k.startsWith("LLM_"))).toEqual([]);
    expect(JSON.stringify(seenConfig)).not.toContain("llmkey-llmkey-llmkey-2");
  });

  test("ctx.trace che secret của bot ở mọi đường ghi (emit, text, tool) kể cả runAgentLoop", async () => {
    const KEY = "llmkey-llmkey-llmkey-2";
    llm.script({ toolCalls: [{ name: "echo", args: { v: KEY } }] }, { text: `đã dùng ${KEY}` });
    const { run } = await runOne(
      defWith(async (ctx) => {
        await ctx.trace.text(`ghi chú ${KEY}`);
        await ctx.trace.tool("t", { k: KEY }, `kq ${KEY}`);
        await ctx.trace.emit({ type: "TEXT_MESSAGE_START", messageId: "x", role: "assistant" });
        await runAgentLoop(ctx, {
          messages: [{ role: "user", content: "hi" }],
          tools: [
            defineLlmTool({
              name: "echo",
              description: "echo",
              schema: z.object({ v: z.string() }),
              run: ({ v }) => `echo ${v}`,
            }),
          ],
        });
        return "ok";
      }),
      LLM_ENV(),
    );
    expect(run.status).toBe("success");
    const events = JSON.stringify(run.events);
    expect(run.events.length).toBeGreaterThan(5);
    expect(events).not.toContain(KEY);
    expect(events).toContain("[REDACTED]");
  });

  test("không đặt LLM_*: ctx.llm là undefined, bot vẫn chạy bình thường", async () => {
    let seen: Llm | undefined | "chưa";
    const { run, bot } = await runOne(
      defWith((ctx) => {
        seen = ctx.llm;
        return "ok";
      }),
      {},
    );
    expect(run.status).toBe("success");
    expect(seen).toBeUndefined();
    expect(bot.llm).toBeUndefined();
  });

  test("cấu hình dở dang (thiếu key): createBot ném ConfigError nêu biến thiếu, không lộ giá trị khác", () => {
    const def = defWith(() => "x");
    const err = (() => {
      try {
        createBot(def, {
          env: { ...baseEnv(), LLM_BASE_URL: llm.baseUrl("openai-chat"), LLM_MODEL: "m" },
          logger: silent,
        });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.issues.map((i) => i.name)).toEqual(["LLM_API_KEY"]);
  });

  test("llmEnv({ required: true }) trong env của bot bắt buộc có LLM, thiếu là không khởi động", () => {
    const def = defWith(() => "x", llmEnv({ required: true }));
    expect(() => createBot(def, { env: baseEnv(), logger: silent })).toThrow(ConfigError);
  });

  test("options.llm: false tắt LLM kể cả khi env đủ", async () => {
    let seen: unknown = "chưa";
    await runOne(
      defWith((ctx) => {
        seen = ctx.llm;
      }),
      LLM_ENV(),
      { llm: false },
    );
    expect(seen).toBeUndefined();
  });

  test("options.llm.client thay cho env; onUsage nhận từng lời gọi dựng từ env", async () => {
    const injected = createLlm({
      baseUrl: llm.baseUrl("openai-chat"),
      apiKey: "k",
      model: "injected",
      api: "openai-chat",
    });
    llm.script({ text: "a" }, { text: "b" });
    const ask = (ctx: any) =>
      ctx.llm.complete({ messages: [{ role: "user", content: "hi" }] }).then((r: any) => r.text);

    const first = await runOne(defWith(ask), {}, { llm: { client: injected } });
    expect(first.run.output).toBe("a");
    expect(first.bot.llm).toBe(injected);

    const usages: string[] = [];
    const second = await runOne(defWith(ask), LLM_ENV(), {
      llm: { onUsage: (e: { model: string }) => void usages.push(e.model) },
    });
    expect(second.run.output).toBe("b");
    expect(usages).toEqual(["m"]);
  });

  test("lời gọi LLM đang chạy bị huỷ khi run bị huỷ (bot tắt cưỡng bức)", async () => {
    llm.script({ delayMs: 5000, text: "quá chậm" });
    const issue = itsaplan.addIssue({ title: "t" });
    itsaplan.mention(issue.id, "hi");
    let aborted = false;
    const bot = createBot(
      defWith(async (ctx) => {
        try {
          await ctx.llm.complete({ messages: [{ role: "user", content: "hi" }] });
        } catch (err) {
          aborted = (err as Error).name === "LlmAbortError";
          throw err;
        }
      }),
      {
        env: { ...baseEnv(), ...LLM_ENV() },
        worker: { minPollIntervalMs: 0, drainTimeoutMs: 50, abortGraceMs: 500 },
        logger: silent,
      },
    );
    await bot.start();
    while (llm.requests.length === 0) await new Promise((r) => setTimeout(r, 10));
    await bot.stop();
    // worker không chờ handler sau khi huỷ; cho lời gọi LLM một nhịp để báo lỗi huỷ
    for (let i = 0; i < 100 && !aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  test("key không lọt vào log của bot khi LLM lỗi", async () => {
    const lines: string[] = [];
    const capture = {
      debug: (m: string) => lines.push(m),
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    };
    llm.respond(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: "bad key llmkey-llmkey-llmkey-2" } }),
    }));
    const { run } = await runOne(
      defWith((ctx) => ctx.llm.complete({ messages: [{ role: "user", content: "hi" }] })),
      LLM_ENV(),
      { logger: capture },
    );
    expect(run.status).toBe("failed");
    expect(run.error).not.toContain("llmkey-llmkey-llmkey-2");
    expect(lines.join("\n")).not.toContain("llmkey-llmkey-llmkey-2");
  });
});

describe("ctx.llm trong lịch cron và hẹn giờ", () => {
  class FakeClock {
    constructor(public t: number) {}
    now() {
      return this.t;
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(cond: () => boolean, ms = 4000) {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error("until: quá hạn");
      await sleep(5);
    }
  }
  const opts = (clock: FakeClock) => ({
    env: { ...baseEnv(), ...LLM_ENV(), BOT_TIMEZONE: "UTC" },
    logger: silent,
    clock,
    scheduler: { tickMs: 20 },
    worker: { minPollIntervalMs: 0, drainTimeoutMs: 50, abortGraceMs: 500 },
  });

  test("handler lịch gọi model qua ctx.llm; LLM_* không vào ctx.config", async () => {
    llm.script({ text: "tổng kết sáng nay" });
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    let out = "";
    let config: Record<string, unknown> = {};
    const bot = createBot(
      defineBot({
        id: "sched-llm",
        tracker: { team: "tech", project: "TECH" },
        env: llmEnv({ required: true }),
        backoffice: {
          schedule: {
            "0 8 * * *": async (ctx) => {
              config = ctx.config as Record<string, unknown>;
              const res = await requireLlm(ctx).complete({
                messages: [{ role: "user", content: "tổng kết" }],
              });
              out = res.text;
            },
          },
        },
      }),
      opts(clock),
    );
    await bot.start();
    await sleep(80);
    clock.t = Date.parse("2026-10-25T08:00:05Z");
    await until(() => out !== "");
    await bot.stop();
    expect(out).toBe("tổng kết sáng nay");
    expect(Object.keys(config).filter((k) => k.startsWith("LLM_"))).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("llmkey-llmkey-llmkey-2");
  });

  test("không đặt LLM_*: ctx.llm của lịch là undefined", async () => {
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    let seen: unknown = "chưa";
    const o = opts(clock);
    o.env = { ...baseEnv(), BOT_TIMEZONE: "UTC" } as never;
    const bot = createBot(
      defineBot({
        id: "sched-nollm",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          schedule: {
            "0 8 * * *": (ctx) => {
              seen = ctx.llm;
            },
          },
        },
      }),
      o,
    );
    await bot.start();
    await sleep(80);
    clock.t = Date.parse("2026-10-25T08:00:05Z");
    await until(() => seen !== "chưa");
    await bot.stop();
    expect(seen).toBeUndefined();
  });

  test("lời gọi LLM của lịch bị huỷ khi bot tắt cưỡng bức (cùng signal với handler)", async () => {
    llm.script({ delayMs: 5000, text: "quá chậm" });
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    let aborted = false;
    const bot = createBot(
      defineBot({
        id: "sched-abort",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          schedule: {
            "0 8 * * *": async (ctx) => {
              try {
                await requireLlm(ctx).complete({ messages: [{ role: "user", content: "hi" }] });
              } catch (err) {
                aborted = (err as Error).name === "LlmAbortError";
                throw err;
              }
            },
          },
        },
      }),
      opts(clock),
    );
    await bot.start();
    await sleep(80);
    clock.t = Date.parse("2026-10-25T08:00:05Z");
    await until(() => llm.requests.length > 0);
    await bot.stop();
    await until(() => aborted);
    expect(aborted).toBe(true);
  });

  test("lỗi của handler lịch chứa LLM_API_KEY: key không lọt vào log của bot", async () => {
    const KEY = "llmkey-llmkey-llmkey-2";
    const lines: string[] = [];
    const capture = {
      debug: (m: string) => lines.push(m),
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    };
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    let ran = false;
    const bot = createBot(
      defineBot({
        id: "sched-leak",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          schedule: {
            "0 8 * * *": async () => {
              ran = true;
              throw new Error(`gọi model hỏng với key ${KEY}`);
            },
          },
        },
      }),
      { ...opts(clock), logger: capture },
    );
    await bot.start();
    await sleep(80);
    clock.t = Date.parse("2026-10-25T08:00:05Z");
    await until(() => ran);
    await sleep(60);
    await bot.stop();
    expect(lines.some((l) => l.includes("handler lỗi"))).toBe(true);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  test("hành động hẹn giờ (after) dùng ctx.llm", async () => {
    llm.script({ text: "nhắc: ticket chưa xử lý" });
    const clock = new FakeClock(Date.now());
    const issue = itsaplan.addIssue({ title: "Lỗi", columnId: 2 });
    let text = "";
    const bot = createBot(
      defineBot({
        id: "timer-llm",
        tracker: { team: "tech", project: "TECH" },
        backoffice: {
          reporter: anyHumanIsReporter,
          rules: [
            whenColumn("Cần phân loại").do(
              actions.after("2h", async (ctx) => {
                text = (
                  await requireLlm(ctx).complete({ messages: [{ role: "user", content: "nhắc" }] })
                ).text;
              }),
            ),
          ],
        },
      }),
      opts(clock),
    );
    await bot.start();
    await bot.handleEvent({
      action: "update",
      type: "Issue",
      event: "issue.state_changed",
      data: {
        id: issue.id,
        identifier: issue.identifier,
        projectId: 1,
        columnId: 2,
        state: { name: "Cần phân loại", type: "unstarted" },
      },
      actor: { type: "human", id: "staff-1" },
      createdAt: new Date().toISOString(),
      webhookTimestamp: 777,
    });
    clock.t += 3 * 3_600_000;
    await until(() => text !== "");
    await bot.stop();
    expect(text).toBe("nhắc: ticket chưa xử lý");
  });
});
