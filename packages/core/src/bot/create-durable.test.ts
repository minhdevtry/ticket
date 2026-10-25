import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WebhookPermissionError,
  actions,
  anyHumanIsReporter,
  whenColumn,
  whenResolved,
} from "../backoffice";
import type { IntakeLogger } from "../core/logger";
import type { ItsaplanWebhookEnvelope } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { type Bot, type CreateBotOptions, createBot } from "./create";
import { type BotDefinition, defineBot } from "./define";

const logs: string[] = [];
const logger: IntakeLogger = {
  debug() {},
  info: (m) => void logs.push(m),
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("until: quá hạn");
    await sleep(5);
  }
}
const HOUR = 3_600_000;

class FakeClock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
}

let fake: FakeItsaplan;
let dir: string;
const bots: Bot[] = [];
const fastWorker = {
  minPollIntervalMs: 0,
  errorBackoff: { baseMs: 5, maxMs: 10 },
  drainTimeoutMs: 500,
  fatalAfter: 2,
};
const envFor = (extra: Record<string, string> = {}) => ({
  ITSAPLAN_BASE_URL: fake.baseUrl,
  ITSAPLAN_AGENT_KEY: fake.agentKey,
  BOT_POLL_INTERVAL_MS: "0",
  ...extra,
});

