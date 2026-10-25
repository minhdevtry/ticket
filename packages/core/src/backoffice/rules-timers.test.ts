import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntakeLogger } from "../core/logger";
import { ItsaplanClient, type ItsaplanWebhookEnvelope } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import {
  RuleEngine,
  type Rule,
  type ReporterResolver,
  actions,
  anyHumanIsReporter,
  whenResolved,
  whenColumn,
} from "./rules";
import { BotScheduler } from "./scheduler";
import { BotStore } from "./store";
import { createScopedTracker } from "./tracker";

const logs: string[] = [];
const logger: IntakeLogger = {
  debug() {},
  info: (m) => void logs.push(m),
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
};
const HOUR = 3_600_000;

class FakeClock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
}

let fake: FakeItsaplan;
let clock: FakeClock;
let ts = 5000;
const dirs: string[] = [];
const closers: (() => void)[] = [];

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
  // Gần giờ thật: comment của fake mang `createdAt` giờ thật nên phải sau `armedAt`.
  clock = new FakeClock(Date.now() - 1000);
});
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await fake.stop();
  logs.length = 0;
});

function build(
  rules: Rule<any>[],
  opts: { path?: string; reporter?: ReporterResolver; durableSeen?: boolean } = {},
) {
  const store = opts.path ? BotStore.open(opts.path) : BotStore.memory();
  const tracker = createScopedTracker(
    new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
    { team: "tech", project: "TECH" },
    { readRetries: 0, clock },
  );
  const engine = new RuleEngine({
    rules,
    tracker,
    config: {},
    logger,
    clock,
    store,
    reporter: opts.reporter ?? anyHumanIsReporter,
    seen: opts.durableSeen ? store.keys("rule-seen") : undefined,
  });
  const scheduler = new BotScheduler({
    store,
    clock,
    logger,
    timers: { fire: (row, signal) => engine.fireTimer(row, signal) },
    timerBackoffMs: 1000,
  });
  closers.push(() => store.close());
  return { store, engine, scheduler };
}

const dbPath = () => {
  const d = mkdtempSync(join(tmpdir(), "rules-timers-"));
  dirs.push(d);
  return join(d, "bot.sqlite");
};

const stateChanged = (
  issue: { id: number; identifier: string },
  columnId: number,
  state: { name: string; type: string },
  actor: ItsaplanWebhookEnvelope["actor"] = { type: "human", id: "staff-1" },
): ItsaplanWebhookEnvelope => ({
  action: "update",
  type: "Issue",
  event: "issue.state_changed",
  data: { id: issue.id, identifier: issue.identifier, projectId: 1, columnId, state },
  actor,
  createdAt: new Date().toISOString(),
  webhookTimestamp: ++ts,
});
const resolved = (issue: { id: number; identifier: string }) =>
  stateChanged(issue, 4, { name: "Resolved", type: "completed" });
const reopened = (issue: { id: number; identifier: string }) =>
  stateChanged(issue, 3, { name: "Đang xử lý", type: "started" });
const commentCreated = (
  issue: { id: number; identifier: string },
  actorId: string,
): ItsaplanWebhookEnvelope => ({
  action: "create",
  type: "Comment",
  event: "comment.created",
  data: {
    id: ++ts,
    issueId: issue.id,
    body: "em vẫn bị lỗi",
    issue: { identifier: issue.identifier },
  },
  actor: { type: "human", id: actorId },
  createdAt: new Date().toISOString(),
  webhookTimestamp: ++ts,
});

const closeRule = (extra: Parameters<typeof actions.closeAfter>[1] = {}) =>
  whenResolved().named("auto-close").do(actions.closeAfter("48h", extra));
const keyOf = (issue: { id: number }) => `auto-close#0:${issue.id}`;

async function advance(scheduler: BotScheduler, ms: number) {
  clock.t += ms;
  await scheduler.tick();
  await scheduler.idle();
}

