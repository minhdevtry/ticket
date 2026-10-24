import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ItsaplanWebhookServer } from "./server";
import { MemoryWebhookDedupeStore } from "./dedupe-store";
import type { ItsaplanWebhookEnvelope } from "./events";

/** Integration test against a real node:http server bound to 127.0.0.1:0. */

function sign(secret: string, ts: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

let server: ItsaplanWebhookServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function startWith(opts: ConstructorParameters<typeof ItsaplanWebhookServer>[0]): Promise<string> {
  server = new ItsaplanWebhookServer(opts);
  await server.start(0);
  const port = server.port();
  return `http://127.0.0.1:${port}`;
}

const envBody = (over: Partial<ItsaplanWebhookEnvelope> = {}): string =>
  JSON.stringify({
    action: "create",
    type: "Comment",
    event: "comment.created",
    data: { issueId: 7, id: 3, body: "hello" },
    createdAt: "2026-10-16T00:00:00Z",
    webhookTimestamp: 1234,
    ...over,
  });

describe("ItsaplanWebhookServer /webhook", () => {
  test("good signature → 200 and handler fires", async () => {
    const secret = "whsec_test";
    const seen: ItsaplanWebhookEnvelope[] = [];
    const base = await startWith({ itsaplanSecrets: [secret] });
    server!.onEvent(async (e) => {
      seen.push(e);
    });
    const body = envBody();
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Itsaplan-Signature": sign(secret, ts, body) },
      body,
    });
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe("comment.created");
  });

  test("bad signature → 401 and handler does NOT fire", async () => {
    const seen: unknown[] = [];
    const base = await startWith({ itsaplanSecrets: ["whsec_right"] });
    server!.onEvent(async (e) => {
      seen.push(e);
    });
    const body = envBody();
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Itsaplan-Signature": sign("whsec_wrong", ts, body) },
      body,
    });
    expect(res.status).toBe(401);
    await Bun.sleep(5);
    expect(seen).toHaveLength(0);
  });

  test("missing secret config → accepted unsigned (warn-accept, back-compat)", async () => {
    const seen: unknown[] = [];
    const base = await startWith({ itsaplanSecrets: [] });
    server!.onEvent(async (e) => {
      seen.push(e);
    });
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: envBody(),
    });
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
  });

  test("body larger than cap → 413", async () => {
    const base = await startWith({ maxBodyBytes: 1024 });
    const big = "x".repeat(2048);
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "comment.created", data: { body: big } }),
    });
    expect(res.status).toBe(413);
  });

  test("duplicate (same dedupe key) → 200 duplicate, handler fires once", async () => {
    const seen: unknown[] = [];
    const base = await startWith({ itsaplanSecrets: [], dedupeStore: new MemoryWebhookDedupeStore() });
    server!.onEvent(async (e) => {
      seen.push(e);
    });
    const body = envBody();
    const post = () =>
      fetch(`${base}/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const r1 = await post();
    const r2 = await post();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
  });

  test("invalid JSON → 400", async () => {
    const base = await startWith({ itsaplanSecrets: [] });
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("ItsaplanWebhookServer /telegram-webhook secret", () => {
  test("wrong secret_token → 401", async () => {
    const base = await startWith({ telegramSecret: "tg_secret" });
    const res = await fetch(`${base}/telegram-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "nope" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("right secret_token → 200 and update handler fires", async () => {
    const seen: unknown[] = [];
    const base = await startWith({ telegramSecret: "tg_secret" });
    server!.onTelegramUpdate(async (u) => {
      seen.push(u);
    });
    const res = await fetch(`${base}/telegram-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "tg_secret" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(200);
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
  });
});

describe("internal loopback endpoints", () => {
  test("reporter-reply from loopback → handler payload typed and forwarded", async () => {
    const got: unknown[] = [];
    const base = await startWith({});
    server!.onReporterReply(async (req) => {
      got.push(req);
      return { handled: true, replyText: "ok" };
    });
    const res = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "123", replyToMessageId: 55, text: "chưa ổn ạ", senderName: "Cô A" }),
    });
    expect(res.status).toBe(200);
    expect(got).toEqual([{ chatId: "123", messageId: "55", text: "chưa ổn ạ", userName: "Cô A" }]);
  });

  test("reporter-reply missing fields → 400", async () => {
    const base = await startWith({});
    server!.onReporterReply(async () => ({ handled: true, replyText: "" }));
    const res = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "123" }),
    });
    expect(res.status).toBe(400);
  });

  test("reporter-ok with bad issueId → 400", async () => {
    const base = await startWith({});
    server!.onReporterOk(async () => ({ outcome: "recorded" }));
    const res = await fetch(`${base}/internal/reporter-ok`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("ItsaplanWebhookServer listenHost", () => {
  test("mặc định bind loopback 127.0.0.1", async () => {
    await startWith({});
    expect(server!.host()).toBe("127.0.0.1");
  });

  test("listenHost 0.0.0.0 ⇒ bind mọi giao diện, vẫn nhận webhook ký đúng", async () => {
    const secret = "whsec_any";
    const seen: ItsaplanWebhookEnvelope[] = [];
    server = new ItsaplanWebhookServer({ itsaplanSecrets: [secret], listenHost: "0.0.0.0" });
    server.onEvent(async (e) => { seen.push(e); });
    await server.start(0);
    expect(server.host()).toBe("0.0.0.0");
    const body = envBody();
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${server.port()}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Itsaplan-Signature": sign(secret, ts, body) },
      body,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
  });

  test("listenHost rỗng/khoảng trắng ⇒ về mặc định loopback", async () => {
    await startWith({ listenHost: "  " });
    expect(server!.host()).toBe("127.0.0.1");
  });

  test("endpoint /internal/* vẫn chỉ nhận từ loopback dù bind 0.0.0.0 (nguồn loopback ⇒ nhận)", async () => {
    server = new ItsaplanWebhookServer({ listenHost: "0.0.0.0" });
    let called = 0;
    server.onForceNew(() => { called++; });
    await server.start(0);
    const res = await fetch(`http://127.0.0.1:${server.port()}/internal/force-new`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: "1" }),
    });
    expect(res.status).toBeLessThan(300);
    expect(called).toBe(1);
  });
});
