import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  CHAT,
  cleanTmp,
  completion,
  inbound,
  outbound,
  testConfig,
  tmpDir,
  tool,
} from "./fixtures.ts";
import { EventStore, PairStore } from "./queue.ts";
import { ShadowWorker, buildEnvelope, buildMessages } from "./worker.ts";

afterEach(cleanTmp);

function setup(extra: Record<string, string> = {}) {
  const dir = tmpDir();
  const cfg = testConfig(dir, extra);
  const events = new EventStore(join(dir, "events.jsonl"));
  const pairs = new PairStore(join(dir, "pairs.jsonl"));
  return { cfg, events, pairs };
}

describe("phong bì và messages", () => {
  it("phong bì mang chat_id và người gửi; messages có ngữ cảnh TL1 làm assistant", () => {
    const { events } = setup();
    events.add(inbound(1, 100, "máy in hỏng"));
    events.add(outbound(1, 110, "Anh/chị cho em xin mã đơn"));
    events.add(inbound(2, 200, "mã DH0001"));
    const cur = events.inboundsOf(CHAT)[1];
    const env = buildEnvelope(cur);
    expect(env).toContain("Conversation info (untrusted metadata)");
    expect(env).toContain(`"chat_id": "telegram:${CHAT}"`);
    expect(env).toContain("An Test");
    expect(env.endsWith("mã DH0001")).toBe(true);
    const msgs = buildMessages(cur, events.recentTurns(cur, 4, 1e6));
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[0].content).toBe("máy in hỏng");
    expect(msgs[1].content).toBe("Anh/chị cho em xin mã đơn");
  });
});

describe("ShadowWorker", () => {
  it("gọi gateway với session key theo chat, ghi cặp sau khi TL1 xong", async () => {
    const { cfg, events, pairs } = setup();
    let seen: { url: string; headers: Headers; body: any } | undefined;
    let now = 10_000;
    const w = new ShadowWorker({
      cfg,
      events,
      pairs,
      now: () => now,
      readToken: () => "tok",
      fetchImpl: async (url, init) => {
        seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return completion("TL2 đáp");
      },
    });
    events.add(inbound(1, 10_000, "máy tính không lên"));
    await w.tick();
    expect(seen?.url).toBe("http://127.0.0.1:18796/v1/chat/completions");
    expect(seen?.headers.get("authorization")).toBe("Bearer tok");
    expect(seen?.headers.get("x-openclaw-session-key")).toBe(
      `agent:ticket-intake-agent-2:shadow:${CHAT}`,
    );
    expect(seen?.body.model).toBe("openclaw/ticket-intake-agent-2");
    expect(pairs.readAll()).toHaveLength(0); // TL1 chưa trả lời

    events.add(tool(1, 10_500, "ticketintake__intake_step"));
    events.add(outbound(1, 11_000, "TL1 đáp"));
    now = 11_500;
    await w.tick();
    expect(pairs.readAll()).toHaveLength(0); // chưa im lặng đủ lâu
    now = 12_100;
    await w.tick();
    const [p] = pairs.readAll();
    expect(p).toMatchObject({
      chatId: CHAT,
      text: "máy tính không lên",
      tl1: { reply: "TL1 đáp", tools: [{ tool: "ticketintake__intake_step" }] },
      tl2: { reply: "TL2 đáp", error: null, model: "MiniMax-M3.1-Flash" },
    });
    expect(typeof p.tl2.latencyMs).toBe("number");
    expect(w.pendingCount()).toBe(0);
  });

  it("tunnel chưa lên: giữ tin trong hàng đợi, backoff, rồi replay khi trở lại", async () => {
    const { cfg, events, pairs } = setup({ TL2_TL1_WAIT_MAX_MS: "1000" });
    let now = 10_000;
    let up = false;
    let calls = 0;
    const w = new ShadowWorker({
      cfg,
      events,
      pairs,
      now: () => now,
      readToken: () => "tok",
      fetchImpl: async () => {
        calls++;
        if (!up) throw new Error("ConnectionRefused");
        return completion("sau khi tunnel về");
      },
    });
    events.add(inbound(1, 10_000));
    await w.tick();
    expect(calls).toBe(1);
    expect(w.isDown()).toBe(true);
    await w.tick(); // đang backoff: không gọi lại
    expect(calls).toBe(1);
    expect(w.pendingCount()).toBe(1);
    up = true;
    now = 16_000;
    await w.tick();
    now = 17_000;
    await w.tick();
    expect(pairs.readAll()[0].tl2.reply).toBe("sau khi tunnel về");
    expect(w.isDown()).toBe(false);
  });

  it("lỗi HTTP của TL2 ghi vào cặp, không thử lại và không chặn tin sau", async () => {
    const { cfg, events, pairs } = setup({ TL2_TL1_WAIT_MAX_MS: "1000" });
    let now = 10_000;
    const replies = [new Response("boom", { status: 500 }), completion("ổn")];
    const w = new ShadowWorker({
      cfg,
      events,
      pairs,
      now: () => now,
      readToken: () => "tok",
      fetchImpl: async () => replies.shift() as Response,
    });
    events.add(inbound(1, 10_000));
    events.add(inbound(2, 10_050));
    await w.tick();
    now = 12_000;
    await w.tick();
    await w.tick();
    const rows = pairs.readAll();
    expect(rows.map((r) => r.eid)).toEqual([`in:ticket:${CHAT}:1`, `in:ticket:${CHAT}:2`]);
    expect(rows[0].tl2.error).toContain("HTTP 500");
    expect(rows[1].tl2.reply).toBe("ổn");
  });

  it("bỏ tin tồn đọng quá 24 giờ và ghi cặp báo lỗi", async () => {
    const { cfg, events, pairs } = setup();
    const day = 24 * 3600_000;
    const w = new ShadowWorker({
      cfg,
      events,
      pairs,
      now: () => 3 * day,
      readToken: () => "tok",
      fetchImpl: async () => {
        throw new Error("không được gọi");
      },
    });
    events.add(inbound(1, 1 * day));
    await w.tick();
    expect(pairs.readAll()[0].tl2.error).toContain("bỏ");
  });

  it("các chat khác nhau chạy song song, cùng chat chạy tuần tự", async () => {
    const { cfg, events, pairs } = setup();
    let active = 0;
    let maxActive = 0;
    const perChat: Record<string, number> = {};
    const w = new ShadowWorker({
      cfg,
      events,
      pairs,
      now: () => 10_000,
      readToken: () => "tok",
      fetchImpl: async (_u, init) => {
        const chat = JSON.parse(String(init?.body))
          .messages.at(-1)
          .content.match(/telegram:(\d+)/)[1];
        perChat[chat] = (perChat[chat] ?? 0) + 1;
        expect(perChat[chat]).toBe(1);
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(30);
        active--;
        perChat[chat]--;
        return completion("ok");
      },
    });
    for (const chat of ["1000000001", "1000000002"]) {
      events.add(inbound(1, 9_000, "a", chat));
      events.add(inbound(2, 9_100, "b", chat));
    }
    await w.tick();
    expect(maxActive).toBe(2);
  });
});
