import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { markBotComment } from "@vuihoc/bot-core/core";
import {
  CHAT,
  DONE,
  type Harness,
  INPROGRESS,
  RESOLVED,
  commentCreated,
  harness,
  stateChanged,
  until,
} from "./testkit";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.stop());

function setup(env: Record<string, string> = {}, bound = true) {
  const issue = h.fake.addIssue({ title: "Không vào được app", columnId: 3 });
  const { app, bot } = h.boot({ env });
  if (bound) {
    app.services().bindingStore.saveBinding({
      issueId: issue.id,
      chatId: CHAT,
      identifier: issue.identifier,
      title: issue.title,
    });
  }
  return { issue, app, bot, svc: () => app.services() };
}

describe("vòng đời: Resolved / Done", () => {
  test("Resolved: báo người báo kèm nút Đã ổn, bot KHÔNG chuyển cột (ADR-0006)", async () => {
    const { issue, bot } = setup();
    h.fake.issues[0]!.columnId = RESOLVED.id;
    await bot.handleEvent(stateChanged(issue, RESOLVED));

    const sent = h.channelLog().filter((r) => r.kind === "state");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: CHAT,
      state: "resolved",
      withReporterOkButton: true,
    });
    expect(sent[0]!.text).toContain(issue.identifier);
    expect(h.fake.issues[0]!.columnId).toBe(RESOLVED.id);
    expect(h.fake.count(/^(PATCH|PUT|DELETE) /)).toBe(0);
  });

  test("webhook Resolved tới lại hoặc đổi sang cột cùng nhóm: không báo lại", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(stateChanged(issue, RESOLVED));
    await bot.handleEvent(stateChanged(issue, RESOLVED));
    expect(h.channelLog().filter((r) => r.kind === "state")).toHaveLength(1);
  });

  test("người báo bấm Đã ổn: chỉ ghi MỘT comment, ticket vẫn ở Resolved, bấm lần hai không ghi thêm", async () => {
    const { issue, bot, svc } = setup();
    h.fake.issues[0]!.columnId = RESOLVED.id;
    await bot.handleEvent(stateChanged(issue, RESOLVED));
    const scoped = h.tracker();

    const first = await svc().closure.recordReporterOk(scoped, {
      issueId: issue.id,
      chatId: CHAT,
      userName: "Anh Minh",
    });
    expect(first.outcome).toBe("recorded");
    const second = await svc().closure.recordReporterOk(scoped, {
      issueId: issue.id,
      chatId: CHAT,
    });
    expect(second.outcome).toBe("already_recorded");

    const ok = h.fake.comments.filter((c) => c.body.includes("phản hồi: đã ổn"));
    expect(ok).toHaveLength(1);
    expect(ok[0]!.body).toContain("Anh Minh");
    expect(h.fake.issues[0]!.columnId).toBe(RESOLVED.id); // bot không sang Done
    expect(h.fake.count(/^(PATCH|PUT|DELETE) /)).toBe(0);
    expect(h.channelLog().filter((r) => r.kind === "clear")).toHaveLength(1); // nút cũ được gỡ
  });

  test("Done (do người xử lý): báo hoàn tất không nút và gỡ nút Đã ổn của tin cũ", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(stateChanged(issue, RESOLVED));
    await bot.handleEvent(stateChanged(issue, DONE));
    const log = h.channelLog();
    expect(log.filter((r) => r.kind === "clear")).toHaveLength(1);
    const last = log.filter((r) => r.kind === "state").at(-1)!;
    expect(last).toMatchObject({ state: "done", withReporterOkButton: false });
    expect(last.text).toContain("hoàn tất");
  });

  test("mở lại sau Resolved: báo người báo, gỡ nút cũ", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(stateChanged(issue, RESOLVED));
    await bot.handleEvent(stateChanged(issue, INPROGRESS));
    const log = h.channelLog();
    expect(log.filter((r) => r.kind === "clear")).toHaveLength(1);
    expect(log.filter((r) => r.kind === "state")).toHaveLength(2);
  });

  test("issue.updated (sửa mô tả, không đổi cột) không báo gì", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent({
      ...stateChanged(issue, RESOLVED),
      event: "issue.updated",
    });
    expect(h.channelLog()).toEqual([]);
  });

  test("ticket chưa có liên kết: im lặng, trừ khi bật sandbox chat", async () => {
    const quiet = setup({}, false);
    await quiet.bot.handleEvent(stateChanged(quiet.issue, RESOLVED));
    expect(h.channelLog()).toEqual([]);
  });

  test("sandbox chat: ticket chưa liên kết được gắn vào chat thử để kênh log có dữ liệu", async () => {
    const { issue, bot, svc } = setup({ TIEULINH_SANDBOX_CHAT: CHAT }, false);
    await bot.handleEvent(commentCreated(issue, "Đã xử lý ở bản 1.2, anh/chị thử lại giúp."));
    const sent = h.channelLog().filter((r) => r.kind === "comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(CHAT);
    expect(svc().bindings.getBindingByIssueId(issue.id)?.identifier).toBe(issue.identifier);
  });
});

