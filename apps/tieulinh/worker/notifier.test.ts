import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { TelegramNotifier } from "./notifier";
import type { TicketBinding } from "../lib/storage/binding-repository";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const mockBinding: TicketBinding = {
  issueId: 100,
  channelType: "telegram",
  chatId: "123456",
  messageId: "1",
  identifier: "TECH-100",
  title: "Test Issue",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TelegramNotifier — Markdown hỏng không làm mất tin (PO-91, 01/10)", () => {
  const parseError = () => jsonResponse({ ok: false, description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 324" }, 400);

  test("bình luận có tên chứa dấu gạch dưới → gửi lại dạng văn bản thuần, người báo vẫn nhận được", async () => {
    const bodies: any[] = [];
    globalThis.fetch = mock(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.parse_mode ? parseError() : jsonResponse({ ok: true, result: { message_id: 77 } });
    }) as any;
    const notifier = new TelegramNotifier({ botToken: "tok" });
    const id = await notifier.notifyComment(mockBinding, "PO_UserA", "liên hệ @PRO_UserB thứ 2 -> thứ 6");
    expect(id).toBe(77);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].parse_mode).toBeUndefined();
    expect(bodies[1].text).toContain("PO_UserA vừa trao đổi về TECH-100");
    expect(bodies[1].text).toContain("@PRO_UserB");
    expect(bodies[1].text).not.toContain("**");
  });

  test("lỗi khác (không phải định dạng) vẫn ném ra, không gửi lặp", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return jsonResponse({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403);
    }) as any;
    const notifier = new TelegramNotifier({ botToken: "tok" });
    const id = await notifier.notifyComment(mockBinding, "A", "xin chào");
    expect(id).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("TelegramNotifier.notifyComment", () => {
  test("gửi 1 ảnh kèm caption thành 1 tin nhắn duy nhất", async () => {
    const calls: { url: string; init?: any }[] = [];
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("attachments/img.png")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return jsonResponse({ ok: true, result: { message_id: 999 } });
    }) as any;

    const notifier = new TelegramNotifier({
      botToken: "tok",
      itsaplanLocalBaseUrl: "http://127.0.0.1:3100",
    });

    const msgId = await notifier.notifyComment(
      mockBinding,
      "IT Support",
      "Anh xem ảnh này nhé",
      ["https://itsaplan.example.com/attachments/img.png"],
      [],
    );

    expect(msgId).toBe(999);
    const sendPhotoCall = calls.find((c) => c.url.includes("/sendPhoto"));
    expect(sendPhotoCall).toBeDefined();
    const sendMessageCall = calls.find((c) => c.url.includes("/sendMessage"));
    expect(sendMessageCall).toBeUndefined();
  });

  test("gửi 1 video kèm caption thành 1 tin nhắn duy nhất", async () => {
    const calls: { url: string; init?: any }[] = [];
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("attachments/video.mp4")) {
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });
      }
      return jsonResponse({ ok: true, result: { message_id: 888 } });
    }) as any;

    const notifier = new TelegramNotifier({
      botToken: "tok",
      itsaplanLocalBaseUrl: "http://127.0.0.1:3100",
    });

    const msgId = await notifier.notifyComment(
      mockBinding,
      "IT Support",
      "Anh xem video tái hiện nhé",
      [],
      ["https://itsaplan.example.com/attachments/video.mp4"],
    );

    expect(msgId).toBe(888);
    const sendVideoCall = calls.find((c) => c.url.includes("/sendVideo"));
    expect(sendVideoCall).toBeDefined();
    const sendMessageCall = calls.find((c) => c.url.includes("/sendMessage"));
    expect(sendMessageCall).toBeUndefined();
  });

  test("khi có nhiều hơn 1 media thì gửi sendMessage text trước, rồi gửi từng media", async () => {
    const calls: { url: string; init?: any }[] = [];
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("attachments/")) {
        return new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      return jsonResponse({ ok: true, result: { message_id: 111 } });
    }) as any;

    const notifier = new TelegramNotifier({
      botToken: "tok",
      itsaplanLocalBaseUrl: "http://127.0.0.1:3100",
    });

    await notifier.notifyComment(
      mockBinding,
      "IT Support",
      "2 ảnh đây",
      [
        "https://itsaplan.example.com/attachments/1.jpg",
        "https://itsaplan.example.com/attachments/2.jpg",
      ],
      [],
    );

    const sendMessageCall = calls.find((c) => c.url.includes("/sendMessage"));
    expect(sendMessageCall).toBeDefined();
    const sendPhotoCalls = calls.filter((c) => c.url.includes("/sendPhoto"));
    expect(sendPhotoCalls).toHaveLength(2);
  });
});

describe("TelegramNotifier.notifyStateChange — lời giải thích riêng của dự án (PO)", () => {
  test("exact: báo đúng 'PO-79 chuyển sang: Discussion (…)', kể cả khi là trạng thái hoàn tất", async () => {
    const bodies: any[] = [];
    globalThis.fetch = mock(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: { message_id: 5 } });
    }) as any;
    const notifier = new TelegramNotifier({ botToken: "tok" });
    const binding = { ...mockBinding, identifier: "PO-79" };
    await notifier.notifyStateChange(binding, "Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)", "open", true);
    await notifier.notifyStateChange(binding, "Golive (tính năng đã golive)", "done", true);
    expect(bodies[0].text).toBe("PO-79 chuyển sang: **Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)**");
    expect(bodies[1].text).toBe("PO-79 chuyển sang: **Golive (tính năng đã golive)**");
    expect(bodies[1].text).not.toContain("đã hoàn tất");
    expect(bodies[1].reply_markup).toBeUndefined();
  });
});

describe("TelegramNotifier.notifyStateChange (ADR-0006)", () => {
  async function sendFor(state: "open" | "resolved" | "done") {
    const bodies: any[] = [];
    globalThis.fetch = mock(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    }) as any;
    const notifier = new TelegramNotifier({ botToken: "t" });
    const id = await notifier.notifyStateChange(mockBinding, "Đang xử lý", state);
    return { id, body: bodies[0] };
  }

  test("đã xử lý: nhắn kiểm tra + đúng một nút '👍 Đã ổn' (reporter_ok), không có nút đóng ticket", async () => {
    const { id, body } = await sendFor("resolved");
    expect(id).toBe(7);
    expect(body.text).toContain("TECH-100 đã được xử lý");
    expect(body.text).toContain("chưa ổn thì cứ nhắn lại");
    expect(body.reply_markup.inline_keyboard).toEqual([[{ text: "👍 Đã ổn", callback_data: "reporter_ok:100" }]]);
  });

  test("hoàn tất: báo đã hoàn tất, không kèm nút", async () => {
    const { body } = await sendFor("done");
    expect(body.text).toBe("Ticket TECH-100 đã hoàn tất.");
    expect(body.reply_markup).toBeUndefined();
  });

  test("trạng thái khác: báo tên cột", async () => {
    const { body } = await sendFor("open");
    expect(body.text).toContain("Đang xử lý");
    expect(body.reply_markup).toBeUndefined();
  });
});
