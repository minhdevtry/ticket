import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../lib/storage/schema";
import { TicketBindingRepository } from "../lib/storage/binding-repository";
import { ProjectColumnStates } from "@vuihoc/bot-core/itsaplan";
import type { ItsaplanClient, ProjectColumn } from "@vuihoc/bot-core/itsaplan";
import type { Notifier } from "./notifier";
import type { TicketState } from "@vuihoc/bot-core/itsaplan";
import { TicketClosure } from "./ticket-closure";

// Cột THẬT của TECH (tra 24/09/2026): Resolved nằm nhóm completed, cạnh Done.
const col = (id: number, name: string, stateType: ProjectColumn["stateType"]): ProjectColumn => ({
  id,
  name,
  stateType,
  position: id,
});
const TECH = [
  col(1, "Backlog", "backlog"),
  col(3, "In Progress", "started"),
  col(6, "Resolved", "completed"),
  col(4, "Done", "completed"),
  col(5, "Canceled", "canceled"),
];
const IN_PROGRESS = 3;
const RESOLVED = 6;
const DONE = 4;

function fakeNotifier() {
  const sent: Array<{ identifier: string; label: string; state: TicketState }> = [];
  const cleared: string[] = [];
  let nextId = 900;
  const notifier: Notifier = {
    channelType: "telegram",
    notifyComment: async () => undefined,
    notifyStateChange: async (binding, label, state) => {
      sent.push({ identifier: binding.identifier, label, state });
      return nextId++;
    },
    clearInteractiveButtons: async (_binding, messageId) => {
      cleared.push(messageId);
    },
    broadcastAlert: async () => {},
  };
  return { notifier, sent, cleared };
}

function fakeItsaplan() {
  const comments: Array<{ issueId: number; body: string }> = [];
  const moves: unknown[] = [];
  const columnOf = new Map<number, number>();
  const assigneeOf = new Map<number, string>();
  const client = {
    listProjectColumns: async () => TECH,
    getProject: async () => ({
      id: 1,
      key: "TECH",
      assignees: [{ userId: "u-techlead-a", username: "techlead_a" }],
    }),
    addComment: async (issueId: number, body: string) => {
      comments.push({ issueId, body });
      return { id: 1, body };
    },
    getIssue: async (issueId: number) => ({
      id: issueId,
      identifier: `TECH-${issueId}`,
      columnId: columnOf.get(issueId),
      assigneeUserId: assigneeOf.get(issueId),
    }),
    updateIssue: async (...args: unknown[]) => {
      moves.push(args);
      return {};
    },
  };
  return {
    client: client as unknown as ItsaplanClient,
    comments,
    moves,
    setColumn: (issueId: number, columnId: number) => columnOf.set(issueId, columnId),
    setAssignee: (issueId: number, userId: string) => assigneeOf.set(issueId, userId),
  };
}

