import { afterEach, describe, expect, mock, test } from "bun:test";
import { ItsaplanApiError } from "@vuihoc/bot-core/itsaplan";
import { createItsaplanClient } from "./client-factory";

// Tiểu Linh là baseline đóng băng: client phải cư xử đúng như bản cũ của bot
// (không timeout, không retry, body 2xx lỏng) dù mặc định của thư viện khác.
describe("createItsaplanClient (hành vi cũ của Tiểu Linh)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("không đặt timeout (không có AbortSignal) cho request thường lẫn upload", async () => {
    const signals: unknown[] = [];
    globalThis.fetch = mock(async (_u: unknown, init?: { signal?: unknown }) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({ id: "1", url: "/u", filename: "a.png" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = createItsaplanClient("http://tracker.test", "k");
    await client.getProject("TECH");
    await client.uploadAttachment(1, "a.png", Buffer.from("x"), "image/png");
    expect(signals).toEqual([undefined, undefined]);
  });

  test("không thử lại khi 5xx: đúng một lần gọi rồi ném lỗi", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;
    const client = createItsaplanClient("http://tracker.test", "k");
    await expect(client.createIssue("TECH", { title: "t", columnId: 1 })).rejects.toBeInstanceOf(
      ItsaplanApiError,
    );
    expect(calls).toBe(1);
  });

  test("2xx body rỗng → {} và không phải JSON → chuỗi, không ném", async () => {
    const client = createItsaplanClient("http://tracker.test", "k");
    globalThis.fetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await client.request("/x")).toEqual({});
    await expect(client.deleteLink(1, 2)).resolves.toBeUndefined();
    globalThis.fetch = mock(
      async () => new Response("ok-text", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await client.request("/x")).toBe("ok-text");
  });
});
