import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type ChannelPort,
  type NotifyBinding,
  SqliteMessageRouteStore,
  SqliteNotifyBindingReader,
  SqliteTicketStateStore,
  intakeApplySchema,
  notifyApplySchema,
} from "../intake";
import { ItsaplanClient } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { TicketClosure } from "./closure";
import type { RuleEvent } from "./rules";
import { createScopedTracker } from "./tracker";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const CHAT = "-1000000000001";

class RecordingChannel implements ChannelPort {
  readonly channelType = "log";
  sent: Array<{ message: string; state: string; button: boolean; id: string }> = [];
  cleared: string[] = [];
  failNext = false;
  private n = 0;
  async sendComment() {
    return `c${++this.n}`;
  }
  async sendStateChange(input: { message: string; state: string; withReporterOkButton: boolean }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("kênh hỏng");
    }
    const id = `m${++this.n}`;
    this.sent.push({
      message: input.message,
      state: input.state,
      button: input.withReporterOkButton,
      id,
    });
    return id;
  }
  async clearInteractiveButtons(_b: NotifyBinding, messageId: string) {
    this.cleared.push(messageId);
  }
}

let fake: FakeItsaplan;
let db: Database;
let channel: RecordingChannel;
let closure: TicketClosure;
let tracker: ReturnType<typeof createScopedTracker>;
let clockMs = 1_000;

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
  fake.columns.push({ id: 6, name: "Canceled", stateType: "canceled", position: 5 });
  db = new Database(":memory:");
  intakeApplySchema(db);
  notifyApplySchema(db);
  channel = new RecordingChannel();
  clockMs = 1_000;
  closure = new TicketClosure({
    states: new SqliteTicketStateStore(db),
    bindings: new SqliteNotifyBindingReader(db),
    routes: new SqliteMessageRouteStore(db),
    channel,
    copy: {
      describe: ({ identifier, columnName, state }) =>
        state === "done" ? `${identifier} hoàn tất` : `${identifier} -> ${columnName}`,
    },
    okCopy: {
      comment: ({ who, time }) => `${who} đã ổn (${time})`,
      ack: () => "ghi nhận",
      unknown: () => "không thấy",
      notYourChat: () => "nút của chat khác",
      done: ({ identifier }) => `${identifier} đã xong`,
      canceled: ({ identifier }) => `${identifier} đã huỷ`,
      reopened: ({ identifier }) => `${identifier} xử lý lại`,
    },
    channelType: "log",
    replyCopy: {
      comment: ({ who, text, time }) => `${who} phản hồi: ${text} (${time})`,
      ack: ({ identifier }) => `đã chuyển vào ${identifier}`,
      closed: ({ identifier }) => `${identifier} đã đóng, hãy tạo ticket mới`,
    },
    clock: { now: () => clockMs },
    formatTime: () => "T",
  });
  tracker = createScopedTracker(
    new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
    { team: "tech", project: "TECH" },
    { readRetries: 0 },
  );
});
afterEach(async () => {
  await fake.stop();
  db.close();
});

function bind(issue: { id: number; identifier: string }, chatId = CHAT) {
  db.run(
    "INSERT INTO ticket_bindings (issue_id, chat_id, identifier, channel_type) VALUES (?, ?, ?, 'log')",
    [issue.id, chatId, issue.identifier],
  );
}

const COLUMN = {
  2: { id: 2, name: "Cần phân loại", state: "open" as const },
  3: { id: 3, name: "Đang xử lý", state: "open" as const },
  4: { id: 4, name: "Resolved", state: "resolved" as const },
  5: { id: 5, name: "Done", state: "done" as const },
};

function moved(issue: { id: number; identifier: string }, column: keyof typeof COLUMN) {
  fake.issues.find((i) => i.id === issue.id)!.columnId = column;
  const event: RuleEvent = {
    name: "issue.state_changed",
    envelope: {} as RuleEvent["envelope"],
    issueId: issue.id,
    identifier: issue.identifier,
    column: COLUMN[column],
    comment: null,
    actor: null,
  };
  return closure.onStateChanged({ event, logger: silent });
}