describe("chuyển comment về người báo", () => {
  test("policy all: comment của người xử lý tới người báo, ảnh được tách ra, tên người viết kèm theo", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(
      commentCreated(issue, "Đã sửa, thử lại nhé ![](https://img.example.com/a.png)"),
    );
    const sent = h.channelLog().filter((r) => r.kind === "comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      authorName: "Chị Lan",
      images: ["https://img.example.com/a.png"],
    });
    expect(sent[0]!.text).toBe("Đã sửa, thử lại nhé");
  });

  test("gỡ thẻ <mark>/<span> tô màu của editor, giữ nguyên chữ", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(
      commentCreated(
        issue,
        'Đã <mark data-color="#fff">sửa xong</mark> <span style="color: red">lỗi đăng nhập</span>',
      ),
    );
    const sent = h.channelLog().filter((r) => r.kind === "comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("Đã sửa xong lỗi đăng nhập");
  });

  test("policy mention: webhook không chuyển gì; chỉ lời nhắn gọi @agent (qua run mention) tới người báo", async () => {
    const { issue, bot } = setup({ TIEULINH_COMMENT_FORWARD: "mention" });
    await bot.handleEvent(commentCreated(issue, "ghi chú nội bộ, chưa chắc nguyên nhân"));
    await bot.handleEvent(commentCreated(issue, "@tieulinh2 báo anh ấy đã sửa xong"));
    // luật comment bỏ qua comment có @agent: đường duy nhất là run mention
    expect(h.channelLog()).toEqual([]);
    h.llm.script({ text: "Đã nhắn." });
    const run = h.fake.mention(issue.id, "báo anh ấy đã sửa xong");
    await bot.start();
    await until(() => h.fake.run(run.id).status !== "pending");
    const sent = h.channelLog().filter((r) => r.kind === "comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("báo anh ấy đã sửa xong");
  });

  test("TIEULINH_AGENT đổi tên agent: gỡ đúng tên đó khỏi lời nhắn và bỏ qua comment gọi nó ở luật", async () => {
    const { issue, bot } = setup({ TIEULINH_AGENT: "@linh_hau_can" });
    await bot.handleEvent(commentCreated(issue, "@linh_hau_can nhắc anh ấy kiểm tra lại"));
    expect(h.channelLog()).toEqual([]); // đã đi đường mention (không có run trong test này)
    await bot.handleEvent(commentCreated(issue, "@tieulinh2 không phải agent này nữa"));
    expect(h.channelLog().filter((r) => r.kind === "comment")).toHaveLength(1);
  });

  test("comment gắn cờ nội bộ #noibo giữ lại trên tracker", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(commentCreated(issue, "#noibo lỗi do cấu hình cache"));
    expect(h.channelLog()).toEqual([]);
  });

  test("comment do chính bot ghi không dội ngược về người báo (chống echo)", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(commentCreated(issue, markBotComment("Gợi ý nội bộ của bot")));
    expect(h.channelLog()).toEqual([]);
  });

  test("comment do agent gây ra bị engine bỏ qua", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(
      commentCreated(issue, "Em trả lời đây", { actor: { type: "agent", id: "agent-user" } }),
    );
    expect(h.channelLog()).toEqual([]);
  });

  test("cùng một comment giao hai lần (webhook gửi lại với dấu thời gian khác): chỉ một tin", async () => {
    const { issue, bot } = setup();
    await bot.handleEvent(commentCreated(issue, "Đã sửa", { id: 7777 }));
    await bot.handleEvent(commentCreated(issue, "Đã sửa", { id: 7777 }));
    expect(h.channelLog().filter((r) => r.kind === "comment")).toHaveLength(1);
  });
});