describe("TicketClosure — chỉ người xử lý đóng ticket (ADR-0006)", () => {
  let db: Database;
  let bindings: TicketBindingRepository;
  let n: ReturnType<typeof fakeNotifier>;
  let it$: ReturnType<typeof fakeItsaplan>;
  let doneEvents: string[];
  let closure: TicketClosure;

  const CHAT = "5551234";

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    bindings = new TicketBindingRepository(db);
    bindings.saveBinding({
      issueId: 42,
      identifier: "TECH-42",
      channelType: "telegram",
      chatId: CHAT,
      messageId: "1",
    });
    n = fakeNotifier();
    it$ = fakeItsaplan();
    doneEvents = [];
    closure = new TicketClosure({
      db,
      columns: new ProjectColumnStates(it$.client),
      bindings,
      notifiers: new Map([["telegram", n.notifier]]),
      itsaplan: it$.client,
      projectKey: "TECH",
      onTicketDone: async (_id, identifier) => {
        doneEvents.push(identifier);
      },
    });
  });

  const move = (columnId: number) => {
    it$.setColumn(42, columnId);
    return closure.onColumnChanged({ issueId: 42, identifier: "TECH-42", columnId });
  };

  it("sang Resolved: báo người báo (kèm nút Đã ổn phía notifier), không tự chuyển Done, chưa nạp tri thức", async () => {
    expect(await move(RESOLVED)).toBe("resolved");
    expect(n.sent).toEqual([
      { identifier: "TECH-42", label: expect.any(String), state: "resolved" },
    ]);
    expect(it$.moves).toHaveLength(0);
    expect(doneEvents).toHaveLength(0);
  });

  it("Resolved → Done: báo hoàn tất (không nút), gỡ nút Đã ổn cũ, phát hoàn tất đúng một lần dù webhook lặp", async () => {
    await move(RESOLVED);
    const promptId = String(900);
    await move(DONE);
    await move(DONE); // issue.updated bắn kèm state_changed cho cùng một lần kéo
    expect(n.sent.map((x) => x.state)).toEqual(["resolved", "done"]);
    expect(n.cleared).toEqual([promptId]);
    expect(doneEvents).toEqual(["TECH-42"]);
    expect(it$.moves).toHaveLength(0);
  });

  it("người xử lý kéo thẳng In Progress → Done: vẫn là hoàn tất", async () => {
    await move(IN_PROGRESS);
    await move(DONE);
    expect(n.sent.map((x) => x.state)).toEqual(["open", "done"]);
    expect(doneEvents).toEqual(["TECH-42"]);
  });

  it("mở lại rồi đóng lại: mỗi lần đóng phát hoàn tất một lần", async () => {
    await move(DONE);
    await move(IN_PROGRESS);
    await move(DONE);
    expect(doneEvents).toEqual(["TECH-42", "TECH-42"]);
  });

  it("ticket dự án khác không đụng tới (ADR-0001)", async () => {
    const r = await closure.onColumnChanged({ issueId: 77, identifier: "PO-77", columnId: DONE });
    expect(r).toBeNull();
    expect(n.sent).toHaveLength(0);
    expect(doneEvents).toHaveLength(0);
  });

  // Spec Q13: ticket có từ trước deploy không được báo lại. Sửa mô tả/gán người bắn
  // issue.updated (không phải đổi cột) — lần đầu thấy thì chỉ ghi lại, im lặng.
  it("issue.updated đầu tiên của ticket chưa từng thấy: chỉ ghi trạng thái, không báo, không phát hoàn tất", async () => {
    it$.setColumn(42, DONE);
    await closure.onColumnChanged({
      issueId: 42,
      identifier: "TECH-42",
      columnId: DONE,
      columnChanged: false,
    });
    it$.setColumn(42, DONE);
    await closure.onColumnChanged({
      issueId: 42,
      identifier: "TECH-42",
      columnId: DONE,
      columnChanged: false,
    });
    expect(n.sent).toHaveLength(0);
    expect(doneEvents).toHaveLength(0);
  });

  it("ticket có từ trước deploy, sau đó thật sự đổi cột: báo và phát hoàn tất bình thường", async () => {
    await closure.onColumnChanged({
      issueId: 42,
      identifier: "TECH-42",
      columnId: RESOLVED,
      columnChanged: false,
    });
    await closure.onColumnChanged({
      issueId: 42,
      identifier: "TECH-42",
      columnId: DONE,
      columnChanged: true,
    });
    expect(n.sent.map((x) => x.state)).toEqual(["done"]);
    expect(doneEvents).toEqual(["TECH-42"]);
  });

  it("ticket đang chờ trong resolved_tickets cũ: nút cũ vẫn được gỡ khi hoàn tất", async () => {
    const legacy = new Database(":memory:");
    legacy.run(`CREATE TABLE resolved_tickets (issue_id INTEGER PRIMARY KEY, identifier TEXT NOT NULL, project_key TEXT NOT NULL,
      channel_type TEXT NOT NULL, chat_id TEXT NOT NULL, prompt_message_id TEXT, resolved_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_confirmation')`);
    legacy.run(
      `INSERT INTO resolved_tickets VALUES (42, 'TECH-42', 'TECH', 'telegram', '${CHAT}', '777', 1, 'pending_confirmation')`,
    );
    applySchema(legacy);
    const b = new TicketBindingRepository(legacy);
    b.saveBinding({
      issueId: 42,
      identifier: "TECH-42",
      channelType: "telegram",
      chatId: CHAT,
      messageId: "1",
    });
    const c = new TicketClosure({
      db: legacy,
      columns: new ProjectColumnStates(it$.client),
      bindings: b,
      notifiers: new Map([["telegram", n.notifier]]),
      itsaplan: it$.client,
      projectKey: "TECH",
    });
    await c.onColumnChanged({ issueId: 42, identifier: "TECH-42", columnId: DONE });
    expect(n.cleared).toEqual(["777"]);
  });

  it("Telegram lỗi khi báo: trạng thái vẫn được ghi, vẫn phát hoàn tất, lần sau không báo lại", async () => {
    n.notifier.notifyStateChange = async () => {
      throw new Error("Telegram 502");
    };
    await move(DONE);
    await move(DONE);
    expect(doneEvents).toEqual(["TECH-42"]);
  });

  it("ticket không có liên kết chat vẫn phát hoàn tất (nạp tri thức), chỉ là không báo ai", async () => {
    await closure.onColumnChanged({ issueId: 43, identifier: "TECH-43", columnId: DONE });
    expect(n.sent).toHaveLength(0);
    expect(doneEvents).toEqual(["TECH-43"]);
  });
});