describe("TicketClosure.onStateChanged (ADR-0006)", () => {
  it("sang Resolved: báo người báo kèm nút Đã ổn, lưu route và tin-nút; KHÔNG đổi cột", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 3 });
    bind(issue);
    await moved(issue, 4);
    expect(channel.sent).toEqual([
      { message: `${issue.identifier} -> Resolved`, state: "resolved", button: true, id: "m1" },
    ]);
    expect(new SqliteTicketStateStore(db).get(issue.id)).toMatchObject({
      state: "resolved",
      promptMessageId: "m1",
    });
    expect(new SqliteMessageRouteStore(db).getMessageRoute("m1", "log", CHAT)).toMatchObject({
      issueId: issue.id,
    });
    expect(fake.issues[0]!.columnId).toBe(4); // bot không chuyển sang Done
    expect(fake.count(/^PATCH /)).toBe(0);
  });

  it("webhook tới lại hoặc đổi giữa hai cột cùng nhóm mở: không báo lặp", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 1 });
    bind(issue);
    await moved(issue, 2); // lần đầu thấy: báo
    await moved(issue, 3); // open → open: im lặng
    await moved(issue, 2);
    expect(channel.sent).toHaveLength(1);
    await moved(issue, 4);
    await moved(issue, 4);
    expect(channel.sent.map((s) => s.state)).toEqual(["open", "resolved"]);
  });

  it("Resolved → Done: gỡ nút cũ, báo hoàn tất không nút", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 3 });
    bind(issue);
    await moved(issue, 4);
    await moved(issue, 5);
    expect(channel.cleared).toEqual(["m1"]);
    expect(channel.sent.at(-1)).toMatchObject({ state: "done", button: false });
    expect(channel.sent.at(-1)!.message).toContain("hoàn tất");
  });

  it("mở lại sau Resolved: gỡ nút cũ; kéo thẳng In Progress → Done vẫn báo", async () => {
    const a = fake.addIssue({ title: "A", columnId: 3 });
    const b = fake.addIssue({ title: "B", columnId: 3 });
    bind(a);
    bind(b);
    await moved(a, 4);
    await moved(a, 3);
    expect(channel.cleared).toEqual(["m1"]);
    await moved(b, 5);
    expect(channel.sent.at(-1)).toMatchObject({ state: "done" });
  });

  it("kênh lỗi khi báo: trạng thái vẫn ghi, lần sau không báo lại", async () => {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 3 });
    bind(issue);
    channel.failNext = true;
    await moved(issue, 4);
    expect(channel.sent).toHaveLength(0);
    await moved(issue, 4);
    expect(channel.sent).toHaveLength(0);
    expect(new SqliteTicketStateStore(db).get(issue.id)?.state).toBe("resolved");
  });

  it("không có liên kết chat: ghi trạng thái, không báo ai", async () => {
    const issue = fake.addIssue({ title: "Tạo tay", columnId: 3 });
    await moved(issue, 4);
    expect(channel.sent).toHaveLength(0);
    expect(new SqliteTicketStateStore(db).get(issue.id)?.state).toBe("resolved");
  });
});

