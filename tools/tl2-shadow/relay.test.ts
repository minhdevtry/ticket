import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { CHAT, cleanTmp, inbound, testConfig, tmpDir } from "./fixtures.ts";
import { EventStore } from "./queue.ts";
import { createHmac } from "node:crypto";
import {
  createHandler,
  ipAllowed,
  normalizeEvent,
  startRelay,
  verifyWebhookSignature,
} from "./relay.ts";

afterEach(cleanTmp);

function handler(extra: Record<string, string> = {}) {
  const dir = tmpDir();
  const cfg = testConfig(dir, extra);
  const events = new EventStore(join(dir, "events.jsonl"));
  const h = createHandler({ cfg, events, worker: { pendingCount: () => 0, isDown: () => false } });
  return { h, events };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://relay/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("ipAllowed", () => {
  it("loopback và IP trong danh sách, kể cả dạng ::ffff:", () => {
    const allow = ["10.0.0.5"];
    expect(ipAllowed("127.0.0.1", allow)).toBe(true);
    expect(ipAllowed("::1", allow)).toBe(true);
    expect(ipAllowed("::ffff:10.0.0.5", allow)).toBe(true);
    expect(ipAllowed("10.0.0.6", allow)).toBe(false);
    expect(ipAllowed(undefined, allow)).toBe(false);
  });
});

describe("normalizeEvent", () => {
  it("chỉ giữ trường biết trước, từ chối sự kiện thiếu eid/chatId", () => {
    const ev = normalizeEvent({ ...inbound(1, 5), extra: "rác", secret: "x" });
    expect(ev && "extra" in ev).toBe(false);
    expect(normalizeEvent({ v: 1, kind: "inbound", ts: 1, chatId: CHAT, text: "x" })).toBeNull();
    expect(normalizeEvent({ ...inbound(1, 5), chatId: "" })).toBeNull();
    expect(normalizeEvent({ ...inbound(1, 5), kind: "lạ" })).toBeNull();
    expect(normalizeEvent("chuỗi")).toBeNull();
    for (const chatId of ["1".repeat(65), "a b", "../x", "1\n2", "x/y"]) {
      expect(normalizeEvent({ ...inbound(1, 5), chatId })).toBeNull();
    }
    expect(normalizeEvent({ ...inbound(1, 5), chatId: "-1000000000001" })).not.toBeNull();
  });
});

describe("POST /ingest", () => {
  it("nhận từ IP cho phép, khử trùng khi gửi lại", async () => {
    const { h, events } = handler();
    const r1 = await h(post(inbound(1, 5)), "10.0.0.5");
    expect(r1.status).toBe(202);
    expect(await r1.json()).toMatchObject({ added: 1, dup: 0 });
    const r2 = await h(post(inbound(1, 5)), "::ffff:10.0.0.5");
    expect(await r2.json()).toMatchObject({ added: 0, dup: 1 });
    expect(events.size()).toBe(1);
  });

  it("từ chối IP lạ (403) trước khi đọc body", async () => {
    const { h, events } = handler();
    expect((await h(post(inbound(1, 5)), "10.0.0.99")).status).toBe(403);
    expect(events.size()).toBe(0);
  });

  it("body hỏng 400, quá lớn 413, đường dẫn lạ 404", async () => {
    const { h } = handler();
    expect((await h(post("{không phải json"), "127.0.0.1")).status).toBe(400);
    expect((await h(post({ v: 1 }), "127.0.0.1")).status).toBe(400);
    expect((await h(post("x".repeat(300_000)), "127.0.0.1")).status).toBe(413);
    expect((await h(new Request("http://relay/khac"), "127.0.0.1")).status).toBe(404);
  });

  it("có SHADOW_RELAY_TOKEN thì bắt buộc header x-shadow-token", async () => {
    const { h } = handler({ SHADOW_RELAY_TOKEN: "token-thu-nghiem" });
    expect((await h(post(inbound(1, 5)), "127.0.0.1")).status).toBe(401);
    expect((await h(post(inbound(1, 5), { "x-shadow-token": "sai" }), "127.0.0.1")).status).toBe(
      401,
    );
    expect(
      (await h(post(inbound(1, 5), { "x-shadow-token": "token-thu-nghiem" }), "127.0.0.1")).status,
    ).toBe(202);
  });

  it("nhận mảng sự kiện (spool gửi lại)", async () => {
    const { h, events } = handler();
    const r = await h(post([inbound(1, 5), inbound(2, 6), { rác: true }]), "127.0.0.1");
    expect(await r.json()).toMatchObject({ added: 2, invalid: 1 });
    expect(events.size()).toBe(2);
  });
});

describe("startRelay (cổng thật)", () => {
  it("nghe trên loopback, nhận sự kiện và /health", async () => {
    const dir = tmpDir();
    const cfg = { ...testConfig(dir), host: "127.0.0.1", port: 0 };
    const relay = startRelay(cfg, () => {});
    try {
      const base = `http://127.0.0.1:${relay.server.port}`;
      const r = await fetch(`${base}/ingest`, {
        method: "POST",
        body: JSON.stringify(inbound(1, 5)),
      });
      expect(r.status).toBe(202);
      const health = await (await fetch(`${base}/health`)).json();
      expect(health).toMatchObject({ ok: true, events: 1 });
    } finally {
      relay.stop();
    }
  });
});