describe("TicketClosure — phản hồi đã ổn", () => {
  let db: Database;
  let bindings: TicketBindingRepository;
  let n: ReturnType<typeof fakeNotifier>;
  let it$: ReturnType<typeof fakeItsaplan>;
  let doneEvents: string[];
  let closure: TicketClosure;
  const CHAT = "5551234";

  beforeEach(async () => {
    db = new Database(":memory:");
    applySchema(db);
    bindings = new TicketBindingRepository(db);
    bindings.saveBinding({
      issueId: 42,
      identifier: "TECH-42",
      channelType: "telegram",
      chatId: `telegram:${CHAT}`,
      messageId: "1",
    });
    n = fakeNotifier();
    it$ = fakeItsaplan();
    doneEvents = [];
    closure = new TicketClosure({
      db,
      columns: new ProjectColumnStates(it$.client),
      bindings,
      notifiers: new Map([["telegram", n.notifier]]),
      itsaplan: it$.client,
      projectKey: "TECH",
      onTicketDone: async (_id, identifier) => {
        doneEvents.push(identifier);
      },
      now: () => Date.UTC(2026, 8, 24, 3, 5), // 10:05 giờ VN
    });
    it$.setColumn(42, RESOLVED);
    await closure.onColumnChanged({ issueId: 42, identifier: "TECH-42", columnId: RESOLVED });
  });

  it("bấm khi đang Resolved: ghi comment kèm tên, gỡ nút, ticket KHÔNG đổi trạng thái", async () => {
    const r = await closure.recordReporterOk({ issueId: 42, chatId: CHAT, userName: "Chị A" });
    expect(r.outcome).toBe("recorded");
    expect(r.replyText).toContain("chuyên viên sẽ kiểm tra");
    expect(it$.comments).toHaveLength(1);
    expect(it$.comments[0].body).toContain("Chị A");
    expect(it$.comments[0].body).toContain("đã ổn (10:05 24/09)");
    expect(n.cleared).toEqual(["900"]);
    expect(it$.moves).toHaveLength(0);
    expect(doneEvents).toHaveLength(0);
  });

  it("bấm lần hai: không thêm comment", async () => {
    await closure.recordReporterOk({ issueId: 42, chatId: CHAT, userName: "Chị A" });
    const again = await closure.recordReporterOk({ issueId: 42, chatId: CHAT, userName: "Chị A" });
    expect(again.outcome).toBe("already_recorded");
    expect(it$.comments).toHaveLength(1);
  });

  it("bấm từ chat khác (không có liên kết chat với ticket): bỏ qua, không comment", async () => {
    const r = await closure.recordReporterOk({ issueId: 42, chatId: "999", userName: "Lạ" });
    expect(r.outcome).toBe("not_bound");
    expect(it$.comments).toHaveLength(0);
  });

  it("bấm khi ticket đã hoàn tất / bị kéo lại: chỉ trả lời đúng tình trạng", async () => {
    it$.setColumn(42, DONE);
    expect((await closure.recordReporterOk({ issueId: 42, chatId: CHAT })).outcome).toBe("done");
    it$.setColumn(42, IN_PROGRESS);
    expect((await closure.recordReporterOk({ issueId: 42, chatId: CHAT })).outcome).toBe(
      "reopened",
    );
    expect(it$.comments).toHaveLength(0);
  });

  it("ticket không biết: trả lời không tìm thấy", async () => {
    expect((await closure.recordReporterOk({ issueId: 5, chatId: CHAT })).outcome).toBe("unknown");
  });
});