beforeEach(() => {
  logs.length = 0;
  fake = new FakeItsaplan({ agentUsername: "testbot", webhookKey: "webhook-key-test" });
  fake.start();
  dir = mkdtempSync(join(tmpdir(), "bot-durable-"));
});
afterEach(async () => {
  await Promise.all(bots.splice(0).map((b) => b.stop()));
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function make(
  def: BotDefinition<any>,
  extra: Partial<CreateBotOptions> & { env?: Record<string, string> } = {},
) {
  const { env, ...rest } = extra;
  const bot = createBot(def, {
    logger,
    worker: fastWorker,
    env: env ?? envFor(),
    scheduler: { tickMs: 20 },
    ...rest,
  });
  bots.push(bot);
  return bot;
}

const stateChanged = (
  issue: { id: number; identifier: string },
  columnId: number,
  name: string,
  type: string,
  ts: number,
): ItsaplanWebhookEnvelope => ({
  action: "update",
  type: "Issue",
  event: "issue.state_changed",
  data: {
    id: issue.id,
    identifier: issue.identifier,
    projectId: 1,
    columnId,
    state: { name, type },
  },
  actor: { type: "human", id: "staff-1" },
  createdAt: new Date().toISOString(),
  webhookTimestamp: ts,
});

describe("kho bền của createBot", () => {
  it("BOT_DATA_DIR tạo <dataDir>/<id>.sqlite; mặc định in-memory không tạo file", async () => {
    const def = defineBot({
      id: "durable-a",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { on: { mention: async () => "x" } },
    });
    const durable = make(def, { env: envFor({ BOT_DATA_DIR: dir }) });
    expect(existsSync(join(dir, "durable-a.sqlite"))).toBe(true);
    expect(durable.store?.durable).toBe(true);
    await durable.start();
    expect(durable.health().components.store).toEqual({ durable: true });

    const memory = make(def, { env: envFor() });
    expect(memory.store?.durable).toBe(false);
    expect(memory.health().components.store).toEqual({ durable: false });
  });

  it("dataDir không ghi được thì createBot ném lỗi nêu đường dẫn, không hạ xuống in-memory", () => {
    const def = defineBot({
      id: "durable-bad",
      tracker: { team: "tech", project: "TECH" },
      backoffice: { on: { mention: async () => "x" } },
    });
    expect(() => make(def, { dataDir: "/proc/khong-ghi-duoc" })).toThrow(
      /Không mở được kho dữ liệu/,
    );
  });

  it("reply#n sống qua restart: run bị giao lại sau khi restart không comment lần hai và không đọc lại timeline", async () => {
    let replies = 0;
    const def = defineBot({
      id: "durable-reply",
      tracker: { team: "tech", project: "TECH" },
      backoffice: {
        agent: "testbot",
        on: {
          mention: async (ctx) => {
            replies++;
            await ctx.reply("Đã xem.");
          },
        },
      },
    });
    const issue = fake.addIssue({ title: "Lỗi" });
    const run = fake.mention(issue.id, "giúp với");
    const first = make(def, { env: envFor({ BOT_DATA_DIR: dir }) });
    await first.start();
    await until(() => fake.run(run.id).status !== "pending");
    expect(first.store?.keys("comment").has(`agent-run:${run.id}:reply#1`)).toBe(true);
    await first.stop();
    const botComments = () => fake.comments.filter((c) => c.body.includes("Đã xem."));
    expect(botComments()).toHaveLength(1);

    // Server giao lại run (như khi báo kết quả thất bại rồi lease hết hạn).
    const r = fake.run(run.id);
    r.status = "pending";
    r.leaseUntil = 0;
    r.executing = false;
    const timelineBefore = fake.count(/timeline\/items/);
    const second = make(def, { env: envFor({ BOT_DATA_DIR: dir }) });
    await second.start();
    await until(() => fake.run(run.id).status !== "pending");
    expect(replies).toBe(2); // handler chạy lại (ledger đã xoá sau khi báo thành công)...
    expect(botComments()).toHaveLength(1); // ...nhưng comment không ghi lần hai
    expect(fake.count(/timeline\/items/)).toBe(timelineBefore); // khoá bền: không phải đọc timeline
  });

  it("ledger bền: kết quả đã tính mà chưa báo được thì lượt sau báo lại, KHÔNG chạy lại handler", async () => {
    let calls = 0;
    const def = defineBot({
      id: "durable-ledger",
      tracker: { team: "tech", project: "TECH" },
      backoffice: {
        agent: "testbot",
        on: {
          mention: async () => {
            calls++;
            return "kết quả đã tính";
          },
        },
      },
    });
    const issue = fake.addIssue({ title: "Lỗi" });
    const run = fake.mention(issue.id, "hỏi");
    fake.fail(/POST \/agent-runs\/\d+\/result/, 500, 1000);
    const first = make(def, { env: envFor({ BOT_DATA_DIR: dir }) });
    await first.start();
    await until(() => first.health().components.backoffice?.worker.totals.reportErrors === 1, 8000);
    await first.stop();
    expect(calls).toBe(1);
    expect(fake.run(run.id).status).toBe("pending");

    fake.faults.length = 0;
    fake.run(run.id).leaseUntil = 0;
    const second = make(def, { env: envFor({ BOT_DATA_DIR: dir }) });
    await second.start();
    await until(() => fake.run(run.id).status === "success");
    expect(calls).toBe(1);
    expect(fake.run(run.id).output).toBe("kết quả đã tính");
  });
});

describe("backoffice.schedule", () => {
  const baseDef = (id: string, run: (ctx: any) => unknown, extra: object = {}) =>
    defineBot({
      id,
      tracker: { team: "tech", project: "TECH" },
      backoffice: {
        agent: "testbot",
        schedule: { "0 8 * * *": { run, ...extra } },
      },
    });

  it("chạy đúng mốc theo múi giờ mặc định (Asia/Ho_Chi_Minh), ngữ cảnh có tracker khoá dự án", async () => {
    const clock = new FakeClock(Date.parse("2026-10-25T00:30:00Z")); // 07:30 giờ VN
    const seen: any[] = [];
    const bot = make(
      baseDef("cron-a", async (ctx) => {
        seen.push({
          job: ctx.job,
          tz: ctx.timezone,
          at: new Date(ctx.scheduledFor).toISOString(),
          ref: String(ctx.tracker.ref),
          missed: ctx.missed,
          key: ctx.idempotencyKey,
          botId: ctx.bot.id,
          hasSignal: ctx.signal instanceof AbortSignal,
        });
      }),
      { clock, env: envFor({ BOT_DATA_DIR: dir }) },
    );
    await bot.start();
    await sleep(100);
    expect(seen).toEqual([]); // chưa tới 8 giờ
    clock.t = Date.parse("2026-10-25T01:00:05Z");
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      job: "0 8 * * *",
      tz: "Asia/Ho_Chi_Minh",
      at: "2026-10-25T01:00:00.000Z",
      ref: "tech.TECH",
      missed: false,
      botId: "cron-a",
      hasSignal: true,
    });
    expect(seen[0].key).toBe(`cron:0 8 * * *:${Date.parse("2026-10-25T01:00:00Z")}`);
    expect(bot.health().components.scheduler).toMatchObject({ running: true, jobs: 1 });
  });

  it("BOT_TIMEZONE đổi múi giờ; restart cùng kho không chạy lại mốc đã chạy", async () => {
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    const fired: number[] = [];
    const def = baseDef("cron-b", async (ctx) => void fired.push(ctx.scheduledFor));
    const env = envFor({ BOT_DATA_DIR: dir, BOT_TIMEZONE: "UTC" });
    const first = make(def, { clock, env });
    await first.start();
    await sleep(60);
    clock.t = Date.parse("2026-10-25T08:00:05Z");
    await until(() => fired.length === 1);
    expect(new Date(fired[0]).toISOString()).toBe("2026-10-25T08:00:00.000Z");
    await first.stop();

    const second = make(def, { clock, env });
    await second.start();
    await sleep(150);
    expect(fired).toHaveLength(1);
    clock.t = Date.parse("2026-10-26T08:00:05Z");
    await until(() => fired.length === 2);
  });

  it("restart sau khi lỡ mốc: skip bỏ qua, catch-up-once chạy bù một lần", async () => {
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    const skipped: any[] = [];
    const caught: any[] = [];
    const mk = (id: string, sink: any[], missed: string) =>
      baseDef(id, async (ctx) => void sink.push({ missed: ctx.missed, n: ctx.missedCount }), {
        missed,
      });
    const dirSkip = join(dir, "skip");
    const dirCatch = join(dir, "catch");
    const env = (d: string) => envFor({ BOT_DATA_DIR: d, BOT_TIMEZONE: "UTC" });
    for (const [id, d, sink, policy] of [
      ["cron-skip", dirSkip, skipped, "skip"],
      ["cron-catch", dirCatch, caught, "catch-up-once"],
    ] as const) {
      clock.t = Date.parse("2026-10-25T07:30:00Z");
      const before = make(mk(id, sink, policy), { clock, env: env(d) });
      await before.start();
      await sleep(80);
      await before.stop();
    }
    clock.t = Date.parse("2026-10-27T12:00:00Z"); // tắt hai ngày rưỡi
    for (const [id, d, sink, policy] of [
      ["cron-skip", dirSkip, skipped, "skip"],
      ["cron-catch", dirCatch, caught, "catch-up-once"],
    ] as const) {
      const after = make(mk(id, sink, policy), { clock, env: env(d) });
      await after.start();
      await sleep(150);
    }
    expect(skipped).toEqual([]);
    expect(caught).toEqual([{ missed: true, n: 3 }]);
  });

  it("hai bot cùng kho (hai process): mỗi mốc chỉ một bên chạy", async () => {
    const clock = new FakeClock(Date.parse("2026-10-25T07:30:00Z"));
    const fired: string[] = [];
    const mk = (tag: string) => baseDef("cron-shared", async () => void fired.push(tag));
    const env = envFor({ BOT_DATA_DIR: dir, BOT_TIMEZONE: "UTC" });
    const a = make(mk("A"), { clock, env });
    const b = make(mk("B"), { clock, env });
    await Promise.all([a.start(), b.start()]);
    await sleep(80);
    clock.t = Date.parse("2026-10-25T08:00:05Z");
    await until(() => fired.length >= 1);
    await sleep(200);
    expect(fired).toHaveLength(1);
  });

  it("múi giờ BOT_TIMEZONE sai: ConfigError lúc createBot", () => {
    expect(() =>
      make(
        baseDef("cron-bad-tz", () => {}),
        { env: envFor({ BOT_TIMEZONE: "Mars/Olympus" }) },
      ),
    ).toThrow(/BOT_TIMEZONE/);
  });
});

