/**
 * Telegram transport + safe send + ack + alert tests, driven against a FAKE Bot
 * API served on 127.0.0.1:0 (never the real Telegram). Each rule-test is named
 * after the intake commit / incident it stands in for.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  TelegramTransport,
  TelegramApiError,
  isEntityParseError,
  plainText,
} from "./transport";
import { sendMessage, ackReaction } from "./send";
import { Alerter, buttonDropAlert } from "./alert";

// ── fake Bot API ─────────────────────────────────────────────────────────────
interface Recorded {
  method: string;
  payload: unknown;
}

type Responder = (method: string, payload: any) => { status: number; body: unknown };

function startFakeBotApi(responder: Responder) {
  const calls: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const m = url.pathname.match(/\/bot[^/]+\/([A-Za-z]+)/);
      const method = m?.[1] ?? "";
      let payload: any = {};
      try {
        payload = await req.json();
      } catch {
        /* form-data / download — ignore */
      }
      calls.push({ method, payload });
      const { status, body } = responder(method, payload);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { server, baseUrl, calls };
}

const ok = (result: unknown = { message_id: 1 }) => ({ status: 200, body: { ok: true, result } });
const fail = (status: number, description: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { ok: false, error_code: status, description, ...extra },
});

const servers: Array<{ stop(): void }> = [];
function transportAgainst(responder: Responder, overrides = {}) {
  const fake = startFakeBotApi(responder);
  servers.push(fake.server);
  const transport = new TelegramTransport({
    botToken: "TEST:token",
    baseUrl: fake.baseUrl,
    sleep: async () => {},
    ...overrides,
  });
  return { transport, calls: fake.calls };
}

afterAll(() => {
  for (const s of servers) s.stop();
});

