import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IntakeLogger } from "../core/logger";
import { ItsaplanClient, type ItsaplanWebhookEnvelope } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import {
  RuleEngine,
  assign,
  comment,
  moveTo,
  setPriority,
  whenColumn,
  whenCommentCreated,
  whenDone,
  whenEvent,
  whenResolved,
} from "./rules";
import { createScopedTracker } from "./tracker";

const silent: IntakeLogger = { debug() {}, info() {}, warn() {}, error() {} };
let fake: FakeItsaplan;
let ts = 1000;

const engine = (rules: ConstructorParameters<typeof RuleEngine>[0]["rules"]) =>
  new RuleEngine({
    rules,
    tracker: createScopedTracker(
      new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
      { team: "tech", project: "TECH" },
    ),
    config: {},
    logger: silent,
  });

const issueEvent = (
  event: ItsaplanWebhookEnvelope["event"],
  issue: { id: number; identifier: string },
  columnId: number,
  extra: Partial<ItsaplanWebhookEnvelope> = {},
): ItsaplanWebhookEnvelope => ({
  action: "update",
  type: "Issue",
  event,
  data: { id: issue.id, identifier: issue.identifier, columnId },
  actor: { type: "human", name: "An" },
  createdAt: new Date().toISOString(),
  webhookTimestamp: ++ts,
  ...extra,
});

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("RuleEngine", () => {
  it("whenColumn: khớp theo tên cột (không phân biệt dấu) và chạy hành động tuần tự", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 1 });
    const e = engine([
      whenColumn("cần phân loại").do(
        comment("Đã nhận."),
        setPriority("high"),
        moveTo("Đang xử lý"),
      ),
    ]);
    const out = await e.handle(issueEvent("issue.state_changed", issue, 2));
    expect(out).toEqual([{ rule: "whenColumn(cần phân loại)", status: "done" }]);
    expect(fake.issues[0]).toMatchObject({ priority: "high", columnId: 3 });
    expect(fake.comments.at(-1)!.body).toContain("Đã nhận.");
  });

  it("không khớp cột khác, không khớp sự kiện khác", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").do(setPriority("low"))]);
    expect(await e.handle(issueEvent("issue.state_changed", issue, 3))).toEqual([]);
    expect(await e.handle(issueEvent("comment.created", issue, 2))).toEqual([]);
    expect(fake.issues[0]!.priority).toBeNull();
  });

  it("whenResolved / whenDone phân loại theo tên + nhóm cột", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([
      whenResolved().named("resolved").do(setPriority("low")),
      whenDone().named("done").do(assign("user-5")),
    ]);
    expect(
      (await e.handle(issueEvent("issue.state_changed", issue, 4))).map((r) => r.rule),
    ).toEqual(["resolved"]);
    expect(
      (await e.handle(issueEvent("issue.state_changed", issue, 5))).map((r) => r.rule),
    ).toEqual(["done"]);
    expect(fake.issues[0]).toMatchObject({ priority: "low", assigneeUserId: "user-5" });
  });

  it("dùng payload `state` khi tracker không tra ra cột", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Mới lạ").do(setPriority("urgent"))]);
    const env = issueEvent("issue.created", issue, 777);
    env.data.state = { id: 777, name: "Mới lạ", type: "unstarted" };
    expect(await e.handle(env)).toHaveLength(1);
  });

  it("lọc: sự kiện trùng, do agent gây ra, ngoài dự án", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").do(setPriority("high"))]);

    const env = issueEvent("issue.state_changed", issue, 2);
    expect(await e.handle(env)).toHaveLength(1);
    expect(await e.handle(env)).toEqual([]); // trùng khoá webhook

    const byAgent = issueEvent("issue.state_changed", issue, 2, { actor: { type: "agent" } });
    expect(await e.handle(byAgent)).toEqual([]);

    const foreign = issueEvent("issue.state_changed", { id: issue.id, identifier: "OTHER-3" }, 2);
    expect(await e.handle(foreign)).toEqual([]);
  });

  it("comment: bỏ comment của bot, gỡ HTML, lọc theo nội dung", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenCommentCreated((c) => c.text.includes("gấp")).do(setPriority("urgent"))]);
    const commentEvent = (body: string): ItsaplanWebhookEnvelope => ({
      action: "create",
      type: "Comment",
      event: "comment.created",
      data: {
        id: ++ts,
        issueId: issue.id,
        body,
        issue: { id: issue.id, identifier: issue.identifier },
      },
      actor: { type: "human" },
      createdAt: new Date().toISOString(),
      webhookTimestamp: ++ts,
    });
    expect(await e.handle(commentEvent("bình thường"))).toEqual([]);
    expect(await e.handle(commentEvent("<p>việc <b>gấp</b></p>"))).toHaveLength(1);
    expect(fake.issues[0]!.priority).toBe("urgent");
    fake.issues[0]!.priority = null;
    expect(await e.handle(commentEvent("gấp lắm <!-- intake-bot -->"))).toEqual([]);
    expect(fake.issues[0]!.priority).toBeNull();
  });

  it("một luật lỗi không chặn luật khác; lỗi nằm trong kết quả", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([
      whenColumn("Cần phân loại").named("hong").do(moveTo("Cột không có")),
      whenEvent("issue.state_changed").named("tot").do(setPriority("low")),
    ]);
    const out = await e.handle(issueEvent("issue.state_changed", issue, 2));
    expect(out.map((r) => [r.rule, r.status])).toEqual([
      ["hong", "failed"],
      ["tot", "done"],
    ]);
    expect(out[0]!.detail).toContain("không có cột");
  });

  it("requiredEvents liệt kê sự kiện cần đăng ký webhook", () => {
    const e = engine([
      whenResolved().do(setPriority("low")),
      whenCommentCreated().do(setPriority("low")),
    ]);
    expect(e.requiredEvents()).toEqual([
      "comment.created",
      "issue.column_changed",
      "issue.state_changed",
    ]);
  });

  it("whenEvent/do yêu cầu đối số hợp lệ", () => {
    expect(() => whenEvent()).toThrow();
    expect(() => whenColumn("x").do()).toThrow();
  });
});
