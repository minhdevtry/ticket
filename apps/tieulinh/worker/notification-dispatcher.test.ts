import { describe, expect, test, mock } from "bun:test";
import { NotificationDispatcher } from "./notification-dispatcher";
import type { TicketBinding, TicketBindingRepository } from "../lib/storage/binding-repository";
import type { Notifier } from "./notifier";
import type { ItsaplanWebhookEnvelope } from "./webhook-server";

const HANDLES = ["bot-ticket-intake", "vhticket_bot", "intake-bot", "intake"];

describe("NotificationDispatcher.extractReporterMessage (chế độ `mention`)", () => {
  const dispatcher = new NotificationDispatcher(
    {} as any,
    { agentHandles: HANDLES, commentForwardPolicy: "mention" },
  );

  test("matches handle at the beginning of comment", () => {
    const result = dispatcher.extractReporterMessage(
      "@bot-ticket-intake Anh/chị cho xin lại mã phòng học với ạ",
    );
    expect(result.isCallToReporter).toBe(true);
    expect(result.cleanText).toBe("Anh/chị cho xin lại mã phòng học với ạ");
  });

  test("matches handle with colon or hyphen suffix", () => {
    const res1 = dispatcher.extractReporterMessage("@vhticket_bot: Vui lòng gửi ảnh lỗi");
    expect(res1.isCallToReporter).toBe(true);
    expect(res1.cleanText).toBe("Vui lòng gửi ảnh lỗi");

    const res2 = dispatcher.extractReporterMessage("@intake-bot - Bên em đang kiểm tra");
    expect(res2.isCallToReporter).toBe(true);
    expect(res2.cleanText).toBe("Bên em đang kiểm tra");
  });

  test("matches handle embedded within text", () => {
    const result = dispatcher.extractReporterMessage(
      "Nhờ @bot-ticket-intake hỏi phụ huynh số điện thoại giúp mình",
    );
    expect(result.isCallToReporter).toBe(true);
    expect(result.cleanText).toBe("Nhờ hỏi phụ huynh số điện thoại giúp mình");
  });

  test("matches longer handle before shorter prefix", () => {
    // Both "intake-bot" and "intake" are in agentHandles.
    // "@intake-bot" must match "intake-bot" and strip it cleanly, not match "intake" and leave "-bot".
    const result = dispatcher.extractReporterMessage("@intake-bot kiểm tra giúp em");
    expect(result.isCallToReporter).toBe(true);
    expect(result.cleanText).toBe("kiểm tra giúp em");
  });

  test("does not match when handle is only a prefix of a different user", () => {
    // "@intake-bot-v2" should not trigger if only "@intake-bot" is registered
    const result = dispatcher.extractReporterMessage("@intake-bot-v2 kiểm tra giúp em");
    expect(result.isCallToReporter).toBe(false);
    expect(result.cleanText).toBe("@intake-bot-v2 kiểm tra giúp em");
  });

  test("ignores internal comments without bot tag", () => {
    const result = dispatcher.extractReporterMessage(
      "@TE_UserC anh kiểm tra lại cấu hình DB giúp em nhé",
    );
    expect(result.isCallToReporter).toBe(false);
    expect(result.cleanText).toBe("@TE_UserC anh kiểm tra lại cấu hình DB giúp em nhé");
  });
});

/**
 * Mặc định từ 17/09/2026. Cổng `@handle` từng chặn 15/15 comment trên PO — team
 * Product không gõ tag, nên người đóng góp chưa từng nhận được một phản hồi nào.
 */
describe("NotificationDispatcher.extractReporterMessage (chế độ `all`, mặc định)", () => {
  const dispatcher = new NotificationDispatcher({} as any, { agentHandles: HANDLES });

  test("đẩy comment không tag ai", () => {
    const result = dispatcher.extractReporterMessage("Bên em đã tiếp nhận, tuần sau sẽ có bản demo nhé");
    expect(result.isCallToReporter).toBe(true);
    expect(result.cleanText).toBe("Bên em đã tiếp nhận, tuần sau sẽ có bản demo nhé");
  });

  test("có tag thì vẫn gỡ tag ra khỏi câu gửi đi", () => {
    const result = dispatcher.extractReporterMessage("@intake-bot Bên em đang kiểm tra");
    expect(result.isCallToReporter).toBe(true);
    expect(result.cleanText).toBe("Bên em đang kiểm tra");
  });

  test("tag người khác thì giữ nguyên câu, vẫn đẩy", () => {
    const result = dispatcher.extractReporterMessage("@TE_UserC anh xem giúp em với");
    expect(result.isCallToReporter).toBe(true);
    expect(result.cleanText).toBe("@TE_UserC anh xem giúp em với");
  });

  test("cờ nội bộ thì giữ lại trên tracker", () => {
    expect(dispatcher.isInternalComment("#noibo bàn nội bộ đã nhé")).toBe(true);
    expect(dispatcher.isInternalComment("[Nội bộ] chưa báo khách")).toBe(true);
    expect(dispatcher.isInternalComment("Bên em đã tiếp nhận ạ")).toBe(false);
  });
});

