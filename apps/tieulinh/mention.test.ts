import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHAT, type Harness, commentCreated, harness, until } from "./testkit";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.stop());

async function settle(runId: number, ms = 3000) {
  await until(() => h.fake.run(runId).status !== "pending", ms).catch(() => {});
}

const botReplies = () => h.fake.comments.filter((c) => c.actorUserId === "agent-user");

const bind = (app: ReturnType<Harness["boot"]>["app"], issue: { id: number; identifier: string }) =>
  app.services().bindingStore.saveBinding({
    issueId: issue.id,
    chatId: CHAT,
    identifier: issue.identifier,
    title: "Không vào được app",
  });

describe("mention", () => {
  test("@mention: LLM đọc ticket qua tool, trả lời đúng luồng, lời nhắn tới người báo, chỉ đọc", async () => {
    const issue = h.fake.addIssue({
      title: "Không vào được app",
      description: "Bấm đăng nhập thì quay mãi.",
    });
    const { app, bot } = h.boot();
    bind(app, issue);
    const run = h.fake.mention(issue.id, "tóm tắt giúp, rồi hỏi anh ấy đã thử bản mới chưa");
    h.llm.script(
      {
        text: "Để mình đọc ticket.",
        toolCalls: [{ name: "get_issue", args: { identifier: issue.identifier }, id: "c1" }],
        usage: { input: 100, output: 20 },
      },
      {
        text: "Ticket báo không đăng nhập được; mình đã nhắn người báo.",
        usage: { input: 150, output: 30 },
      },
    );

    await bot.start();
    await settle(run.id);

    const done = h.fake.run(run.id);
    expect(done.status).toBe("success");
    expect(done.usage).toEqual({ inputTokens: 250, outputTokens: 50 });

    // trả lời đúng luồng comment gọi bot
    const reply = h.fake.comments.find((c) => c.actorUserId === "agent-user");
    expect(reply?.body).toContain("không đăng nhập được");
    expect(reply?.replyToId).toBe(h.fake.comments[0]?.id);

    // tool đọc thật; prompt khoá quyền: chỉ đọc, dữ liệu là dữ liệu
    expect(JSON.stringify(h.llm.requests[1]!.body.messages)).toContain(
      "Bấm đăng nhập thì quay mãi.",
    );
    const system = JSON.stringify(h.llm.requests[0]!.body.system);
    expect(system).toContain("ĐỌC");
    expect(system).toContain("DỮ LIỆU");
    expect(h.llm.requests[0]!.body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_comments",
      "get_issue",
      "search_issues",
    ]);

    // lời nhắn tới người báo (đã gỡ @mention), qua kênh log
    const sent = h.channelLog().filter((r) => r.kind === "comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: CHAT, identifier: issue.identifier });
    expect(sent[0]!.text).toContain("hỏi anh ấy đã thử bản mới chưa");
    expect(sent[0]!.text).not.toContain("@tieulinh2");

    // tuyến tin được ghi để trả lời của người báo về đúng ticket
    expect(
      app.services().routes.getMessageRoute(sent[0]!.messageId!, "telegram", CHAT),
    ).toMatchObject({
      issueId: issue.id,
    });

    // ADR-0006: bot không đổi gì ngoài comment
    expect(h.fake.count(/^(PATCH|PUT|DELETE) /)).toBe(0);
    expect(h.fake.issues[0]!.columnId).toBe(1);
  });

  test("tool search_issues trả ticket liên quan (trừ chính ticket), chỉ là gợi ý", async () => {
    const issue = h.fake.addIssue({ title: "Không vào được app", description: "đăng nhập treo" });
    const other = h.fake.addIssue({ title: "Đăng nhập treo trên iOS" });
    const { bot } = h.boot();
    const run = h.fake.mention(issue.id, "có ticket nào giống không?");
    h.llm.script(
      {
        toolCalls: [{ name: "search_issues", args: { query: "treo" }, id: "c1" }],
      },
      { text: `Có thể xem ${other.identifier} (chỉ là gợi ý).` },
    );
    await bot.start();
    await settle(run.id);
    const toolResult = JSON.stringify(h.llm.requests[1]!.body.messages);
    expect(toolResult).toContain(other.identifier);
    expect(toolResult).not.toContain(`"identifier":"${issue.identifier}"`);
    expect(h.fake.run(run.id).status).toBe("success");
  });

  test("webhook của chính comment mention tới sau đó: người báo vẫn chỉ nhận một tin", async () => {
    const issue = h.fake.addIssue({ title: "T" });
    const { app, bot } = h.boot();
    bind(app, issue);
    const run = h.fake.mention(issue.id, "hỏi giúp anh ấy số điện thoại");
    h.llm.script({ text: "Đã nhắn." });
    await bot.start();
    await settle(run.id);
    const mentionId = h.fake.comments[0]!.id;

    await bot.handleEvent(commentCreated(issue, h.fake.comments[0]!.body, { id: mentionId }));
    expect(h.channelLog().filter((r) => r.kind === "comment")).toHaveLength(1);
  });

  test("chưa cấu hình LLM: run failed với lý do rõ, nhưng lời nhắn vẫn tới người báo", async () => {
    const issue = h.fake.addIssue({ title: "T" });
    const { app, bot } = h.boot({ llm: false });
    bind(app, issue);
    const run = h.fake.mention(issue.id, "hỏi giúp anh ấy");
    await bot.start();
    await settle(run.id);
    expect(h.fake.run(run.id).status).toBe("failed");
    expect(h.fake.run(run.id).error).toContain("LLM_BASE_URL");
    expect(h.channelLog().filter((r) => r.kind === "comment")).toHaveLength(1);
  });

  test("ticket chưa có liên kết người báo: vẫn trả lời, không gửi gì ra kênh", async () => {
    const issue = h.fake.addIssue({ title: "T" });
    const { bot } = h.boot();
    const run = h.fake.mention(issue.id, "đây là gì");
    h.llm.script({ text: "Ticket thử." });
    await bot.start();
    await settle(run.id);
    expect(h.fake.run(run.id).status).toBe("success");
    expect(h.channelLog()).toEqual([]);
  });

  test("comment chỉ có @mention: bỏ qua (skip), không gọi LLM", async () => {
    const issue = h.fake.addIssue({ title: "T" });
    const { bot } = h.boot();
    const run = h.fake.mention(issue.id, "");
    await bot.start();
    await settle(run.id);
    expect(h.fake.run(run.id).status).toBe("success");
    expect(h.llm.requests).toHaveLength(0);
  });

  test("ticket ngoài dự án TECH2: run bị bỏ qua, không gọi LLM, không gửi ra kênh", async () => {
    const issue = h.fake.addIssue({ title: "Của dự án khác", projectId: 2 });
    const { app, bot } = h.boot();
    bind(app, issue);
    const run = h.fake.mention(issue.id, "đây là gì");
    await bot.start();
    await settle(run.id);
    expect(h.fake.run(run.id).status).toBe("success");
    expect(h.llm.requests).toHaveLength(0);
    expect(h.channelLog()).toEqual([]);
    expect(botReplies()).toHaveLength(0);
  });
});
