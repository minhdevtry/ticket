import { describe, expect, test, mock, beforeEach } from "bun:test";
import { TelegramWebhookHandler } from "./telegram-handler";
import { Database } from "bun:sqlite";
import { applySchema } from "../lib/storage/schema";
import { TicketBindingRepository } from "../lib/storage/binding-repository";
import type { ItsaplanClient } from "../lib/itsaplan/client";
import type { TicketClosure } from "./ticket-closure";

describe("TelegramWebhookHandler", () => {
  let db: Database;
  let bindings: TicketBindingRepository;
  let mockItsaplan: ItsaplanClient;
  let mockClosure: Pick<TicketClosure, "recordReporterOk">;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    bindings = new TicketBindingRepository(db);

    mockItsaplan = {
      addComment: mock(async () => ({})),
    } as unknown as ItsaplanClient;

    mockClosure = {
      recordReporterOk: mock(async () => ({
        outcome: "recorded" as const,
        replyText: "Dạ em đã ghi nhận",
      })),
    };
  });

  test("nút Đã ổn (và nút confirm_done cũ): ghi phản hồi qua closure, trả lời đúng chat", async () => {
    const handler = new TelegramWebhookHandler({
      itsaplan: mockItsaplan,
      closure: mockClosure,
      bindings,
    });
    const calls: Array<{ method: string; payload: any }> = [];
    (handler as any).callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return {};
    };

    for (const data of ["reporter_ok:42", "confirm_done:42"]) {
      await handler.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "cb_1",
          from: { id: 12345, first_name: "Test", username: "user_a" },
          data,
          message: { message_id: 100, chat: { id: 12345 } },
        },
      });
    }

    expect(mockClosure.recordReporterOk).toHaveBeenCalledTimes(2);
    expect((mockClosure.recordReporterOk as any).mock.calls[0][0]).toEqual({
      issueId: 42,
      chatId: 12345,
      userName: "Test",
    });
    expect(calls.find((c) => c.method === "sendMessage")?.payload).toEqual({
      chat_id: 12345,
      text: "Dạ em đã ghi nhận",
    });
    // Nút không bao giờ đóng ticket (ADR-0006): không có lời gọi nào sửa ticket.
    expect(mockItsaplan.addComment).not.toHaveBeenCalled();
  });

  test("xử lý reply tin nhắn: tra message_routes và đồng bộ comment vào Itsaplan", async () => {
    const handler = new TelegramWebhookHandler({
      itsaplan: mockItsaplan,
      closure: mockClosure,
      bindings,
    });

    // Lưu route từ trước
    bindings.saveMessageRoute("bot_msg_99", "telegram", 42, "TECH-42", "12345");

    const update = {
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 12345, first_name: "Nguyễn Văn A" },
        chat: { id: 12345 },
        reply_to_message: { message_id: "bot_msg_99" },
        text: "Em gửi thêm tài khoản học sinh là hs_88291 ạ",
      },
    };

    await handler.handleUpdate(update);

    // Comment do bot ghi mang dấu `<!-- intake-bot -->` để webhook không đẩy
    // ngược chính nó về Telegram.
    expect(mockItsaplan.addComment).toHaveBeenCalledWith(
      42,
      "**Nguyễn Văn A (Telegram):**\nEm gửi thêm tài khoản học sinh là hs_88291 ạ\n\n<!-- intake-bot -->",
    );
  });

  test("bỏ qua khi không phải reply vào tin nhắn ticket", async () => {
    const handler = new TelegramWebhookHandler({
      itsaplan: mockItsaplan,
      closure: mockClosure,
      bindings,
    });

    const update = {
      update_id: 3,
      message: {
        message_id: 102,
        from: { id: 12345, first_name: "Test" },
        chat: { id: 12345 },
        reply_to_message: { message_id: "unrelated_msg" },
        text: "Tin nhắn không liên quan",
      },
    };

    await handler.handleUpdate(update);

    expect(mockItsaplan.addComment).not.toHaveBeenCalled();
  });
  // message_id Telegram chỉ duy nhất trong một chat: hai chat có thể cùng có
  // tin nhắn số 500 của bot. Reply ở chat B không được ghi vào ticket của chat A.
  test("reply cùng message_id ở hai chat khác nhau đi đúng ticket của từng chat", async () => {
    const handler = new TelegramWebhookHandler({
      itsaplan: mockItsaplan,
      closure: mockClosure,
      bindings,
    });
    bindings.saveMessageRoute(500, "telegram", 1, "TECH-1", "111");
    bindings.saveMessageRoute(500, "telegram", 2, "TECH-2", "222");

    const reply = (chatId: number, text: string) => ({
      update_id: 10,
      message: {
        message_id: 900,
        from: { id: chatId, first_name: "U" },
        chat: { id: chatId },
        reply_to_message: { message_id: 500 },
        text,
      },
    });

    await handler.handleUpdate(reply(222, "từ chat B"));
    await handler.handleUpdate(reply(111, "từ chat A"));

    const calls = (mockItsaplan.addComment as any).mock.calls as Array<[number, string]>;
    expect(calls.map((c) => c[0])).toEqual([2, 1]);
    expect(calls[0][1]).toContain("từ chat B");
    expect(calls[1][1]).toContain("từ chat A");
  });

  test("reply vào ticket của dự án khác (DB dùng chung) thì bỏ qua", async () => {
    const handler = new TelegramWebhookHandler({
      itsaplan: mockItsaplan,
      closure: mockClosure,
      bindings,
      projectKey: "PO",
    });
    bindings.saveMessageRoute(600, "telegram", 3, "TECH-3", "333");

    await handler.handleUpdate({
      update_id: 11,
      message: {
        message_id: 901,
        from: { id: 333, first_name: "U" },
        chat: { id: 333 },
        reply_to_message: { message_id: 600 },
        text: "không phải việc của bot PO",
      },
    });

    expect(mockItsaplan.addComment).not.toHaveBeenCalled();
  });

  test("bấm từ chat không có liên kết chat: trả lời nhưng không gỡ nút", async () => {
    const closure = {
      recordReporterOk: mock(async () => ({
        outcome: "not_bound" as const,
        replyText: "không thuộc cuộc trò chuyện",
      })),
    };
    const handler = new TelegramWebhookHandler({ itsaplan: mockItsaplan, closure, bindings });
    const calls: Array<{ method: string; payload: any }> = [];
    (handler as any).callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return {};
    };

    await handler.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "cb_x",
        from: { id: 1, first_name: "Lạ" },
        data: "reporter_ok:42",
        message: { message_id: 100, chat: { id: 1 } },
      },
    });

    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(false);
    expect(calls.find((c) => c.method === "sendMessage")?.payload.text).toContain("không thuộc");
  });

  test("ghi phản hồi lỗi: vẫn dừng vòng quay và báo bấm lại, chỉ một câu trả lời", async () => {
    const closure = {
      recordReporterOk: mock(async () => Promise.reject(new Error("Itsaplan 500"))),
    };
    const handler = new TelegramWebhookHandler({
      itsaplan: mockItsaplan,
      closure: closure as any,
      bindings,
    });
    const calls: Array<{ method: string; payload: any }> = [];
    (handler as any).callApi = async (method: string, payload: any) => {
      calls.push({ method, payload });
      return {};
    };

    await handler.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "cb_e",
        from: { id: 1, first_name: "Test" },
        data: "reporter_ok:42",
        message: { message_id: 100, chat: { id: 1 } },
      },
    });

    expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(1);
    const msgs = calls.filter((c) => c.method === "sendMessage");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.text).toContain("chưa ghi nhận được");
  });

  test("TECH ticket đóng: từ chối ghi nhận và hướng dẫn tạo ticket mới", async () => {
    const itsaplan = {
      addComment: mock(async () => ({})),
      getIssue: mock(async () => ({
        id: 42,
        identifier: "TECH-42",
        columnId: 4,
        stateType: "completed",
      })),
      listProjectColumns: mock(async () => [
        { id: 4, name: "Done", stateType: "completed", position: 4 },
      ]),
    } as unknown as ItsaplanClient;

    const handler = new TelegramWebhookHandler({
      itsaplan,
      closure: mockClosure,
      bindings,
      projectKey: "TECH",
    });

    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    (
      handler as unknown as {
        callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
      }
    ).callApi = async (method, payload) => {
      calls.push({ method, payload });
      return {};
    };

    bindings.saveMessageRoute("bot_msg_42", "telegram", 42, "TECH-42", "12345");

    await handler.handleUpdate({
      update_id: 20,
      message: {
        message_id: 201,
        from: { id: 12345, first_name: "Nguyễn Văn A" },
        chat: { id: 12345 },
        reply_to_message: { message_id: "bot_msg_42" },
        text: "bổ sung thêm thông tin",
      },
    });

    expect(itsaplan.addComment).not.toHaveBeenCalled();
    const sent = calls.find((c) => c.method === "sendMessage");
    expect(sent).toBeDefined();
    expect(String(sent?.payload.text)).toContain("đã đóng");
    expect(String(sent?.payload.text)).toContain("tạo ticket mới");
  });

  test("TECH ticket mở có assignee: comment có mention (cc @username) đúng cú pháp", async () => {
    const techComments: Array<{ issueId: number; body: string }> = [];
    const itsaplan = {
      addComment: mock(async (issueId: number, body: string) => {
        techComments.push({ issueId, body });
        return {};
      }),
      getIssue: mock(async () => ({
        id: 42,
        identifier: "TECH-42",
        columnId: 2,
        stateType: "started",
        assigneeUserId: "u-techlead-a",
      })),
      listProjectColumns: mock(async () => [
        { id: 2, name: "In Progress", stateType: "started", position: 2 },
      ]),
      getProject: mock(async () => ({
        id: 1,
        key: "TECH",
        assignees: [{ userId: "u-techlead-a", username: "techlead_a", name: "TechLead_A" }],
      })),
    } as unknown as ItsaplanClient;

    const handler = new TelegramWebhookHandler({
      itsaplan,
      closure: mockClosure,
      bindings,
      projectKey: "TECH",
    });

    bindings.saveMessageRoute("bot_msg_43", "telegram", 42, "TECH-42", "12345");

    await handler.handleUpdate({
      update_id: 21,
      message: {
        message_id: 202,
        from: { id: 12345, first_name: "Nguyễn Văn A" },
        chat: { id: 12345 },
        reply_to_message: { message_id: "bot_msg_43" },
        text: "Em gửi thêm số điện thoại 0900000005",
      },
    });

    expect(techComments).toHaveLength(1);
    const addedBody = techComments[0].body;
    expect(addedBody).toContain("(cc @techlead_a)");
    expect(addedBody).not.toContain("(cc @techlead_a))");
    expect(addedBody).toContain("**Nguyễn Văn A (Telegram)** (cc @techlead_a):");
  });

  test("PO ticket (Iris): ticket đóng không bị từ chối và không gắn mention cc", async () => {
    const poComments: Array<{ issueId: number; body: string }> = [];
    const itsaplan = {
      addComment: mock(async (issueId: number, body: string) => {
        poComments.push({ issueId, body });
        return {};
      }),
      getIssue: mock(async () => ({
        id: 80,
        identifier: "PO-80",
        columnId: 10,
        stateType: "completed",
        assigneeUserId: "u-techlead-a",
      })),
      listProjectColumns: mock(async () => [
        { id: 10, name: "Golive", stateType: "completed", position: 10 },
      ]),
      getProject: mock(async () => ({
        id: 2,
        key: "PO",
        assignees: [{ userId: "u-techlead-a", username: "techlead_a", name: "TechLead_A" }],
      })),
    } as unknown as ItsaplanClient;

    const handler = new TelegramWebhookHandler({
      itsaplan,
      closure: mockClosure,
      bindings,
      projectKey: "PO",
    });

    bindings.saveMessageRoute("bot_msg_80", "telegram", 80, "PO-80", "12345");

    await handler.handleUpdate({
      update_id: 22,
      message: {
        message_id: 203,
        from: { id: 12345, first_name: "Nguyễn Văn A" },
        chat: { id: 12345 },
        reply_to_message: { message_id: "bot_msg_80" },
        text: "Bổ sung thêm yêu cầu xuất excel",
      },
    });

    expect(poComments).toHaveLength(1);
    const addedBody = poComments[0].body;
    expect(addedBody).toContain("Bổ sung thêm yêu cầu xuất excel");
    expect(addedBody).not.toContain("cc @");
    expect(addedBody).toContain("**Nguyễn Văn A (Telegram):**");
  });
});
