import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { CHAT, cleanTmp, inbound, testConfig, tmpDir } from "./fixtures.ts";
import { EventStore } from "./queue.ts";
import { createHandler, ipAllowed, normalizeEvent, startRelay } from "./relay.ts";

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