describe("closeAfter qua createBot", () => {
  const rules = () => [
    whenResolved()
      .named("auto-close")
      .do(actions.closeAfter("48h", { comment: "Tự đóng." })),
  ];
  const def = (id: string) =>
    defineBot({
      id,
      tracker: { team: "tech", project: "TECH" },
      backoffice: { agent: "testbot", rules: rules(), reporter: anyHumanIsReporter },
    });

  it("Resolved → bot hẹn → qua restart → 48h sau chuyển Done; không comment trùng", async () => {
    const clock = new FakeClock(Date.now());
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const env = envFor({ BOT_DATA_DIR: dir });
    const first = make(def("close-a"), { clock, env });
    await first.start();
    const out = await first.handleEvent(stateChanged(issue, 4, "Resolved", "completed", 9001));
    expect(out).toEqual([{ rule: "auto-close", status: "done" }]);
    expect(first.store?.listTimers({ state: "pending" })).toHaveLength(1);
    await first.stop();

    const second = make(def("close-a"), { clock, env });
    await second.start();
    expect(second.store?.listTimers({ state: "pending" })).toHaveLength(1);
    expect(second.health().components.scheduler?.pendingTimers).toBe(1);
    clock.t += 47 * HOUR;
    await sleep(120);
    expect(fake.issues[0].columnId).toBe(4);
    clock.t += 2 * HOUR;
    await until(() => fake.issues[0].columnId === 5);
    expect(fake.comments.filter((c) => c.body.includes("Tự đóng."))).toHaveLength(1);
    expect(second.store?.listTimers({ state: "done" })).toHaveLength(1);
  });

  it("mở lại trước hạn thì không đóng", async () => {
    const clock = new FakeClock(Date.now());
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const bot = make(def("close-b"), { clock });
    await bot.start();
    await bot.handleEvent(stateChanged(issue, 4, "Resolved", "completed", 9101));
    fake.issues[0].columnId = 3;
    await bot.handleEvent(stateChanged(issue, 3, "Đang xử lý", "started", 9102));
    clock.t += 72 * HOUR;
    await sleep(150);
    expect(fake.issues[0].columnId).toBe(3);
    expect(bot.store?.listTimers({ state: "cancelled" })).toHaveLength(1);
  });

  it("dedupe sự kiện luật sống qua restart (BOT_DATA_DIR)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    const mk = () =>
      defineBot({
        id: "dedupe-a",
        tracker: { team: "tech", project: "TECH" },
        backoffice: { rules: [whenColumn("Cần phân loại").do(actions.comment("Đã nhận."))] },
      });
    const env = envFor({ BOT_DATA_DIR: dir });
    const ev = stateChanged(issue, 2, "Cần phân loại", "unstarted", 9201);
    const first = make(mk(), { env });
    await first.start();
    expect(await first.handleEvent(ev)).toHaveLength(1);
    await first.stop();
    const second = make(mk(), { env });
    await second.start();
    expect(await second.handleEvent(ev)).toEqual([]);
    expect(fake.comments.filter((c) => c.body.includes("Đã nhận."))).toHaveLength(1);
  });
});