describe("NotificationDispatcher.handleWebhook", () => {
  function createMockBindingRepo(binding?: TicketBinding | null): TicketBindingRepository {
    return {
      getBindingByIssueId: mock(() => binding ?? null),
      saveMessageRoute: mock(() => {}),
    } as unknown as TicketBindingRepository;
  }

  function createMockAdapter(): Notifier {
    return {
      channelType: "telegram",
      notifyComment: mock(async () => "msg-123"),
      notifyStateChange: mock(async () => "msg-124"),
    } as unknown as Notifier;
  }

  test("dispatches comment to telegram adapter when tagged", async () => {
    const binding: TicketBinding = {
      issueId: 101,
      channelType: "telegram",
      chatId: "987654321",
      messageId: "1001",
      identifier: "TECH-101",
      title: "Lỗi phòng học",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const repo = createMockBindingRepo(binding);
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(repo, { agentHandles: ["vhticket_bot"] });
    dispatcher.registerBot(adapter);

    const webhook: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 101,
        body: "@vhticket_bot Đã restart server phòng học, anh/chị vào lại nhé",
        author: { name: "KTV Nam" },
      },
    };

    await dispatcher.handleWebhook(webhook);

    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);
    expect(adapter.notifyComment).toHaveBeenCalledWith(
      binding,
      "KTV Nam",
      "Đã restart server phòng học, anh/chị vào lại nhé",
    );
  });

  function bindingFor(issueId: number, identifier: string): TicketBinding {
    return {
      issueId,
      channelType: "telegram",
      chatId: "987654321",
      messageId: String(issueId),
      identifier,
      title: "Bản ghi thử",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function commentEvent(issueId: number, body: string): ItsaplanWebhookEnvelope {
    return {
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: { issueId, body, author: { name: "Chị Product" } },
    };
  }

  /**
   * Mặc định mới 17/09/2026. Log 12/09→17/09: 15/15 comment trên PO bị cổng
   * `@iris` chặn, người đóng góp chưa từng nhận được phản hồi nào.
   */
  test("đẩy comment không tag ai về người báo", async () => {
    const binding = bindingFor(201, "PO-79");
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(binding), {
      agentHandles: ["iris"],
    });
    dispatcher.registerBot(adapter);

    await dispatcher.handleWebhook(commentEvent(201, "Bên em đã tiếp nhận, tuần sau có bản demo nhé"));

    expect(adapter.notifyComment).toHaveBeenCalledWith(
      binding,
      "Chị Product",
      "Bên em đã tiếp nhận, tuần sau có bản demo nhé",
    );
  });

  test("comment gắn cờ nội bộ thì giữ lại trên tracker", async () => {
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(bindingFor(202, "PO-80")), {
      agentHandles: ["iris"],
    });
    dispatcher.registerBot(adapter);

    await dispatcher.handleWebhook(commentEvent(202, "#noibo chờ họp sprint rồi trả lời"));

    expect(adapter.notifyComment).not.toHaveBeenCalled();
  });

  /**
   * Bot ghi comment → Itsaplan bắn `comment.created` → worker đẩy về Telegram →
   * người dùng nhận lại đúng câu mình vừa nhắn. Vòng này chỉ có thật từ khi bật
   * chế độ đẩy-tất-cả.
   */
  test("không đẩy ngược comment do chính bot ghi", async () => {
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(bindingFor(203, "PO-81")), {
      agentHandles: ["iris"],
    });
    dispatcher.registerBot(adapter);

    await dispatcher.handleWebhook(
      commentEvent(203, "Em bổ sung thêm màn hình lỗi ạ\n\n<!-- intake-bot -->"),
    );

    expect(adapter.notifyComment).not.toHaveBeenCalled();
  });

  /**
   * Đo 17/09/2026: webhook của TECH nhận cả sự kiện PO (PO-15/39/40/78), và
   * worker TECH đã nạp PO-78 vào Onyx thành `ticket_tech-640`. Hai worker dùng
   * chung file binding, nên không khoá thì bot Tiểu Linh trả lời hộ IRIS.
   */
  test("bỏ qua sự kiện của dự án khác", async () => {
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(bindingFor(204, "PO-78")), {
      agentHandles: ["tieulinh"],
      projectKey: "TECH",
    });
    dispatcher.registerBot(adapter);

    await dispatcher.handleWebhook(commentEvent(204, "Bên Product đã xem, tuần sau phản hồi"));

    expect(adapter.notifyComment).not.toHaveBeenCalled();
  });

  test("vẫn nhận sự kiện của đúng dự án mình phụ trách", async () => {
    const binding = bindingFor(205, "TECH-700");
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(binding), {
      agentHandles: ["tieulinh"],
      projectKey: "TECH",
    });
    dispatcher.registerBot(adapter);

    await dispatcher.handleWebhook(commentEvent(205, "Đã restart server, anh/chị vào lại giúp em"));

    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);
  });

  test("skips telegram echoes in comment", async () => {
    const binding: TicketBinding = {
      issueId: 102,
      channelType: "telegram",
      chatId: "987654321",
      messageId: "1002",
      identifier: "TECH-102",
      title: "Lỗi",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const repo = createMockBindingRepo(binding);
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(repo, { agentHandles: ["vhticket_bot"] });
    dispatcher.registerBot(adapter);

    const webhook: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 102,
        body: "Tin nhắn người dùng (Telegram)",
      },
    };

    await dispatcher.handleWebhook(webhook);
    expect(adapter.notifyComment).toHaveBeenCalledTimes(0);
  });

  test("state_changed: chuyển columnId (webhook thật chỉ mang columnId) cho TicketClosure", async () => {
    const binding: TicketBinding = {
      issueId: 103,
      channelType: "telegram",
      chatId: "987654321",
      messageId: "1003",
      identifier: "TECH-103",
      title: "Lỗi mic",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const closure = { onColumnChanged: mock(async () => "done" as const) };
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(binding), { agentHandles: ["vhticket_bot"], closure });

    await dispatcher.handleWebhook({
      action: "update",
      type: "Issue",
      event: "issue.state_changed",
      createdAt: new Date().toISOString(),
      data: { id: 103, identifier: "TECH-103", columnId: 4 },
    });

    expect(closure.onColumnChanged).toHaveBeenCalledWith({ issueId: 103, identifier: "TECH-103", columnId: 4, columnChanged: true });
  });

  test("extractCommentImages extracts markdown images and attachments and normalizes URLs", () => {
    const dispatcher = new NotificationDispatcher(
      {} as any,
      { agentHandles: ["bot"], itsaplanBaseUrl: "https://itsaplan.example.com" },
    );

    const body =
      "Ảnh lỗi màn hình:\n![screenshot](/attachments/123/shot.png)\n![diagram](https://cdn.org/diag.jpg)";
    const attachments = [{ url: "/files/log.png" }, "https://cdn.org/extra.png"];

    const images = dispatcher.extractCommentImages(body, attachments);
    expect(images).toEqual([
      "https://itsaplan.example.com/attachments/123/shot.png",
      "https://cdn.org/diag.jpg",
      "https://itsaplan.example.com/files/log.png",
      "https://cdn.org/extra.png",
    ]);
  });

  test("forwards extracted images to adapter.notifyComment", async () => {
    const binding: TicketBinding = {
      issueId: 104,
      channelType: "telegram",
      chatId: "987654321",
      messageId: "1004",
      identifier: "TECH-104",
      title: "Lỗi camera",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const repo = createMockBindingRepo(binding);
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(repo, {
      agentHandles: ["bot"],
      itsaplanBaseUrl: "https://itsaplan.example.com",
    });
    dispatcher.registerBot(adapter);

    const webhook: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 104,
        body: "@bot gửi bạn ảnh chụp: ![error](/img/err.png)",
      },
    };

    await dispatcher.handleWebhook(webhook);

    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);
    expect(adapter.notifyComment).toHaveBeenCalledWith(
      binding,
      "Kỹ thuật viên Itsaplan",
      "gửi bạn ảnh chụp:",
      ["https://itsaplan.example.com/img/err.png"],
      [],
    );
  });

  // Markdown có ảnh nhưng không có video — Itsaplan nhúng video bằng thẻ
  // <video> thô (xem attachmentMarkdown ở web), khác hẳn cú pháp ![]() của ảnh.
  test("forwards extracted videos to adapter.notifyComment and cleans raw video tags", async () => {
    const binding: TicketBinding = {
      issueId: 106,
      channelType: "telegram",
      chatId: "987654321",
      messageId: "1006",
      identifier: "TECH-106",
      title: "Lỗi giao dịch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const repo = createMockBindingRepo(binding);
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(repo, {
      agentHandles: ["bot"],
      itsaplanBaseUrl: "http://127.0.0.1:3100",
      itsaplanWebUrl: "https://itsaplan.example.com",
    });
    dispatcher.registerBot(adapter);

    const webhook: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 106,
        body: '@bot gửi bạn video màn hình: <video src="/media/clip.mp4" controls></video>',
      },
    };

    await dispatcher.handleWebhook(webhook);

    expect(adapter.notifyComment).toHaveBeenCalledWith(
      binding,
      "Kỹ thuật viên Itsaplan",
      "gửi bạn video màn hình:",
      [],
      ["https://itsaplan.example.com/media/clip.mp4"],
    );
  });

  test("gỡ thẻ <mark> và <span> tô màu của Tiptap nhưng giữ nguyên nội dung chữ gửi về Telegram", async () => {
    const binding = bindingFor(107, "TECH-107");
    const repo = createMockBindingRepo(binding);
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(repo, {
      agentHandles: ["bot"],
      commentForwardPolicy: "mention",
    });
    dispatcher.registerBot(adapter);

    const webhook: ItsaplanWebhookEnvelope = {
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 107,
        body: '<mark data-color="#fef08a" style="background-color: #fef08a; color: inherit">@bot</mark> Đã xử lý <span style="color: #ef4444">lỗi đồng bộ</span> và <mark data-color="#bbf7d0">mở lại lớp</mark> ạ',
      },
    };

    await dispatcher.handleWebhook(webhook);

    expect(adapter.notifyComment).toHaveBeenCalledWith(
      binding,
      "Kỹ thuật viên Itsaplan",
      "Đã xử lý lỗi đồng bộ và mở lại lớp ạ",
    );
  });

  test("ưu tiên envelope.actor.name của webhook mới, fallback về data.author.name khi thiếu", async () => {
    const binding = bindingFor(108, "TECH-108");
    const repo = createMockBindingRepo(binding);
    const adapter = createMockAdapter();
    const seenDuplicateActors: Array<string | undefined> = [];
    const dispatcher = new NotificationDispatcher(repo, {
      agentHandles: ["bot"],
      duplicateMerger: {
        handleComment: async (input) => {
          seenDuplicateActors.push(input.actorName);
          return { merged: false, reason: "no_mention" };
        },
      },
    });
    dispatcher.registerBot(adapter);

    // 1. Có cả envelope.actor.name và data.author.name -> ưu tiên envelope.actor.name
    await dispatcher.handleWebhook({
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      actor: { type: "human", id: "u1", name: "KTV Actor Mới" },
      data: {
        issueId: 108,
        body: "Phản hồi từ webhook mới",
        author: { name: "KTV Author Cũ" },
      },
    });

    expect(adapter.notifyComment).toHaveBeenLastCalledWith(
      binding,
      "KTV Actor Mới",
      "Phản hồi từ webhook mới",
    );
    expect(seenDuplicateActors[0]).toBe("KTV Actor Mới");

    // 2. Không có envelope.actor -> fallback về data.author.name
    await dispatcher.handleWebhook({
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 108,
        body: "Phản hồi từ webhook cũ",
        author: { name: "KTV Author Cũ" },
      },
    });

    expect(adapter.notifyComment).toHaveBeenLastCalledWith(
      binding,
      "KTV Author Cũ",
      "Phản hồi từ webhook cũ",
    );
    expect(seenDuplicateActors[1]).toBe("KTV Author Cũ");
  });

  test("rewrites 127.0.0.1 URLs to itsaplanWebUrl for external access", () => {
    const repo = createMockBindingRepo();
    const dispatcher = new NotificationDispatcher(repo, {
      agentHandles: ["bot"],
      itsaplanBaseUrl: "http://127.0.0.1:3100",
      itsaplanWebUrl: "https://itsaplan.example.com",
    });

    const urls = dispatcher.extractCommentImages("Ảnh: ![alt](http://127.0.0.1:3100/attachments/123/raw)");
    expect(urls).toEqual(["https://itsaplan.example.com/attachments/123/raw"]);
  });


  test("IRIS (PO project): lọc sạch @bot-iris-intake / @iris và đặt authorName là 'Product team'", async () => {
    const binding = bindingFor(80, "PO-80");
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(binding), {
      agentHandles: ["iris", "bot-iris-intake", "vhiris_bot"],
      projectKey: "PO",
    });
    dispatcher.registerBot(adapter);

    await dispatcher.handleWebhook({
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 80,
        body: "@bot-iris-intake hi",
      },
    });

    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);
    const notifyCommentMock = adapter.notifyComment as unknown as ReturnType<typeof mock>;
    const [calledBinding, calledAuthor, calledText] = notifyCommentMock.mock.calls[0] as [TicketBinding, string, string];
    expect(calledBinding.identifier).toBe("PO-80");
    expect(calledAuthor).toBe("Product team");
    expect(calledText).toBe("hi");
  });

  test("Deduplication: không gửi lặp lại comment vừa được chuyển tiếp", async () => {
    const binding = bindingFor(80, "PO-80");
    const adapter = createMockAdapter();
    const dispatcher = new NotificationDispatcher(createMockBindingRepo(binding), {
      agentHandles: ["iris"],
      projectKey: "PO",
    });
    dispatcher.registerBot(adapter);

    // Lần 1: gửi thành công
    await dispatcher.handleWebhook({
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 80,
        body: "Chào bạn, tính năng này đang làm",
      },
    });
    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);

    // Lần 2: webhook trùng lặp hoặc runner vừa xử lý xong -> phải bị bỏ qua
    await dispatcher.handleWebhook({
      action: "create",
      type: "Comment",
      event: "comment.created",
      createdAt: new Date().toISOString(),
      data: {
        issueId: 80,
        body: "Chào bạn, tính năng này đang làm",
      },
    });
    // Vẫn chỉ được gọi đúng 1 lần
    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);
  });
});