describe("TelegramTransport (injected fetch/baseUrl — research §8)", () => {
  test("call returns result on ok and throws TelegramApiError on failure", async () => {
    const { transport } = transportAgainst((method) =>
      method === "getMe" ? ok({ id: 42 }) : fail(400, "Bad Request"),
    );
    expect(await transport.call("getMe", {})).toEqual({ id: 42 });
    await expect(transport.call("sendMessage", {})).rejects.toBeInstanceOf(TelegramApiError);
  });

  test("tryCall swallows failures and returns null (side-job policy)", async () => {
    const { transport } = transportAgainst(() => fail(400, "nope"));
    expect(await transport.tryCall("sendMessage", {})).toBeNull();
  });

  // ── commit 40f7062 / PO-91 (01/10): can't parse entities → plain text ──────
  test("40f7062: sendMessage retries as plain text on 'can't parse entities'", async () => {
    let seen = 0;
    const { transport, calls } = transportAgainst((method, payload) => {
      if (method !== "sendMessage") return ok();
      seen++;
      // First attempt carries parse_mode and the underscore name → rejected.
      if (payload.parse_mode) return fail(400, "Bad Request: can't parse entities at byte 12");
      return ok({ message_id: 7 });
    });
    const sent = await sendMessage(transport, {
      chatId: "123",
      text: "Chào **PO_UserC** và @PRO_UserB",
      parseMode: "Markdown",
    });
    expect(seen).toBe(2); // rejected once, resent once
    expect(sent[0].message_id).toBe(7);
    const resend = calls.find((c) => c.method === "sendMessage" && !(c.payload as any).parse_mode);
    expect(resend).toBeTruthy();
    expect((resend!.payload as any).text).toBe("Chào PO_UserC và @PRO_UserB"); // ** stripped
  });

  test("40f7062: isEntityParseError / plainText helpers", () => {
    expect(isEntityParseError(new Error("Bad Request: can't parse entities"))).toBe(true);
    expect(isEntityParseError(new Error("other"))).toBe(false);
    expect(plainText("a **b** c")).toBe("a b c");
  });

  // ── CM broadcast-dispatcher: 429 retry_after honoured, bounded ─────────────
  test("CM-429: honours retry_after once then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const { transport } = transportAgainst(
      () => {
        n++;
        return n === 1 ? fail(429, "Too Many Requests", { parameters: { retry_after: 3 } }) : ok();
      },
      { sleep: async (ms: number) => void waits.push(ms) },
    );
    const res = await transport.call("sendMessage", { chat_id: "1", text: "hi" });
    expect(res).toBeTruthy();
    expect(n).toBe(2);
    expect(waits[0]).toBe(3000); // retry_after seconds → ms
  });

  test("CM-429: gives up after maxRetries and the error exposes retryAfterMs", async () => {
    const { transport } = transportAgainst(
      () => fail(429, "Too Many Requests", { parameters: { retry_after: 2 } }),
      { maxRetries: 1, sleep: async () => {} },
    );
    try {
      await transport.call("sendMessage", { chat_id: "1", text: "hi" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError);
      expect((err as TelegramApiError).isRateLimited).toBe(true);
      expect((err as TelegramApiError).retryAfterMs).toBe(2000);
    }
  });

  test("CM-429: retry_after:0 is floored (no hot loop)", async () => {
    let n = 0;
    const waits: number[] = [];
    const { transport } = transportAgainst(
      () => (++n === 1 ? fail(429, "slow", { parameters: { retry_after: 0 } }) : ok()),
      { sleep: async (ms: number) => void waits.push(ms) },
    );
    await transport.call("sendMessage", { chat_id: "1", text: "x" });
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe("sendMessage — safe buttons (14/09 BUTTON_DATA_INVALID)", () => {
  test("14/09: a >64-byte button is dropped, the message still sends", async () => {
    const { transport, calls } = transportAgainst(() => ok({ message_id: 5 }));
    const dropped: string[] = [];
    const long = "x".repeat(65); // 65 bytes > MAX_CALLBACK_DATA_BYTES
    const sent = await sendMessage(transport, {
      chatId: "9",
      text: "Chọn nhánh",
      buttons: [[{ text: "ok", callback_data: "ok" }, { text: "bad", callback_data: long }]],
      onButtonDrop: (r) => dropped.push(r),
    });
    expect(sent).toHaveLength(1); // message went out
    expect(dropped).toHaveLength(1);
    const markup = (calls[0].payload as any).reply_markup;
    expect(markup.inline_keyboard[0]).toHaveLength(1); // only the valid button kept
    expect(markup.inline_keyboard[0][0].callback_data).toBe("ok");
  });

  test("14/09: a row that becomes empty after filtering is removed entirely", async () => {
    const { transport, calls } = transportAgainst(() => ok());
    const long = "y".repeat(100);
    await sendMessage(transport, {
      chatId: "9",
      text: "hi",
      buttons: [[{ text: "bad", callback_data: long }]],
    });
    // Every button dropped ⇒ no reply_markup at all, but the message still sent.
    expect((calls[0].payload as any).reply_markup).toBeUndefined();
    expect(calls[0].method).toBe("sendMessage");
  });

  test("buttons ride only the LAST chunk of a split message", async () => {
    const { transport, calls } = transportAgainst(() => ok());
    const long = "a".repeat(5000); // forces a split
    await sendMessage(transport, {
      chatId: "9",
      text: long,
      buttons: [[{ text: "ok", callback_data: "ok" }]],
    });
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect((sends[0].payload as any).reply_markup).toBeUndefined();
    expect((sends.at(-1)!.payload as any).reply_markup).toBeTruthy();
  });
});

describe("ackReaction — 4595d00 (acknowledge receipt without noise)", () => {
  test("4595d00: sends setMessageReaction with the 👀 default and never throws", async () => {
    const { transport, calls } = transportAgainst((method) =>
      method === "setMessageReaction" ? ok(true) : ok(),
    );
    const okAck = await ackReaction(transport, { chatId: "1", messageId: 55 });
    expect(okAck).toBe(true);
    const call = calls.find((c) => c.method === "setMessageReaction")!;
    expect((call.payload as any).reaction[0].emoji).toBe("👀");
  });

  test("4595d00: a reaction rejected by Telegram is swallowed (side job)", async () => {
    const { transport } = transportAgainst(() => fail(400, "REACTION_INVALID"));
    expect(await ackReaction(transport, { chatId: "1", messageId: 5 })).toBe(false);
  });
});

describe("Alerter — 14/09 silent-failure incident", () => {
  beforeEach(() => {});

  test("14/09: alert goes to every injected admin chat id", async () => {
    const { transport, calls } = transportAgainst(() => ok());
    const alerter = new Alerter({ transport, adminChatIds: ["100", "200"], now: () => 0 });
    expect(alerter.alert("fault-x", "something broke")).toBe(true);
    await Bun.sleep(5); // fire-and-forget sends settle
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends.map((c) => (c.payload as any).chat_id).sort()).toEqual(["100", "200"]);
    expect((sends[0].payload as any).text).toContain("⚠️");
  });

  test("14/09: same fault key is deduped within the window", () => {
    let t = 0;
    const { transport } = transportAgainst(() => ok());
    const alerter = new Alerter({ transport, adminChatIds: ["1"], now: () => t });
    expect(alerter.alert("fault", "a")).toBe(true);
    t = 60_000; // 1 min < 30 min window
    expect(alerter.alert("fault", "a")).toBe(false);
    t = 31 * 60_000; // past window
    expect(alerter.alert("fault", "a")).toBe(true);
  });

  test("alert with no transport/admins logs only, does not dispatch", () => {
    const alerter = new Alerter({ adminChatIds: [] });
    expect(alerter.alert("k", "x")).toBe(false);
  });

  test("buttonDropAlert routes a drop reason into the Alerter", async () => {
    const { transport, calls } = transportAgainst(() => ok());
    const alerter = new Alerter({ transport, adminChatIds: ["1"], now: () => 0 });
    const sink = buttonDropAlert(alerter);
    sink("Đã loại 1 nút");
    await Bun.sleep(5); // let the fire-and-forget send settle
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
});