describe("sức khoẻ và vòng đời của bộ chạy lịch", () => {
  const def = (id: string) =>
    defineBot({
      id,
      tracker: { team: "tech", project: "TECH" },
      backoffice: { schedule: { "0 8 * * *": () => {} } },
    });

  it("hẹn giờ đã bỏ cuộc làm health degraded kèm lý do", async () => {
    const bot = make(def("health-a"), { env: envFor({ BOT_TIMEZONE: "UTC" }) });
    await bot.start();
    expect(bot.health().status).toBe("ok");
    const store = bot.store as NonNullable<typeof bot.store>;
    store.armTimer({ key: "k", rule: "r", step: 0, dueAt: 0, issueId: 1 }, Date.now());
    store.claimTimer("k", 1, Date.now(), 1000);
    store.failTimer("k", 1, "hết số lần thử", null, Date.now());
    const h = bot.health();
    expect(h.status).toBe("degraded");
    expect(h.reasons.join(" ")).toContain("1 hẹn giờ đã bỏ cuộc");
    expect(h.components.scheduler).toMatchObject({ failedTimers: 1 });
  });

  it("start() sau stop() ném lỗi rõ ràng (phải createBot lại)", async () => {
    const bot = make(def("health-b"), { env: envFor({ BOT_TIMEZONE: "UTC" }) });
    await bot.start();
    await bot.stop();
    await expect(bot.start()).rejects.toThrow(/createBot lại/);
  });
});