describe("TicketClosure.recordReporterOk (người báo không đóng được ticket)", () => {
  async function resolved() {
    const issue = fake.addIssue({ title: "Lỗi", columnId: 3 });
    bind(issue);
    await moved(issue, 4);
    return issue;
  }
  const press = (issueId: number, chatId = CHAT, userName?: string) =>
    closure.recordReporterOk(tracker, { issueId, chatId, userName });

  it("bấm khi đang Resolved: ghi một comment kèm tên, gỡ nút, ticket KHÔNG đổi cột", async () => {
    const issue = await resolved();
    clockMs = 5_000;
    expect(await press(issue.id, `telegram:${CHAT}`, " An ")).toEqual({
      outcome: "recorded",
      replyText: "ghi nhận",
    });
    const mine = fake.comments.filter((c) => c.issueId === issue.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain("An đã ổn (T)");
    expect(channel.cleared).toEqual(["m1"]);
    expect(fake.issues[0]!.columnId).toBe(4);
    expect(fake.count(/^PATCH /)).toBe(0);
    expect(new SqliteTicketStateStore(db).get(issue.id)).toMatchObject({
      state: "resolved",
      reporterOkAt: 5_000,
    });
  });

  it("bấm lần hai: không thêm comment", async () => {
    const issue = await resolved();
    await press(issue.id);
    expect((await press(issue.id)).outcome).toBe("already_recorded");
    expect(fake.comments.filter((c) => c.issueId === issue.id)).toHaveLength(1);
  });

  it("chat lạ, ticket lạ, ticket dự án khác: không comment", async () => {
    const issue = await resolved();
    expect((await press(issue.id, "-1000000000002")).outcome).toBe("not_bound");
    expect((await press(99999)).outcome).toBe("unknown");
    const foreign = fake.addIssue({ title: "Khác", projectId: 2, identifier: "OTHER-1" });
    bind(foreign);
    expect((await press(foreign.id)).outcome).toBe("unknown");
    expect(fake.comments).toHaveLength(0);
  });

  it("ticket đã hoàn tất, đã huỷ hoặc bị kéo lại: chỉ trả lời đúng tình trạng", async () => {
    const issue = await resolved();
    fake.issues[0]!.columnId = 3;
    expect(await press(issue.id)).toMatchObject({ outcome: "reopened" });
    fake.issues[0]!.columnId = 5;
    expect(await press(issue.id)).toMatchObject({ outcome: "done" });
    fake.issues[0]!.columnId = 6;
    expect(await press(issue.id)).toMatchObject({ outcome: "canceled" });
    expect(fake.comments).toHaveLength(0);
  });
});

describe("TicketClosure.recordReporterReply (trả lời tự do vào tin thông báo)", () => {
  async function notified() {
    const issue = fake.addIssue({ title: "T", columnId: 3 });
    bind(issue);
    await moved(issue, 4); // tin thông báo m1, route (m1, log, CHAT)
    return issue;
  }
  const reply = (over: Partial<{ chatId: string; messageId: string; text: string }> = {}) =>
    closure.recordReporterReply(tracker, {
      chatId: CHAT,
      messageId: "m1",
      text: "chưa ổn ạ, vẫn lỗi <NullPointerException>",
      userName: "An",
      ...over,
    });

  it("ghi một comment (escape < >), không đổi cột, không mở lại", async () => {
    const issue = await notified();
    const out = await reply();
    expect(out).toEqual({
      handled: true,
      outcome: "recorded",
      replyText: `đã chuyển vào ${issue.identifier}`,
    });
    const mine = fake.comments.filter((c) => c.issueId === issue.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain(
      "An phản hồi: chưa ổn ạ, vẫn lỗi &lt;NullPointerException&gt; (T)",
    );
    expect(fake.issues[0]!.columnId).toBe(4);
    expect(fake.count(/^PATCH /)).toBe(0);
  });

  it("chat id có tiền tố telegram: vẫn khớp route; cùng update giao lại chỉ ghi một comment", async () => {
    await notified();
    db.run("UPDATE message_routes SET chat_id = ?", [`telegram:${CHAT}`]);
    await reply();
    await reply();
    expect(fake.comments).toHaveLength(1);
  });

  it("tin không phải trả lời một tin đã biết, chat lạ, hoặc ticket dự án khác: handled false, không comment", async () => {
    const issue = await notified();
    expect(await reply({ messageId: "m999" })).toEqual({ handled: false });
    expect(await reply({ chatId: "-1000000000002" })).toEqual({ handled: false });
    expect(await reply({ text: "   " })).toEqual({ handled: false });
    db.run("UPDATE message_routes SET identifier = 'OTHER-1'");
    expect(await reply()).toEqual({ handled: false });
    expect(fake.comments.filter((c) => c.issueId === issue.id)).toHaveLength(0);
  });

  it("ticket đã hoàn tất hoặc huỷ: từ chối ghi và hướng dẫn tạo ticket mới", async () => {
    const issue = await notified();
    fake.issues[0]!.columnId = 5;
    expect(await reply()).toMatchObject({ handled: true, outcome: "closed" });
    fake.issues[0]!.columnId = 6;
    expect(await reply()).toMatchObject({ handled: true, outcome: "closed" });
    expect(fake.comments.filter((c) => c.issueId === issue.id)).toHaveLength(0);
  });
});