describe("NotificationDispatcher — khoá dự án & ghi trạng thái", () => {
  function binding(issueId: number, identifier: string): TicketBinding {
    return { issueId, channelType: "telegram", chatId: "c-1", messageId: "1", identifier };
  }
  function repoWith(b: TicketBinding | null): TicketBindingRepository {
    return {
      getBindingByIssueId: mock(() => b),
      saveMessageRoute: mock(() => {}),
    } as unknown as TicketBindingRepository;
  }
  function doneEvent(data: Record<string, unknown>): ItsaplanWebhookEnvelope {
    return {
      action: "update",
      type: "Issue",
      event: "issue.state_changed",
      createdAt: new Date().toISOString(),
      data,
    };
  }
  // Issue TECH có trường Related Tickets — nếu lọt qua khoá, syncRelatedTickets sẽ addLink.
  function clientFor(identifier: string) {
    return {
      getIssue: mock(async (id: number) => ({
        id,
        identifier,
        fields: [{ fieldId: 3, value: "TECH-900" }],
        links: [],
      })),
      listCustomFields: mock(async () => [{ id: 3, name: "Related Tickets", fieldType: "markdown" }]),
      getIssueByNumber: mock(async () => ({ id: 900, identifier: "TECH-900" })),
      addLink: mock(async () => ({})),
    };
  }

  test("issue.updated (sửa mô tả) báo closure là KHÔNG đổi cột", async () => {
    const closure = { onColumnChanged: mock(async () => "open" as const) };
    const dispatcher = new NotificationDispatcher(repoWith(null), { agentHandles: ["iris"], projectKey: "PO", closure });
    await dispatcher.handleWebhook({ ...doneEvent({ id: 12, identifier: "PO-12", columnId: 9 }), event: "issue.updated" });
    expect(closure.onColumnChanged).toHaveBeenCalledWith({ issueId: 12, identifier: "PO-12", columnId: 9, columnChanged: false });
  });

  test("payload không có identifier, không binding: hỏi Itsaplan, ticket dự án khác thì bỏ qua hết", async () => {
    const client = clientFor("TECH-5");
    const closure = { onColumnChanged: mock(async () => null) };
    const dispatcher = new NotificationDispatcher(repoWith(null), {
      agentHandles: ["iris"],
      projectKey: "PO",
      itsaplanClient: client as any,
      closure,
    });

    await dispatcher.handleWebhook(doneEvent({ issueId: 5, columnId: 10 }));
    await new Promise((r) => setTimeout(r, 10));

    expect(closure.onColumnChanged).not.toHaveBeenCalled();
    expect(client.addLink).not.toHaveBeenCalled();
  });

  test("payload có identifier dự án khác: syncRelatedTickets KHÔNG chạy (trước đây chạy trước khoá)", async () => {
    const client = clientFor("TECH-6");
    const dispatcher = new NotificationDispatcher(repoWith(null), {
      agentHandles: ["iris"],
      projectKey: "PO",
      itsaplanClient: client as any,
    });

    await dispatcher.handleWebhook(doneEvent({ issueId: 6, identifier: "TECH-6", columnName: "In Progress" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(client.getIssue).not.toHaveBeenCalled();
    expect(client.addLink).not.toHaveBeenCalled();
  });

  test("không xác định được dự án (không identifier, không client) thì bỏ qua", async () => {
    const closure = { onColumnChanged: mock(async () => null) };
    const dispatcher = new NotificationDispatcher(repoWith(null), { agentHandles: ["iris"], projectKey: "PO", closure });

    await dispatcher.handleWebhook(doneEvent({ issueId: 7, columnId: 10 }));

    expect(closure.onColumnChanged).not.toHaveBeenCalled();
  });

  test("ticket của mình (tra từ Itsaplan): closure nhận identifier thật, không phải số issue", async () => {
    const client = clientFor("PO-8");
    const closure = { onColumnChanged: mock(async () => "done" as const) };
    const dispatcher = new NotificationDispatcher(repoWith(null), {
      agentHandles: ["iris"],
      projectKey: "PO",
      itsaplanClient: client as any,
      closure,
    });

    await dispatcher.handleWebhook(doneEvent({ issueId: 8, columnId: 10 }));

    expect(closure.onColumnChanged).toHaveBeenCalledWith({ issueId: 8, identifier: "PO-8", columnId: 10, columnChanged: true });
  });

  test("issue.created không identifier, không client: không ghi SLA dưới mã đoán", async () => {
    const lifecycle = { recordSlaTarget: mock(() => {}) } as any;
    const dispatcher = new NotificationDispatcher(repoWith(null), {
      agentHandles: ["iris"],
      projectKey: "PO",
      lifecycle,
    });

    await dispatcher.handleWebhook({
      action: "create",
      type: "Issue",
      event: "issue.created",
      createdAt: new Date().toISOString(),
      data: { id: 9, priority: "high" },
    });

    expect(lifecycle.recordSlaTarget).not.toHaveBeenCalled();
  });
});

// ADR-0007: tech lead ghim Nguyên nhân (Itsaplan bắn comment.updated) → chốt ticket tương tự.
describe("NotificationDispatcher → onTicketKnowledgeMaybeChanged", () => {
  const envelope = (event: ItsaplanWebhookEnvelope["event"], data: any): ItsaplanWebhookEnvelope =>
    ({ action: "update", type: "Comment", event, data, createdAt: new Date().toISOString() }) as ItsaplanWebhookEnvelope;

  test("comment.updated (ghim/sửa) và comment.created của người đều báo; không đẩy lại người báo", async () => {
    const seen: number[] = [];
    const repo = { getBindingByIssueId: mock(() => null), saveMessageRoute: mock(() => {}) } as unknown as TicketBindingRepository;
    const dispatcher = new NotificationDispatcher(repo, { agentHandles: HANDLES, onTicketKnowledgeMaybeChanged: (id) => seen.push(id) });
    await dispatcher.handleWebhook(envelope("comment.updated", { id: 1, issueId: 793, body: "- **Nguyên nhân:** Bị gắn trùng tk học do cùng tên", pinned: true }));
    await dispatcher.handleWebhook(envelope("comment.created", { id: 2, issueId: 794, body: "Anh @TechUser_B xem giúp em" }));
    expect(seen).toEqual([793, 794]);
    expect((repo.getBindingByIssueId as any).mock.calls.map((c: any[]) => c[0])).toEqual([794]);
  });
});