describe("tự đăng ký webhook (opt-in)", () => {
  const def = () =>
    defineBot({
      id: "hook-a",
      tracker: { team: "tech", project: "TECH" },
      backoffice: {
        agent: "testbot",
        reporter: anyHumanIsReporter,
        rules: [
          whenColumn("Cần phân loại").do(actions.comment("Đã nhận.")),
          whenResolved().do(actions.closeAfter("48h")),
        ],
      },
    });
  const URL = "https://bot.example.com/webhook";

  it("mặc định KHÔNG đăng ký gì", async () => {
    const bot = make(def(), { webhook: { port: 0 }, env: envFor({ BOT_WEBHOOK_URL: URL }) });
    await bot.start();
    expect(fake.webhooks).toEqual([]);
    expect(fake.count(/webhooks/)).toBe(0);
  });

  it("bật cờ nhưng key agent không có quyền: start() ném lỗi rõ ràng, bot failed", async () => {
    const bot = make(def(), {
      webhook: { port: 0 },
      env: envFor({ BOT_WEBHOOK_AUTO_REGISTER: "true", BOT_WEBHOOK_URL: URL }),
    });
    const err = await bot.start().catch((e) => e);
    expect(err).toBeInstanceOf(WebhookPermissionError);
    expect(String(err.message)).toContain("ITSAPLAN_WEBHOOK_KEY");
    expect(String(err.message)).toContain("tech.TECH");
    expect(bot.state).toBe("failed");
    expect(fake.webhooks).toEqual([]);
  });

  it("có ITSAPLAN_WEBHOOK_KEY: tạo webhook đủ sự kiện của luật, chỉ trên dự án của bot", async () => {
    const bot = make(def(), {
      webhook: { port: 0 },
      env: envFor({
        BOT_WEBHOOK_AUTO_REGISTER: "true",
        BOT_WEBHOOK_URL: URL,
        ITSAPLAN_WEBHOOK_KEY: "webhook-key-test",
      }),
    });
    await bot.start();
    expect(fake.webhooks).toHaveLength(1);
    expect(fake.webhooks[0]).toMatchObject({ url: URL, isActive: true, projectId: 1 });
    expect(fake.webhooks[0].events.sort()).toEqual([
      "comment.created",
      "issue.created",
      "issue.deleted",
      "issue.state_changed",
    ]);
    const hookPaths = fake.requests.map((r) => r.path).filter((p) => p.includes("webhooks"));
    expect(hookPaths.every((p) => p === "/projects/tech.TECH/webhooks")).toBe(true);
    expect(bot.health().components.webhook?.autoRegistered).toBe(true);
    // key webhook chỉ dùng cho việc đăng ký, không dùng cho claim/tracker
    const webhookKeyPaths = fake.requests
      .filter((r) => r.apiKey === "webhook-key-test")
      .map((r) => r.path);
    expect(webhookKeyPaths.every((p) => p.includes("webhooks"))).toBe(true);
    expect(logs.some((l) => l.includes("ITSAPLAN_WEBHOOK_SECRET"))).toBe(true);
  });

  it("khởi động lại: bổ sung sự kiện thiếu, giữ sự kiện sẵn có, không đụng webhook URL khác", async () => {
    fake.webhooks.push(
      {
        id: 90,
        projectId: 1,
        url: URL,
        secret: "whsec_x",
        events: ["comment.updated"],
        isActive: true,
        createdAt: "",
      },
      {
        id: 91,
        projectId: 1,
        url: "https://khac.example.com/hook",
        secret: "whsec_y",
        events: ["issue.created"],
        isActive: true,
        createdAt: "",
      },
    );
    const bot = make(def(), {
      webhook: { port: 0 },
      env: envFor({
        BOT_WEBHOOK_AUTO_REGISTER: "true",
        BOT_WEBHOOK_URL: URL,
        ITSAPLAN_WEBHOOK_KEY: "webhook-key-test",
        ITSAPLAN_WEBHOOK_SECRET: "whsec_sample_secret",
      }),
    });
    await bot.start();
    expect(fake.webhooks).toHaveLength(2);
    expect(fake.webhooks[0]).toMatchObject({ id: 90, isActive: true });
    expect(fake.webhooks[0].events.sort()).toEqual([
      "comment.created",
      "comment.updated", // có sẵn trên webhook: được giữ
      "issue.created",
      "issue.deleted",
      "issue.state_changed",
    ]);
    expect(fake.webhooks[1]).toMatchObject({ id: 91, events: ["issue.created"], isActive: true });
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(false);
    // secret có sẵn của webhook khác secret bot được cấu hình: cảnh báo (không in giá trị secret)
    expect(logs.some((l) => l.includes("KHÁC ITSAPLAN_WEBHOOK_SECRET"))).toBe(true);
    expect(logs.join("\n")).not.toContain("whsec_x");
  });

  it("webhook đã bị người khác TẮT: bot không bật lại, không sửa, báo cáo qua log và health", async () => {
    fake.webhooks.push({
      id: 90,
      projectId: 1,
      url: URL,
      secret: "whsec_x",
      events: ["comment.updated"],
      isActive: false,
      createdAt: "",
    });
    const bot = make(def(), {
      webhook: { port: 0 },
      env: envFor({
        BOT_WEBHOOK_AUTO_REGISTER: "true",
        BOT_WEBHOOK_URL: URL,
        ITSAPLAN_WEBHOOK_KEY: "webhook-key-test",
      }),
    });
    await bot.start();
    expect(fake.webhooks).toHaveLength(1);
    expect(fake.webhooks[0]).toMatchObject({ isActive: false, events: ["comment.updated"] });
    expect(fake.requests.some((r) => r.method === "PATCH" || r.method === "DELETE")).toBe(false);
    expect(logs.some((l) => l.includes("đang bị TẮT"))).toBe(true);
    const h = bot.health();
    expect(h.components.webhook).toMatchObject({ autoRegistered: false, disabledWebhookId: 90 });
    expect(h.status).toBe("degraded");
    expect(h.reasons.join(" ")).toContain("webhook #90 đang bị tắt");
  });

  it("gửi ITSAPLAN_WEBHOOK_SECRET khi tạo nếu API nhận; API từ chối trường lạ thì tạo lại không có nó", async () => {
    const env = {
      BOT_WEBHOOK_AUTO_REGISTER: "true",
      BOT_WEBHOOK_URL: URL,
      ITSAPLAN_WEBHOOK_KEY: "webhook-key-test",
      ITSAPLAN_WEBHOOK_SECRET: "whsec_mine_mine_mine",
    };
    // accept: secret của bot được dùng làm secret của webhook, không có cảnh báo lệch
    await fake.stop();
    fake = new FakeItsaplan({
      agentUsername: "testbot",
      webhookKey: "webhook-key-test",
      webhookSecretMode: "accept",
    });
    fake.start();
    const a = make(def(), { webhook: { port: 0 }, env: envFor(env) });
    await a.start();
    expect(fake.webhooks[0].secret).toBe("whsec_mine_mine_mine");
    expect(logs.some((l) => l.includes("KHÁC ITSAPLAN_WEBHOOK_SECRET"))).toBe(false);
    await a.stop();

    // reject: server từ chối trường `secret` -> tạo lại không có, và cảnh báo lệch secret
    await fake.stop();
    logs.length = 0;
    fake = new FakeItsaplan({
      agentUsername: "testbot",
      webhookKey: "webhook-key-test",
      webhookSecretMode: "reject",
    });
    fake.start();
    const b = make(def(), { webhook: { port: 0 }, env: envFor(env) });
    await b.start();
    expect(fake.webhooks).toHaveLength(1);
    expect(fake.webhooks[0].secret).not.toBe("whsec_mine_mine_mine");
    expect(logs.some((l) => l.includes("KHÁC ITSAPLAN_WEBHOOK_SECRET"))).toBe(true);
    expect(logs.join("\n")).not.toContain("whsec_mine_mine_mine");
  });

  it("cấu hình sai bị chặn ngay ở createBot", () => {
    expect(() => make(def(), { env: envFor({ BOT_WEBHOOK_AUTO_REGISTER: "true" }) })).toThrow(
      /BOT_WEBHOOK_URL/,
    );
    expect(() =>
      make(
        defineBot({
          id: "hook-norules",
          tracker: { team: "tech", project: "TECH" },
          backoffice: { on: { mention: () => "x" } },
        }),
        { env: envFor({ BOT_WEBHOOK_AUTO_REGISTER: "true", BOT_WEBHOOK_URL: URL }) },
      ),
    ).toThrow(/backoffice\.rules/);
    // closeAfter mà không khai reporter: lỗi khai báo rõ ràng
    expect(() =>
      defineBot({
        id: "no-reporter",
        tracker: { team: "tech", project: "TECH" },
        backoffice: { rules: [whenResolved().do(actions.closeAfter("48h"))] },
      }),
    ).toThrow(/backoffice\.reporter/);
    expect(() =>
      make(def(), {
        webhook: false,
        env: envFor({ BOT_WEBHOOK_AUTO_REGISTER: "true", BOT_WEBHOOK_URL: URL }),
      }),
    ).toThrow(/webhook: false/);
  });
});
