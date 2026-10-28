import { describe, expect, test } from "bun:test";
import { markBotComment } from "../../core/formatting";
import { NotificationDispatcher, type ColumnStateResolverPort } from "./dispatcher";
import type {
  ChannelPort,
  MessageRoute,
  MessageRouteStore,
  NotifyBinding,
  NotifyBindingReader,
  StateChangeCopyMap,
  TicketLifecycleState,
} from "../ports";
import type { ItsaplanWebhookEnvelope } from "../../itsaplan/webhook/events";

interface SentComment {
  binding: NotifyBinding;
  authorName: string;
  text: string;
  images?: string[];
  videos?: string[];
}
interface SentState {
  binding: NotifyBinding;
  message: string;
  state: TicketLifecycleState;
  withReporterOkButton: boolean;
}

function makeChannel() {
  const comments: SentComment[] = [];
  const states: SentState[] = [];
  let nextId = 1000;
  const port: ChannelPort = {
    channelType: "telegram",
    async sendComment(i) {
      comments.push(i);
      return nextId++;
    },
    async sendStateChange(i) {
      states.push(i);
      return nextId++;
    },
  };
  return { port, comments, states };
}

function makeRoutes() {
  const saved: MessageRoute[] = [];
  const store: MessageRouteStore = {
    saveMessageRoute(r) {
      saved.push({ ...r });
    },
    getMessageRoute() {
      return null;
    },
  };
  return { store, saved };
}

function bindingReader(binding: NotifyBinding | null): NotifyBindingReader {
  return { getBindingByIssueId: () => binding };
}

const copy: StateChangeCopyMap = {
  describe: ({ state, columnName }) =>
    state === "resolved"
      ? `Ticket của anh/chị đã được xử lý (${columnName}).`
      : state === "done"
        ? `Ticket đã hoàn tất (${columnName}).`
        : null,
};

const columns = (
  map: Record<number, { state: TicketLifecycleState; columnName: string }>,
): ColumnStateResolverPort => ({
  async stateOf({ columnId }) {
    return map[columnId] ?? null;
  },
});

const TECH_BINDING: NotifyBinding = {
  issueId: 7,
  identifier: "TECH-7",
  chatId: "123",
  channelType: "telegram",
};

function commentEvent(body: string, over: Partial<any> = {}): ItsaplanWebhookEnvelope {
  return {
    action: "create",
    type: "Comment",
    event: "comment.created",
    data: { issueId: 7, id: 1, body, ...over },
    actor: { type: "human", name: "Anh KTV" },
    createdAt: "",
    webhookTimestamp: 1,
  };
}