describe("closeAfter", () => {
  it("Resolved → hẹn 48h → tới hạn thì comment và chuyển sang Done", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([
      closeRule({ comment: "Tự đóng vì không ai phản hồi." }),
    ]);
    const out = await engine.handle(resolved(issue));
    expect(out).toEqual([{ rule: "auto-close", status: "done" }]);
    const timer = store.getTimer(keyOf(issue));
    expect(timer).toMatchObject({
      state: "pending",
      dueAt: clock.t + 48 * HOUR,
      issueId: issue.id,
    });
    expect(timer?.cancelOn).toEqual(["reporter-comment", "state-change"]);

    await advance(scheduler, 47 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    await advance(scheduler, 2 * HOUR);
    expect(fake.issues[0].columnId).toBe(5);
    expect(fake.comments.at(-1)?.body).toContain("Tự đóng vì không ai phản hồi.");
    expect(store.getTimer(keyOf(issue))?.state).toBe("done");
    await advance(scheduler, 10 * HOUR);
    expect(fake.comments.filter((c) => c.body.includes("Tự đóng"))).toHaveLength(1);
  });

  it("mở lại (đổi cột) trước hạn thì huỷ hẹn", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    fake.issues[0].columnId = 3;
    await engine.handle(reopened(issue));
    expect(store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("đổi cột");
    await advance(scheduler, 72 * HOUR);
    expect(fake.issues[0].columnId).toBe(3);
  });

  it("Resolved lần nữa sau khi mở lại: hẹn mới, hạn tính lại", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    await engine.handle(reopened(issue));
    await advance(scheduler, 30 * HOUR);
    fake.issues[0].columnId = 4;
    await engine.handle(resolved(issue));
    const t = store.getTimer(keyOf(issue));
    expect(t).toMatchObject({ state: "pending", gen: 2, dueAt: clock.t + 48 * HOUR });
    await advance(scheduler, 47 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    await advance(scheduler, 2 * HOUR);
    expect(fake.issues[0].columnId).toBe(5);
  });

  it("webhook giao lại cùng sự kiện không dời hạn hẹn đang chờ", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, store } = build([closeRule()]);
    const env = resolved(issue);
    await engine.handle(env);
    const due = store.getTimer(keyOf(issue))?.dueAt;
    clock.t += HOUR;
    await engine.handle(env);
    expect(store.getTimer(keyOf(issue))?.dueAt).toBe(due);
  });

  it("comment của người báo huỷ hẹn; comment của nhân viên thì không (reporter tuỳ biến)", async () => {
    const reporter: ReporterResolver = ({ actorId }) => actorId === "reporter-1";
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, store } = build([closeRule()], { reporter });
    await engine.handle(resolved(issue));
    await engine.handle(commentCreated(issue, "staff-1"));
    expect(store.getTimer(keyOf(issue))?.state).toBe("pending");
    await engine.handle(commentCreated(issue, "reporter-1"));
    expect(store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("người báo");
  });

  it("anyHumanIsReporter: MỌI comment của người đều huỷ hẹn (an toàn)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    await engine.handle(commentCreated(issue, "ai-do"));
    expect(store.getTimer(keyOf(issue))?.state).toBe("cancelled");
  });

  it("comment của bot/agent không huỷ hẹn", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    const agent = commentCreated(issue, "agent-user");
    agent.actor = { type: "agent", id: "agent-user" };
    await engine.handle(agent);
    const marked = commentCreated(issue, "x");
    marked.data.body = "xong rồi <!-- intake-bot -->";
    await engine.handle(marked);
    expect(store.getTimer(keyOf(issue))?.state).toBe("pending");
  });

  it("issue bị xoá huỷ mọi hẹn của nó", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const other = fake.addIssue({ title: "Khác", columnId: 4 });
    const { engine, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    await engine.handle(resolved(other));
    const del = stateChanged(issue, 4, { name: "Resolved", type: "completed" });
    del.event = "issue.deleted";
    await engine.handle(del);
    expect(store.getTimer(keyOf(issue))?.state).toBe("cancelled");
    expect(store.getTimer(keyOf(other))?.state).toBe("pending");
  });

  it("lỡ webhook lúc bot tắt: kiểm lại lúc tới hạn, issue không còn Resolved thì không đóng", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    fake.issues[0].columnId = 3; // mở lại mà bot không nhận được webhook
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(3);
    expect(store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("không còn ở cột Resolved");
  });

  it("lỡ webhook: người báo đã comment sau khi hẹn thì không đóng", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    fake.addComment(issue.id, "vẫn chưa được");
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("người báo đã trả lời");
  });

  it("comment của bot (có dấu) sau khi hẹn không ngăn việc đóng", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler } = build([closeRule()]);
    await engine.handle(resolved(issue));
    fake.addComment(issue.id, "nhắc <!-- intake-bot -->");
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(5);
  });

  it("cột đích tuỳ chọn và lỗi rõ khi cột không tồn tại (thử lại rồi failed)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule({ to: "backlog" })]);
    await engine.handle(resolved(issue));
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(1);

    const other = fake.addIssue({ title: "B", columnId: 4 });
    const bad = build([closeRule({ to: "Không có cột này" })]);
    await bad.engine.handle(resolved(other));
    for (let i = 0; i < 6; i++)
      await advance(bad.scheduler, 40 * 60_000 + 49 * HOUR * (i === 0 ? 1 : 0));
    expect(bad.store.getTimer(keyOf(other))).toMatchObject({ state: "failed" });
    expect(bad.store.getTimer(keyOf(other))?.lastError).toContain("Không có cột này");
    void store;
  });

  it("requiredEvents gồm sự kiện chỉ để huỷ hẹn", () => {
    const { engine } = build([closeRule()]);
    expect(engine.requiredEvents()).toEqual([
      "comment.created",
      "issue.deleted",
      "issue.state_changed",
    ]);
    expect(engine.hasTimers()).toBe(true);
    expect(build([whenColumn("A").do(actions.setPriority("low"))]).engine.hasTimers()).toBe(false);
  });
});

