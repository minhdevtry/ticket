import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { TelegramTransport } from "./transport";

/**
 * Cổng ra Telegram trước đây được viết hai bản trong `worker/`, và không bản
 * nào có test — hai chính sách lỗi lệch nhau lặng lẽ. Test ở đây khoá lại đúng
 * hai chính sách đó: `call` ném lỗi, `tryCall` nuốt lỗi.
 */

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let transport: TelegramTransport;

beforeEach(() => {
  transport = new TelegramTransport({ botToken: "tok", timeoutMs: 1000 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TelegramTransport.call", () => {
  test("gọi đúng endpoint Bot API và trả thẳng `result`", async () => {
    const seen: { url?: string; body?: string } = {};
    globalThis.fetch = mock(async (url: any, init: any) => {
      seen.url = String(url);
      seen.body = init?.body;
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    }) as any;

    const result = await transport.call<{ message_id: number }>("sendMessage", { chat_id: 1 });

    expect(result).toEqual({ message_id: 7 });
    expect(seen.url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(JSON.parse(seen.body!)).toEqual({ chat_id: 1 });
  });

  test("Telegram trả ok:false thì ném lỗi kèm description", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ ok: false, description: "chat not found" }),
    ) as any;

    await expect(transport.call("sendMessage", {})).rejects.toThrow("chat not found");
  });

  test("HTTP lỗi cũng ném, dùng status khi không có description", async () => {
    globalThis.fetch = mock(async () => jsonResponse({}, 500)) as any;

    await expect(transport.call("sendMessage", {})).rejects.toThrow("500");
  });
});

describe("TelegramTransport.tryCall", () => {
  test("thành công thì trả `result` y như call", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ ok: true, result: { file_path: "a/b.jpg" } }),
    ) as any;

    const result = await transport.tryCall<{ file_path: string }>("getFile", { file_id: "x" });

    expect(result).toEqual({ file_path: "a/b.jpg" });
  });

  test("hỏng thì trả null chứ không ném — luồng gọi không bị gãy", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ ok: false, description: "bad" })) as any;

    expect(await transport.tryCall("answerCallbackQuery", {})).toBeNull();
  });

  test("fetch ném thẳng (mất mạng, timeout) cũng trả null", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as any;

    expect(await transport.tryCall("sendMessage", {})).toBeNull();
  });
});

describe("TelegramTransport.downloadFile", () => {
  test("tải theo đường /file/bot<token>/<path> và trả Buffer", async () => {
    let seenUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      seenUrl = String(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as any;

    const buf = await transport.downloadFile("photos/a.jpg");

    expect(seenUrl).toBe("https://api.telegram.org/file/bottok/photos/a.jpg");
    expect([...buf]).toEqual([1, 2, 3]);
  });

  test("tải hỏng thì ném, không trả Buffer rỗng", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as any;

    await expect(transport.downloadFile("x.jpg")).rejects.toThrow("404");
  });
});

describe("TelegramTransport.sendFormData", () => {
  test("gửi multipart/form-data tới API và trả result", async () => {
    let seenUrl = "";
    let seenBody: any = null;
    globalThis.fetch = mock(async (url: any, init: any) => {
      seenUrl = String(url);
      seenBody = init?.body;
      return jsonResponse({ ok: true, result: { message_id: 88 } });
    }) as any;

    const fd = new FormData();
    fd.append("chat_id", "123");
    fd.append("photo", new Blob(["fake-img"]), "test.jpg");

    const res = await transport.sendFormData<{ message_id: number }>("sendPhoto", fd);
    expect(res).toEqual({ message_id: 88 });
    expect(seenUrl).toBe("https://api.telegram.org/bottok/sendPhoto");
    expect(seenBody instanceof FormData).toBe(true);
  });

  test("API trả lỗi thì ném exception", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ ok: false, description: "wrong file type" }),
    ) as any;

    const fd = new FormData();
    await expect(transport.sendFormData("sendPhoto", fd)).rejects.toThrow("wrong file type");
  });

  test("trySendFormData trả null khi lỗi thay vì ném", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ ok: false, description: "wrong file type" }),
    ) as any;

    const fd = new FormData();
    const res = await transport.trySendFormData("sendPhoto", fd);
    expect(res).toBeNull();
  });
});