describe("NotificationDispatcher — comments", () => {
  test("human comment is forwarded and a comment route is recorded (fd48c6e)", async () => {
    const ch = makeChannel();
    const routes = makeRoutes();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: routes.store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent(commentEvent("Anh đã khắc phục, nhờ kiểm tra lại ạ."));
    expect(ch.comments).toHaveLength(1);
    expect(ch.comments[0].text).toContain("khắc phục");
    expect(ch.comments[0].authorName).toBe("Anh KTV");
    expect(routes.saved).toHaveLength(1);
    expect(routes.saved[0]).toMatchObject({ issueId: 7, identifier: "TECH-7", kind: "comment" });
  });

  test("thiếu binding → KHÔNG gửi và CÓ log cảnh báo (bug OP: worker trỏ nhầm DB)", async () => {
    const { setLogger, getLogger } = await import("../../core/index");
    const prev = getLogger();
    const warns: string[] = [];
    setLogger({ ...prev, warn: (m: string) => warns.push(m) } as any);
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(null), // không có binding cho issue
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    try {
      await d.handleEvent(commentEvent("@op đã khắc phục rồi nhé"));
      expect(ch.comments).toHaveLength(0); // không gửi
      expect(warns.some((w) => w.includes("KHÔNG có binding") && w.includes("DB"))).toBe(true);
    } finally {
      setLogger(prev);
    }
  });

  test("bot comment is skipped (echo loop guard, isBotComment)", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent(commentEvent(markBotComment("tin do bot ghi")));
    expect(ch.comments).toHaveLength(0);
  });

  test("echo từ chính Telegram (comment mang dấu '(Telegram') không dội lại người báo", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent(commentEvent("Tin nhắn người dùng (Telegram)"));
    expect(ch.comments).toHaveLength(0);
  });

  test("tag-only mode (4cea3c9): untagged comment is NOT forwarded", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
      commentForwardPolicy: "mention",
      agentHandles: ["iris"],
    });
    await d.handleEvent(commentEvent("ghi chú nội bộ, không tag ai"));
    expect(ch.comments).toHaveLength(0);
    // but a tagged one IS forwarded, with the tag stripped
    await d.handleEvent(commentEvent("@iris nhờ báo người dùng kiểm tra lại"));
    expect(ch.comments).toHaveLength(1);
    expect(ch.comments[0].text).not.toContain("@iris");
  });

  test("internal-marker comment stays on the tracker", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent(commentEvent("#noibo chỉ đội kỹ thuật đọc"));
    expect(ch.comments).toHaveLength(0);
  });

  test("#nhac_nho và [nhắc nhở] comment cũng được giữ lại, không bắn về người báo", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent(commentEvent("#nhac_nho @support kiểm tra lại đơn này gấp"));
    await d.handleEvent(commentEvent("[nhắc nhở] quá hạn 30 phút"));
    expect(ch.comments).toHaveLength(0);
  });

  test("wrong-project event is skipped (project-lock, 837fb08)", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader({ ...TECH_BINDING, identifier: "PO-7" }),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent(commentEvent("comment on a PO ticket"));
    expect(ch.comments).toHaveLength(0);
  });

  test("comment.updated (edit/pin) does not re-notify", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
    });
    await d.handleEvent({ ...commentEvent("sửa comment"), event: "comment.updated" });
    expect(ch.comments).toHaveLength(0);
  });
});

describe("NotificationDispatcher — media và văn bản (parity legacy)", () => {
  const make = (extra: { webUrl?: string } = {}) => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
      ...extra,
    });
    return { ch, d };
  };

  test("comment CHỈ có video vẫn được chuyển, kèm danh sách video", async () => {
    const { ch, d } = make({ webUrl: "https://itsaplan.example.com" });
    await d.handleEvent(commentEvent('<video src="/uploads/a.mp4" controls></video>'));
    expect(ch.comments).toHaveLength(1);
    expect(ch.comments[0]).toMatchObject({
      text: "",
      videos: ["https://itsaplan.example.com/uploads/a.mp4"],
    });
  });

  test("attachments của payload (chuỗi hoặc { url }) được chuyển như ảnh, khử trùng với markdown", async () => {
    const { ch, d } = make({ webUrl: "https://itsaplan.example.com/" });
    await d.handleEvent(
      commentEvent("xem ![](https://img.example.com/a.png)", {
        attachments: [
          "https://img.example.com/a.png",
          { url: "/files/b.png" },
          { name: "x" },
          null,
        ],
      }),
    );
    expect(ch.comments[0]!.images).toEqual([
      "https://img.example.com/a.png",
      "https://itsaplan.example.com/files/b.png",
    ]);
    expect(ch.comments[0]!.text).toBe("xem");
  });

  test("comment chỉ có attachment (không chữ) vẫn được chuyển", async () => {
    const { ch, d } = make({ webUrl: "https://itsaplan.example.com" });
    await d.handleEvent(commentEvent("", { attachments: [{ url: "/files/b.png" }] }));
    expect(ch.comments).toHaveLength(1);
    expect(ch.comments[0]!.images).toEqual(["https://itsaplan.example.com/files/b.png"]);
  });

  test("link localhost/127.0.0.1 và link tương đối được viết lại về webUrl; link ngoài giữ nguyên", async () => {
    const { ch, d } = make({ webUrl: "https://itsaplan.example.com" });
    await d.handleEvent(
      commentEvent(
        [
          "![](http://127.0.0.1:3000/uploads/1.png)",
          "![](http://localhost/uploads/2.png)",
          "![](uploads/3.png)",
          "![](https://cdn.example.com/4.png)",
          "![](http://localhost.evil.example.com/5.png)",
        ].join(" "),
      ),
    );
    expect(ch.comments[0]!.images).toEqual([
      "https://itsaplan.example.com/uploads/1.png",
      "https://itsaplan.example.com/uploads/2.png",
      "https://itsaplan.example.com/uploads/3.png",
      "https://cdn.example.com/4.png",
      "http://localhost.evil.example.com/5.png",
    ]);
  });

  test("HTML entities được giải mã một lần ở văn bản và tên người viết", async () => {
    const { ch, d } = make();
    await d.handleEvent({
      ...commentEvent("UID &lt; 900016 &amp;lt; &gt;= 3"),
      actor: { type: "human", name: "Tom &amp; Jerry" },
    });
    expect(ch.comments[0]!.text).toBe("UID < 900016 &lt; >= 3");
    expect(ch.comments[0]!.authorName).toBe("Tom & Jerry");
  });

  test("chế độ mention: comment chỉ có video mà không gắn thẻ bot thì KHÔNG chuyển", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      projectKey: "TECH",
      commentForwardPolicy: "mention",
      agentHandles: ["tieulinh"],
    });
    await d.handleEvent(commentEvent('<video src="https://v.example.com/a.mp4"></video>'));
    expect(ch.comments).toHaveLength(0);
  });
});