describe("restart giữa chừng", () => {
  it("hẹn còn nguyên sau khi bot tắt và mở lại với cùng kho, rồi chạy đúng hạn", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const first = build([closeRule({ comment: "Tự đóng" })], { path });
    await first.engine.handle(resolved(issue));
    await first.scheduler.stop();
    first.store.close();

    const second = build([closeRule({ comment: "Tự đóng" })], { path });
    expect(second.store.getTimer(keyOf(issue))?.state).toBe("pending");
    await advance(second.scheduler, 10 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    await advance(second.scheduler, 40 * HOUR);
    expect(fake.issues[0].columnId).toBe(5);
    expect(fake.comments.filter((c) => c.body.includes("Tự đóng"))).toHaveLength(1);
  });

  it("bot tắt quá hạn hẹn: lên lại là chạy ngay (có kiểm lại)", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const first = build([closeRule()], { path });
    await first.engine.handle(resolved(issue));
    first.store.close();
    clock.t += 100 * HOUR;
    const second = build([closeRule()], { path });
    await second.scheduler.tick();
    await second.scheduler.idle();
    expect(fake.issues[0].columnId).toBe(5);
  });

  it("sập giữa lúc chạy: lượt chạy lại không comment trùng (khoá theo lần hẹn)", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const rules = () => [closeRule({ comment: "Tự đóng" })];
    const first = build(rules(), { path });
    await first.engine.handle(resolved(issue));
    clock.t += 49 * HOUR;
    // Mô phỏng sập SAU khi comment đã ghi, TRƯỚC khi chuyển cột và đánh done.
    const row = first.store.dueTimers(clock.t)[0];
    expect(first.store.claimTimer(row.key, row.gen, clock.t, 1000)).toBe(true);
    await createScopedTracker(
      new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
      { team: "tech", project: "TECH" },
      { readRetries: 0, clock },
    ).comment(issue.id, "Tự đóng", { idempotencyKey: `timer:${row.key}#${row.gen}` });
    first.store.close();

    clock.t += 2000; // lease cũ hết hạn
    const second = build(rules(), { path });
    await second.scheduler.tick();
    await second.scheduler.idle();
    expect(fake.issues[0].columnId).toBe(5);
    expect(fake.comments.filter((c) => c.body.includes("Tự đóng"))).toHaveLength(1);
  });

  it("dedupe sự kiện sống qua restart khi dùng tập khoá bền", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    const rule = whenColumn("Cần phân loại").do(actions.comment("Đã nhận."));
    const env = stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" });
    const first = build([rule], { path, durableSeen: true });
    expect(await first.engine.handle(env)).toHaveLength(1);
    expect(await first.engine.handle(env)).toEqual([]);
    first.store.close();
    const second = build([rule], { path, durableSeen: true });
    expect(await second.engine.handle(env)).toEqual([]); // giao lại sau restart
    expect(fake.comments.filter((c) => c.body.includes("Đã nhận."))).toHaveLength(1);
  });

  it("luật bị xoá khỏi khai báo: hẹn mồ côi bị huỷ kèm lý do, không ném", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const first = build([closeRule()], { path });
    await first.engine.handle(resolved(issue));
    first.store.close();
    const second = build([whenColumn("A").do(actions.setPriority("low"))], { path });
    await advance(second.scheduler, 49 * HOUR);
    expect(second.store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(second.store.getTimer(keyOf(issue))?.lastError).toContain("không còn trong khai báo");
  });
});