const SECRET = "whsec_" + "b".repeat(24);
const NOW = 1_800_000_000_000;
const sign = (body: string, secret = SECRET, t = Math.floor(NOW / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

function hookHandler(forward: (url: string, init: RequestInit) => Promise<Response>) {
  const dir = tmpDir();
  const cfg = testConfig(dir, { ITSAPLAN_WEBHOOK_SECRET: SECRET });
  const events = new EventStore(join(dir, "events.jsonl"));
  const logs: string[] = [];
  const h = createHandler({
    cfg,
    events,
    worker: { pendingCount: () => 0, isDown: () => false },
    now: () => NOW,
    fetchImpl: forward,
    log: (m) => logs.push(m),
  });
  return { h, events, logs };
}
const hook = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://relay/itsaplan-webhook", { method: "POST", headers, body });

describe("verifyWebhookSignature", () => {
  it("chấp nhận chữ ký đúng; từ chối sai secret, sai body, lệch giờ, header hỏng", () => {
    const body = '{"event":"comment.created"}';
    const now = Math.floor(NOW / 1000);
    expect(verifyWebhookSignature(sign(body), body, SECRET, now)).toBe(true);
    expect(verifyWebhookSignature(sign(body, "khac-khac-khac-khac"), body, SECRET, now)).toBe(
      false,
    );
    expect(verifyWebhookSignature(sign(body), `${body} `, SECRET, now)).toBe(false);
    expect(verifyWebhookSignature(sign(body, SECRET, now - 600), body, SECRET, now)).toBe(false);
    for (const bad of [undefined, null, "", "t=abc,v1=00", "v1=zz", `t=${now},v1=abc`, "rác"])
      expect(verifyWebhookSignature(bad, body, SECRET, now)).toBe(false);
  });
});

describe("POST /itsaplan-webhook", () => {
  const BODY = JSON.stringify({ event: "comment.created", data: { id: 1, issueId: 5 } });

  it("chữ ký đúng: chuyển nguyên body tới app, không ghi hàng đợi, log không có nội dung", async () => {
    const seen: { url: string; body: string; sig: string | null }[] = [];
    const { h, events, logs } = hookHandler(async (url, init) => {
      seen.push({
        url,
        body: String(init.body),
        sig: new Headers(init.headers).get("x-itsaplan-signature"),
      });
      return new Response("{}", { status: 200 });
    });
    const r = await h(hook(BODY, { "x-itsaplan-signature": sign(BODY) }), "10.0.0.5");
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ url: "http://127.0.0.1:3120/webhook", body: BODY, sig: null }]);
    expect(events.size()).toBe(0);
    expect(logs.join("\n")).toContain("comment.created");
    expect(logs.join("\n")).not.toContain("issueId");
  });

  it("thiếu hoặc sai chữ ký: 401, không chuyển tiếp; IP lạ: 403", async () => {
    let calls = 0;
    const { h } = hookHandler(async () => {
      calls++;
      return new Response("{}");
    });
    expect((await h(hook(BODY), "10.0.0.5")).status).toBe(401);
    expect(
      (
        await h(
          hook(BODY, { "x-itsaplan-signature": sign(BODY, "sai-sai-sai-sai-sai") }),
          "10.0.0.5",
        )
      ).status,
    ).toBe(401);
    expect((await h(hook(BODY, { "x-itsaplan-signature": sign(BODY) }), "10.0.0.99")).status).toBe(
      403,
    );
    // token của /ingest KHÔNG thay được chữ ký
    expect((await h(hook(BODY, { "x-shadow-token": "bat-ky" }), "10.0.0.5")).status).toBe(401);
    expect(calls).toBe(0);
  });

  it("sự kiện ngoài danh sách được nhận (202) và bỏ; JSON hỏng 400; quá lớn 413", async () => {
    let calls = 0;
    const { h } = hookHook();
    function hookHook() {
      return hookHandler(async () => {
        calls++;
        return new Response("{}");
      });
    }
    const other = JSON.stringify({ event: "issue.deleted", data: {} });
    expect((await h(hook(other, { "x-itsaplan-signature": sign(other) }), "10.0.0.5")).status).toBe(
      202,
    );
    const bad = "{không phải json";
    expect((await h(hook(bad, { "x-itsaplan-signature": sign(bad) }), "10.0.0.5")).status).toBe(
      400,
    );
    const big = "x".repeat(300_000);
    expect((await h(hook(big, { "x-itsaplan-signature": sign(big) }), "10.0.0.5")).status).toBe(
      413,
    );
    expect(calls).toBe(0);
  });

  it("app không với tới hoặc trả lỗi: 502 để itsaplan thử lại", async () => {
    const down = hookHandler(async () => {
      throw new Error("ECONNREFUSED");
    });
    const sig = { "x-itsaplan-signature": sign(BODY) };
    expect((await down.h(hook(BODY, sig), "10.0.0.5")).status).toBe(502);
    const err = hookHandler(async () => new Response("x", { status: 500 }));
    expect((await err.h(hook(BODY, sig), "10.0.0.5")).status).toBe(502);
  });

  it("chưa cấu hình secret: đường này không tồn tại (404)", async () => {
    const { h } = handler();
    expect((await h(hook(BODY, { "x-itsaplan-signature": sign(BODY) }), "10.0.0.5")).status).toBe(
      404,
    );
  });
});
