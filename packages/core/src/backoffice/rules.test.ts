import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IntakeLogger } from "../core/logger";
import { ItsaplanClient, type ItsaplanWebhookEnvelope } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import {
  RuleEngine,
  actions,
  whenColumn,
  whenCommentCreated,
  whenDone,
  whenEvent,
  whenResolved,
} from "./rules";
import { createScopedTracker } from "./tracker";

const { assign, comment, moveTo, setPriority } = actions;
const silent: IntakeLogger = { debug() {}, info() {}, warn() {}, error() {} };
let fake: FakeItsaplan;
let ts = 1000;

const engine = (rules: ConstructorParameters<typeof RuleEngine>[0]["rules"]) =>
  new RuleEngine({
    rules,
    tracker: createScopedTracker(
      new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
      { team: "tech", project: "TECH" },
      { readRetries: 0 },
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
    // server thật không có `issue.column_changed`: đổi cột phát `issue.state_changed`
    expect(e.requiredEvents()).toEqual(["comment.created", "issue.state_changed"]);
  });

  it("không lắng nghe issue.column_changed (sự kiện không tồn tại ở server)", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").do(setPriority("high"))]);
    const env = issueEvent("issue.column_changed" as any, issue, 2);
    expect(await e.handle(env)).toEqual([]);
    expect(fake.issues[0]!.priority).toBeNull();
  });

  it("chỉ đánh dấu đã thấy SAU khi xử lý không lỗi: giao lại sau lỗi vẫn chạy", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").named("hong").do(moveTo("Cột không có"))]);
    const env = issueEvent("issue.state_changed", issue, 2);
    expect((await e.handle(env)).map((r) => r.status)).toEqual(["failed"]);
    // cùng khoá webhook, nhưng lần trước lỗi nên KHÔNG bị coi là trùng
    expect((await e.handle(env)).map((r) => r.status)).toEqual(["failed"]);

    const ok = engine([whenColumn("Cần phân loại").do(setPriority("high"))]);
    const env2 = issueEvent("issue.state_changed", issue, 2);
    expect(await ok.handle(env2)).toHaveLength(1);
    expect(await ok.handle(env2)).toEqual([]);
  });

  it("lỗi tạm thời khi xác minh dự án: không nuốt thành 'ngoài dự án', không đánh dấu đã thấy", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").do(setPriority("high"))]);
    fake.fail(/^GET \/issues\/\d+$/, 503, 1);
    const env = issueEvent("issue.state_changed", issue, 2);
    expect(await e.handle(env)).toEqual([]);
    expect(fake.issues[0]!.priority).toBeNull();
    // giao lại (cùng khoá) giờ xử lý được
    expect(await e.handle(env)).toHaveLength(1);
    expect(fake.issues[0]!.priority).toBe("high");
  });

  it("ranh giới theo projectId của payload, không theo tiền tố mã", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").do(setPriority("high"))]);
    // mã trùng tiền tố TECH nhưng thuộc dự án id 2 (team khác cùng khoá TECH)
    const other = issueEvent("issue.state_changed", issue, 2);
    other.data.projectId = 2;
    expect(await e.handle(other)).toEqual([]);
    expect(fake.count(/^GET \/issues\/\d+$/)).toBe(0);
    const mine = issueEvent("issue.state_changed", issue, 2);
    mine.data.projectId = 1;
    expect(await e.handle(mine)).toHaveLength(1);
    expect(fake.issues[0]!.priority).toBe("high");
  });

  it("comment mang mã TECH nhưng issue thuộc dự án khác: bị loại sau khi hỏi tracker", async () => {
    const foreign = fake.addIssue({ title: "X", projectId: 2 });
    const e = engine([whenCommentCreated().do(setPriority("urgent"))]);
    const env: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      data: {
        id: ++ts,
        issueId: foreign.id,
        body: "hi",
        issue: { id: foreign.id, identifier: foreign.identifier },
      },
      actor: { type: "human" },
      createdAt: new Date().toISOString(),
      webhookTimestamp: ++ts,
    };
    expect(await e.handle(env)).toEqual([]);
    expect(foreign.priority).toBeNull();
  });

  it("không có webhookTimestamp: không dedupe và khoá chống trùng không nuốt nhầm sự kiện khác", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const e = engine([whenColumn("Cần phân loại").do(comment("Chào"))]);
    const bare = () => issueEvent("issue.state_changed", issue, 2, { webhookTimestamp: undefined });
    expect(await e.handle(bare())).toHaveLength(1);
    expect(await e.handle(bare())).toHaveLength(1);
    expect(fake.comments.filter((c) => c.body.includes("Chào"))).toHaveLength(2);
  });

  it("ctx.llm: hành động của luật nhận LLM của bot (hoặc undefined khi bot không có)", async () => {
    const issue = fake.addIssue({ title: "Lỗi" });
    const seen: unknown[] = [];
    const rule = whenColumn("Cần phân loại").do((ctx) => void seen.push(ctx.llm));
    await engine([rule]).handle(issueEvent("issue.state_changed", issue, 2));
    expect(seen).toEqual([undefined]);

    const llm = {
      api: "anthropic-messages" as const,
      model: "m",
      complete: async () => ({}) as never,
    };
    const withLlm = new RuleEngine({
      rules: [rule],
      tracker: createScopedTracker(
        new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
        { team: "tech", project: "TECH" },
        { readRetries: 0 },
      ),
      config: {},
      logger: silent,
      llm,
    });
    await withLlm.handle(issueEvent("issue.state_changed", issue, 2));
    expect(seen[1]).toBe(llm);
  });

  it("whenEvent/do yêu cầu đối số hợp lệ", () => {
    expect(() => whenEvent()).toThrow();
    expect(() => whenColumn("x").do()).toThrow();
  });
});