describe("after / cancelTimer", () => {
  it("after chạy hành động tuỳ ý sau thời hạn, với khoá chống trùng và payload issue", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    const rule = whenColumn("Cần phân loại")
      .named("nhac")
      .do(
        actions.comment("Đã nhận."),
        actions.after("2h", async (ctx) => {
          await ctx.tracker.comment(ctx.issueId as number, "Nhắc: chưa có ai xử lý.", {
            idempotencyKey: ctx.idempotencyKey,
          });
        }),
      );
    const { engine, scheduler, store } = build([rule]);
    await engine.handle(stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" }));
    expect(store.getTimer(`nhac#1:${issue.id}`)?.cancelOn).toEqual([]);
    await advance(scheduler, HOUR);
    expect(fake.comments.some((c) => c.body.includes("Nhắc"))).toBe(false);
    await advance(scheduler, 2 * HOUR);
    expect(fake.comments.filter((c) => c.body.includes("Nhắc: chưa có ai xử lý."))).toHaveLength(1);
  });

  it("khoá chung + actions.cancelTimer: luật khác dập được hẹn", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    const rules = [
      whenColumn("Cần phân loại")
        .named("hen")
        .do(actions.after("2h", () => {}, { key: "nhac:{issue}" })),
      whenColumn("Đang xử lý").named("dap").do(actions.cancelTimer("nhac:{issue}")),
    ];
    const { engine, store } = build(rules);
    await engine.handle(stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" }));
    expect(store.getTimer(`nhac:${issue.id}`)?.state).toBe("pending");
    await engine.handle(reopened(issue));
    expect(store.getTimer(`nhac:${issue.id}`)?.state).toBe("cancelled");
  });

  it("replace: hẹn lại dời hạn (debounce)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    const rule = whenColumn("Cần phân loại")
      .named("deb")
      .do(actions.after("2h", () => {}, { replace: true }));
    const { engine, store } = build([rule]);
    const env = () => stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" });
    await engine.handle(env());
    const first = store.getTimer(`deb#0:${issue.id}`)?.dueAt as number;
    clock.t += HOUR;
    await engine.handle(env());
    expect(store.getTimer(`deb#0:${issue.id}`)?.dueAt).toBe(first + HOUR);
  });

  it("duration sai ném ngay lúc dựng luật; token lạ cũng vậy", () => {
    expect(() => actions.after("hai giờ", () => {})).toThrow(RangeError);
    expect(() => actions.after("1h", () => {}, { cancelOn: ["lạ" as any] })).toThrow(/token/);
  });

  it("engine không có kho thì hành động hẹn giờ báo lỗi rõ ràng (kết quả failed, không ném)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const engine = new RuleEngine({
      rules: [closeRule()],
      tracker: createScopedTracker(
        new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
        { team: "tech", project: "TECH" },
        { readRetries: 0 },
      ),
      config: {},
      logger,
      reporter: anyHumanIsReporter,
    });
    const out = await engine.handle(resolved(issue));
    expect(out[0]).toMatchObject({ status: "failed" });
    expect(out[0].detail).toContain("kho bền");
  });
});