describe("TicketClosure — phản hồi tự do (reply vào tin thông báo, spec C4)", () => {
  let db: Database;
  let bindings: TicketBindingRepository;
  let n: ReturnType<typeof fakeNotifier>;
  let it$: ReturnType<typeof fakeItsaplan>;
  let closure: TicketClosure;
  const CHAT = "5551234";

  beforeEach(async () => {
    db = new Database(":memory:");
    applySchema(db);
    bindings = new TicketBindingRepository(db);
    // chat_id ghi lúc tạo binding có tiền tố "telegram:" — model có khi chép
    // nguyên chat_id trong phong bì; recordReporterReply phải chịu được cả hai dạng.
    bindings.saveBinding({
      issueId: 42,
      identifier: "TECH-42",
      channelType: "telegram",
      chatId: `telegram:${CHAT}`,
      messageId: "1",
    });
    n = fakeNotifier();
    it$ = fakeItsaplan();
    closure = new TicketClosure({
      db,
      columns: new ProjectColumnStates(it$.client),
      bindings,
      notifiers: new Map([["telegram", n.notifier]]),
      itsaplan: it$.client,
      projectKey: "TECH",
      now: () => Date.UTC(2026, 8, 28, 3, 5), // 10:05 giờ VN
    });
    // Ticket sang Resolved → notify() ghi message_route cho tin "đã xử lý" (900).
    it$.setColumn(42, RESOLVED);
    await closure.onColumnChanged({ issueId: 42, identifier: "TECH-42", columnId: RESOLVED });
  });

  it("reply đúng tin route (chatId gọn, không tiền tố) → ghi comment, KHÔNG đổi trạng thái", async () => {
    const r = await closure.recordReporterReply({
      chatId: CHAT,
      messageId: "900",
      text: "vẫn chưa được ạ, lỗi y như cũ",
      userName: "Chị A",
    });
    expect(r.handled).toBe(true);
    expect(r.handled && r.replyText).toContain("TECH-42");
    expect(it$.comments).toHaveLength(1);
    expect(it$.comments[0].body).toContain("Chị A");
    expect(it$.comments[0].body).toContain("vẫn chưa được ạ, lỗi y như cũ");
    expect(it$.comments[0].body).toContain("<!-- intake-bot -->");
    expect(it$.moves).toHaveLength(0);
  });

  it("chatId có tiền tố telegram: (dạng khác) vẫn khớp được route", async () => {
    const r = await closure.recordReporterReply({
      chatId: `telegram:${CHAT}`,
      messageId: "900",
      text: "chưa ổn ạ",
    });
    expect(r.handled).toBe(true);
  });

  it("messageId không khớp route đã biết → handled:false, không ghi comment", async () => {
    const r = await closure.recordReporterReply({
      chatId: CHAT,
      messageId: "999999",
      text: "chưa ổn ạ",
    });
    expect(r).toEqual({ handled: false });
    expect(it$.comments).toHaveLength(0);
  });

  it("ticket dự án khác (worker không sở hữu) → handled:false", async () => {
    bindings.saveMessageRoute("777", "telegram", 99, "PO-5", CHAT);
    const r = await closure.recordReporterReply({
      chatId: CHAT,
      messageId: "777",
      text: "chưa ổn ạ",
    });
    expect(r).toEqual({ handled: false });
    expect(it$.comments).toHaveLength(0);
  });

  it("không có userName → dùng 'Người báo'", async () => {
    await closure.recordReporterReply({ chatId: CHAT, messageId: "900", text: "chưa ổn ạ" });
    expect(it$.comments[0].body).toContain("Người báo");
  });

  it("ticket đã sang Done → từ chối bổ sung, không ghi comment, bảo tạo ticket mới", async () => {
    it$.setColumn(42, DONE);
    const r = await closure.recordReporterReply({
      chatId: CHAT,
      messageId: "900",
      text: "vẫn chưa được ạ",
    });
    expect(r.handled).toBe(true);
    expect(r.handled && r.replyText).toContain("đã đóng");
    expect(r.handled && r.replyText).toContain("tạo ticket mới");
    expect(it$.comments).toHaveLength(0);
  });

  it("ticket có assignee → ghi comment có mention @assignee đúng cú pháp (cc @username)", async () => {
    it$.setAssignee(42, "u-techlead-a");
    const r = await closure.recordReporterReply({
      chatId: CHAT,
      messageId: "900",
      text: "em gửi thêm thông tin",
    });
    expect(r.handled).toBe(true);
    expect(it$.comments).toHaveLength(1);
    expect(it$.comments[0].body).toContain("(cc @techlead_a)");
    expect(it$.comments[0].body).not.toContain("(cc @techlead_a))");
  });

  it("dự án PO (Iris): ticket đóng không bị từ chối và không gắn mention cc", async () => {
    const PO = [
      col(7, "Backlog", "backlog"),
      col(10, "Golive", "completed"),
      col(11, "Canceled", "canceled"),
    ];
    const poComments: Array<{ issueId: number; body: string }> = [];
    const poClient = {
      ...(it$.client as unknown as Record<string, unknown>),
      listProjectColumns: async () => PO,
      getIssue: async (issueId: number) => ({
        id: issueId,
        identifier: `PO-${issueId}`,
        columnId: 10,
        stateType: "completed",
        assigneeUserId: "u-techlead-a",
      }),
      getProject: async () => ({
        id: 2,
        key: "PO",
        assignees: [{ userId: "u-techlead-a", username: "techlead_a" }],
      }),
      addComment: async (issueId: number, body: string) => {
        poComments.push({ issueId, body });
        return { id: 1, body };
      },
    } as unknown as ItsaplanClient;

    const poBindings = new TicketBindingRepository(db);
    poBindings.saveBinding({
      issueId: 79,
      identifier: "PO-79",
      channelType: "telegram",
      chatId: CHAT,
      messageId: "1",
    });
    poBindings.saveMessageRoute("905", "telegram", 79, "PO-79", CHAT);

    const poClosure = new TicketClosure({
      db,
      columns: new ProjectColumnStates(poClient),
      bindings: poBindings,
      notifiers: new Map([["telegram", n.notifier]]),
      itsaplan: poClient,
      projectKey: "PO",
    });

    const r = await poClosure.recordReporterReply({
      chatId: CHAT,
      messageId: "905",
      text: "Phản hồi thêm cho tính năng",
    });
    expect(r.handled).toBe(true);
    expect(r.handled && r.replyText).not.toContain("đã đóng");
    expect(poComments).toHaveLength(1);
    expect(poComments[0].body).toContain("Phản hồi thêm cho tính năng");
    expect(poComments[0].body).not.toContain("cc @");
  });

  it("dự án PO: báo đúng lời giải thích của từng cột (PO 01/10), 'PO Done' không bị báo là 'hoàn tất'", async () => {
    const PO = [
      col(7, "Backlog", "backlog"),
      col(8, "Discussion", "unstarted"),
      col(23, "PO Done", "started"),
      col(10, "Golive", "completed"),
      col(11, "Canceled", "canceled"),
    ];
    const poClient = {
      ...(it$.client as any),
      listProjectColumns: async () => PO,
    } as unknown as ItsaplanClient;
    const poBindings = new TicketBindingRepository(db);
    poBindings.saveBinding({
      issueId: 79,
      identifier: "PO-79",
      channelType: "telegram",
      chatId: CHAT,
      messageId: "1",
    });
    const poClosure = new TicketClosure({
      db,
      columns: new ProjectColumnStates(poClient),
      bindings: poBindings,
      notifiers: new Map([["telegram", n.notifier as any]]),
      itsaplan: poClient,
      projectKey: "PO",
    });
    const exact: boolean[] = [];
    const orig = n.notifier.notifyStateChange!;
    n.notifier.notifyStateChange = async (b, label, state, e) => {
      exact.push(Boolean(e));
      return orig(b, label, state, e);
    };
    await poClosure.onColumnChanged({ issueId: 79, identifier: "PO-79", columnId: 8 });
    await poClosure.onColumnChanged({ issueId: 79, identifier: "PO-79", columnId: 23 });
    expect(n.sent.filter((x) => x.identifier === "PO-79").map((x) => x.label)).toEqual([
      "Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)",
      "PO done (đã làm xong giải pháp)",
    ]);
    expect(exact).toEqual([true, true]);
  });
});
