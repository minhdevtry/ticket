import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, {
  SPOOL_MAX_BYTES,
  buildInbound,
  buildOutbound,
  buildTool,
  drainSpool,
  resolveConfig,
  send,
  spoolAppend,
} from "./index.mjs";

const PREFIX = "agent:ticket-intake-agent:";
const SK = `${PREFIX}telegram:ticket:direct:1000000001`;
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shadow-fwd-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const cfgFor = (dir, extra = {}) => ({
  relayUrl: "http://127.0.0.1:1/ingest",
  token: null,
  sessionPrefix: PREFIX,
  timeoutMs: 300,
  tools: true,
  spoolPath: join(dir, "spool.jsonl"),
  logPath: join(dir, "log"),
  ...extra,
});

function register(pluginConfig) {
  const handlers = {};
  plugin.register({
    on: (name, fn) => {
      handlers[name] = fn;
    },
    pluginConfig,
  });
  return handlers;
}

describe("register", () => {
  it("đăng ký đúng 3 hook quan sát, không có hook chặn, handler trả undefined và không chờ mạng", () => {
    const handlers = register({ relayUrl: "http://127.0.0.1:1/ingest", timeoutMs: 300 });
    expect(Object.keys(handlers).sort()).toEqual([
      "after_tool_call",
      "message_received",
      "message_sent",
    ]);
    const t0 = performance.now();
    const r = handlers.message_received(
      { content: "xin chào", sessionKey: SK, messageId: "9" },
      { conversationId: "telegram:1000000001", accountId: "ticket" },
    );
    expect(r).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("chưa có relayUrl thì không đăng ký hook nào", () => {
    const saved = process.env.SHADOW_RELAY_URL;
    delete process.env.SHADOW_RELAY_URL;
    try {
      expect(register({})).toEqual({});
    } finally {
      if (saved !== undefined) process.env.SHADOW_RELAY_URL = saved;
    }
  });

  it("tools:false bỏ hook after_tool_call", () => {
    const handlers = register({ relayUrl: "http://127.0.0.1:1/x", tools: false });
    expect(handlers.after_tool_call).toBeUndefined();
  });

  it("handler không ném lỗi dù event rỗng", () => {
    const handlers = register({ relayUrl: "http://127.0.0.1:1/x" });
    expect(() => handlers.message_received(undefined, undefined)).not.toThrow();
    expect(() => handlers.message_sent(null, null)).not.toThrow();
    expect(() => handlers.after_tool_call({}, {})).not.toThrow();
  });
});

describe("resolveConfig", () => {
  it("lấy relayUrl từ config rồi từ env, không có mặc định", () => {
    expect(resolveConfig({}, {})).toBeNull();
    expect(resolveConfig({}, { SHADOW_RELAY_URL: "http://10.0.0.5:3106/ingest" })?.relayUrl).toBe(
      "http://10.0.0.5:3106/ingest",
    );
    const c = resolveConfig(
      { relayUrl: "http://a/b", timeoutMs: 900 },
      { OPENCLAW_STATE_DIR: "/x" },
    );
    expect(c).toMatchObject({ relayUrl: "http://a/b", timeoutMs: 900, sessionPrefix: PREFIX });
    expect(c?.spoolPath).toBe("/x/shadow-forwarder.spool.jsonl");
  });
});

describe("builders", () => {
  it("inbound: chat nhóm, người gửi, reply, eid ổn định", () => {
    const p = buildInbound(
      {
        content: "x",
        sessionKey: `${PREFIX}telegram:ticket:group:-1000000000001`,
        messageId: "5",
        senderId: "1000000007",
        replyToId: "3",
        replyToBody: "trước đó",
        metadata: { senderName: "An Test", senderUsername: "an_test" },
      },
      { conversationId: "telegram:-1000000000001", accountId: "ticket" },
    );
    expect(p).toMatchObject({
      kind: "inbound",
      eid: "in:ticket:-1000000000001:5",
      chatId: "-1000000000001",
      isGroup: true,
      senderName: "An Test",
      senderUsername: "an_test",
      replyTo: { id: "3", body: "trước đó" },
    });
  });

  it("inbound: cắt text quá dài", () => {
    const p = buildInbound({ content: "a".repeat(20000), sessionKey: SK }, { conversationId: "1" });
    expect(p.text.length).toBe(8000);
  });

  it("outbound và tool", () => {
    const o = buildOutbound(
      { content: "đã nhận", success: true, messageId: "11", sessionKey: SK },
      { conversationId: "telegram:1000000001", accountId: "ticket" },
    );
    expect(o).toMatchObject({
      kind: "outbound",
      chatId: "1000000001",
      text: "đã nhận",
      success: true,
    });
    const t = buildTool(
      { toolName: "ticketintake__intake_step", params: { chatId: "1000000001" }, result: { a: 1 } },
      { sessionKey: SK },
    );
    expect(t).toMatchObject({
      kind: "tool",
      tool: "ticketintake__intake_step",
      params: { chatId: "1000000001" },
      ok: true,
    });
    expect(buildTool({ toolName: "t", error: "boom" }, {}).ok).toBe(false);
  });
});

describe("send / spool / drain", () => {
  it("gửi JSON tới relay kèm token", async () => {
    let got;
    let auth;
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        got = await req.json();
        auth = req.headers.get("x-shadow-token");
        return new Response("ok");
      },
    });
    const dir = tmp();
    send(
      cfgFor(dir, {
        relayUrl: `http://127.0.0.1:${srv.port}/ingest`,
        token: "abc",
        timeoutMs: 1000,
      }),
      { kind: "inbound", text: "z" },
    );
    await Bun.sleep(150);
    srv.stop(true);
    expect(got.text).toBe("z");
    expect(auth).toBe("abc");
    expect(existsSync(join(dir, "spool.jsonl"))).toBe(false);
  });

  it("relay chết thì ghi spool (0600), không ném", async () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    expect(() => send(cfg, { kind: "inbound", eid: "a", text: "một" })).not.toThrow();
    await Bun.sleep(150);
    const lines = readFileSync(cfg.spoolPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).text).toBe("một");
    expect(statSync(cfg.spoolPath).mode & 0o777).toBe(0o600);
  });

  it("spool dừng ghi khi đạt trần 5 MB", () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    writeFileSync(cfg.spoolPath, "x".repeat(SPOOL_MAX_BYTES));
    expect(spoolAppend(cfg, { kind: "inbound" })).toBe(false);
    expect(statSync(cfg.spoolPath).size).toBe(SPOOL_MAX_BYTES);
  });

  it("drain gửi lại theo thứ tự rồi xoá spool; lỗi giữa chừng trả phần còn lại về spool", async () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    for (const n of ["1", "2", "3"]) spoolAppend(cfg, { kind: "inbound", eid: n });
    const seen = [];
    let calls = 0;
    const flaky = async (_url, init) => {
      calls++;
      if (calls === 3) throw new Error("down");
      seen.push(JSON.parse(init.body).eid);
      return new Response("ok");
    };
    expect(await drainSpool(cfg, flaky, { force: true })).toBe(2);
    expect(seen).toEqual(["1", "2"]);
    expect(
      readFileSync(cfg.spoolPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).eid),
    ).toEqual(["3"]);
    expect(existsSync(`${cfg.spoolPath}.draining`)).toBe(false);

    const ok = async (_url, init) => {
      seen.push(JSON.parse(init.body).eid);
      return new Response("ok");
    };
    expect(await drainSpool(cfg, ok, { force: true })).toBe(1);
    expect(seen).toEqual(["1", "2", "3"]);
    expect(existsSync(cfg.spoolPath)).toBe(false);
  });
});