describe("closeAfter: chống đóng nhầm", () => {
  it("issue bị mở lại ngay lúc đang dựng comment: không comment, không đóng, hẹn bị huỷ", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([
      closeRule({
        comment: async () => {
          fake.issues[0].columnId = 3; // người dùng mở lại đúng lúc này
          return "Tự đóng.";
        },
      }),
    ]);
    await engine.handle(resolved(issue));
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(3);
    expect(fake.comments.some((c) => c.body.includes("Tự đóng."))).toBe(false);
    expect(store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("không còn ở cột Resolved");
  });

  it("issue bị mở lại ngay SAU khi comment đã ghi: không chuyển cột (đọc lại ngay trước moveTo)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule({ comment: "Tự đóng." })]);
    await engine.handle(resolved(issue));
    const original = fake.addComment.bind(fake);
    fake.addComment = (...args: Parameters<typeof original>) => {
      const c = original(...args);
      fake.issues[0].columnId = 3; // mở lại giữa comment và moveTo
      return c;
    };
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(3);
    expect(store.getTimer(keyOf(issue))?.state).toBe("cancelled");
  });

  it("yêu cầu huỷ (webhook) tới lúc hẹn đang chạy: hành động dừng trước khi ghi", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    let engineRef!: RuleEngine<any>;
    const rules = [
      closeRule({
        comment: async () => {
          // người báo comment đúng lúc hẹn đang chạy: webhook tới engine
          await engineRef.handle(commentCreated(issue, "reporter-1"));
          return "Tự đóng.";
        },
      }),
    ];
    const { engine, scheduler, store } = build(rules);
    engineRef = engine;
    await engine.handle(resolved(issue));
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    expect(fake.comments.some((c) => c.body.includes("Tự đóng."))).toBe(false);
    expect(store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("người báo trả lời");
  });

  it("mọi lệnh ghi của ctx.tracker trong hành động `after` bị chặn khi có yêu cầu huỷ", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    let engineRef!: RuleEngine<any>;
    const rule = whenColumn("Cần phân loại")
      .named("nhac")
      .do(
        actions.after(
          "1h",
          async (ctx) => {
            await engineRef.handle(stateChanged(issue, 3, { name: "Đang xử lý", type: "started" }));
            await ctx.tracker.comment(ctx.issueId as number, "Nhắc nhở muộn.");
          },
          { cancelOn: ["state-change"] },
        ),
      );
    const { engine, scheduler, store } = build([rule]);
    engineRef = engine;
    await engine.handle(stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" }));
    await advance(scheduler, 2 * HOUR);
    expect(fake.comments.some((c) => c.body.includes("Nhắc nhở muộn."))).toBe(false);
    expect(store.getTimer(`nhac#0:${issue.id}`)?.state).toBe("cancelled");
  });

  it("kiểm lại lúc tới hạn lấy mốc từ statusSince của server: comment sau lúc Resolved nhưng trước lúc bot hẹn vẫn chặn", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    const armedAt = clock.t;
    (fake.issues[0] as any).statusSince = new Date(armedAt - 3 * HOUR).toISOString();
    const c = fake.addComment(issue.id, "vẫn lỗi nha");
    c.createdAt = new Date(armedAt - HOUR).toISOString(); // sau Resolved, trước lúc bot hẹn
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("người báo đã trả lời");
  });

  it("comment từ TRƯỚC lúc Resolved không chặn việc đóng", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler } = build([closeRule()]);
    await engine.handle(resolved(issue));
    const armedAt = clock.t;
    (fake.issues[0] as any).statusSince = new Date(armedAt - HOUR).toISOString();
    const c = fake.addComment(issue.id, "đang xem");
    c.createdAt = new Date(armedAt - 5 * HOUR).toISOString();
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(5);
  });

  it("comment không có createdAt được coi là mới (thà không đóng)", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const { engine, scheduler, store } = build([closeRule()]);
    await engine.handle(resolved(issue));
    const c = fake.addComment(issue.id, "không rõ giờ");
    (c as any).createdAt = undefined;
    await advance(scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    expect(store.getTimer(keyOf(issue))?.lastError).toContain("người báo đã trả lời");
  });
});