describe("NotificationDispatcher — state changes (ADR-0006)", () => {
  function stateEvent(columnId: number): ItsaplanWebhookEnvelope {
    return {
      action: "update",
      type: "Issue",
      event: "issue.state_changed",
      data: { id: 7, identifier: "TECH-7", columnId },
      createdAt: "",
      webhookTimestamp: 2,
    };
  }

  test("resolved → message sent WITH the OK button; state route recorded", async () => {
    const ch = makeChannel();
    const routes = makeRoutes();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: routes.store,
      channel: ch.port,
      copy,
      columns: columns({ 29: { state: "resolved", columnName: "Đã xử lý" } }),
      projectKey: "TECH",
    });
    await d.handleEvent(stateEvent(29));
    expect(ch.states).toHaveLength(1);
    expect(ch.states[0].withReporterOkButton).toBe(true);
    expect(ch.states[0].message).toContain("đã được xử lý");
    expect(routes.saved[0]).toMatchObject({ kind: "state", identifier: "TECH-7" });
  });

  test("done → message sent WITHOUT a button", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      columns: columns({ 40: { state: "done", columnName: "Hoàn tất" } }),
      projectKey: "TECH",
    });
    await d.handleEvent(stateEvent(40));
    expect(ch.states).toHaveLength(1);
    expect(ch.states[0].withReporterOkButton).toBe(false);
    expect(ch.states[0].state).toBe("done");
  });

  test("copy map returns null (e.g. an 'open' column) → nothing sent", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      columns: columns({ 10: { state: "open", columnName: "Mới" } }),
      projectKey: "TECH",
    });
    await d.handleEvent(stateEvent(10));
    expect(ch.states).toHaveLength(0);
  });

  test("unknown column → nothing sent", async () => {
    const ch = makeChannel();
    const d = new NotificationDispatcher({
      bindings: bindingReader(TECH_BINDING),
      routes: makeRoutes().store,
      channel: ch.port,
      copy,
      columns: columns({}),
      projectKey: "TECH",
    });
    await d.handleEvent(stateEvent(999));
    expect(ch.states).toHaveLength(0);
  });
});