describe("hẹn giờ: định danh hành động, khoá, người báo", () => {
  it("luật bị sửa (đổi thời hạn) khi còn hẹn đang chờ: hẹn bị bỏ, không chạy nhầm hành động mới", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 4 });
    const first = build([closeRule()], { path });
    await first.engine.handle(resolved(issue));
    first.store.close();
    const second = build([whenResolved().named("auto-close").do(actions.closeAfter("24h"))], {
      path,
    });
    await advance(second.scheduler, 49 * HOUR);
    expect(fake.issues[0].columnId).toBe(4);
    expect(second.store.getTimer(keyOf(issue))).toMatchObject({ state: "cancelled" });
    expect(second.store.getTimer(keyOf(issue))?.lastError).toContain("đã đổi");
  });

  it("id tường minh giữ hẹn chạy được dù đổi thời hạn", async () => {
    const path = dbPath();
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    const ran: string[] = [];
    const mk = (d: string) =>
      whenColumn("Cần phân loại")
        .named("nhac")
        .do(actions.after(d, () => void ran.push(d), { id: "nhac-v1" }));
    const first = build([mk("2h")], { path });
    await first.engine.handle(stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" }));
    first.store.close();
    const second = build([mk("3h")], { path });
    await advance(second.scheduler, 2.5 * HOUR);
    expect(ran).toEqual(["3h"]);
  });

  it("hẹn lại lúc hẹn đang chạy được xếp hàng, không bị mất", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 2 });
    let engineRef!: RuleEngine<any>;
    let reArmed = false;
    const rule = whenColumn("Cần phân loại")
      .named("nhac")
      .do(
        actions.after("2h", async () => {
          if (reArmed) return;
          reArmed = true;
          await engineRef.handle(
            stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" }),
          );
        }),
      );
    const { engine, scheduler, store } = build([rule]);
    engineRef = engine;
    await engine.handle(stateChanged(issue, 2, { name: "Cần phân loại", type: "unstarted" }));
    await advance(scheduler, 3 * HOUR);
    const row = store.getTimer(`nhac#0:${issue.id}`);
    expect(row).toMatchObject({ state: "pending", gen: 2 });
    expect(row?.dueAt).toBe(clock.t + 2 * HOUR);
  });

  it("after từ chối khoá tuỳ chọn thiếu {issue}", () => {
    expect(() => actions.after("1h", () => {}, { key: "nhac-chung" })).toThrow(/thiếu \{issue\}/);
    expect(() => actions.closeAfter("1h", { key: "dong" })).toThrow(/thiếu \{issue\}/);
    expect(() => actions.after("1h", () => {}, { key: "nhac:{issue}" })).not.toThrow();
  });

  it("closeAfter (hoặc cancelOn reporter-comment) cần reporter: thiếu thì RuleEngine ném", () => {
    const tracker = createScopedTracker(
      new ItsaplanClient(fake.baseUrl, fake.agentKey),
      { team: "tech", project: "TECH" },
      { readRetries: 0 },
    );
    const mk = (rule: Rule<any>, reporter?: ReporterResolver) =>
      new RuleEngine({ rules: [rule], tracker, config: {}, logger, reporter });
    const close = whenResolved().do(actions.closeAfter("1h"));
    expect(close.needsReporter).toBe(true);
    expect(() => mk(close)).toThrow(/cần `reporter`/);
    expect(() => mk(close, anyHumanIsReporter)).not.toThrow();
    const viaToken = whenResolved().do(
      actions.after("1h", () => {}, { cancelOn: ["reporter-comment"] }),
    );
    expect(() => mk(viaToken)).toThrow(/cần `reporter`/);
    const plain = whenResolved().do(actions.after("1h", () => {}, { cancelOn: ["state-change"] }));
    expect(plain.needsReporter).toBeUndefined();
    expect(() => mk(plain)).not.toThrow();
  });
});
