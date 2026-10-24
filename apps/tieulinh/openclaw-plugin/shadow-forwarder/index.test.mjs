import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, {
  BREAKER_MS,
  MAX_PARAMS_CHARS,
  SPOOL_MAX_BYTES,
  SPOOL_TTL_MS,
  boundedParams,
  buildInbound,
  buildOutbound,
  buildTool,
  drainSpool,
  inScope,
  pruneSpool,
  resetState,
  resolveConfig,
  send,
  spoolAppend,
  validateConfig,
} from "./index.mjs";

// Không bao giờ để test chạm ~/.openclaw thật.
process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "shadow-fwd-state-"));

const PREFIX = "agent:ticket-intake-agent:";
const SK = `${PREFIX}telegram:ticket:direct:1000000001`;
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shadow-fwd-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  resetState();
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

  it("cấu hình sai thì plugin tự tắt (không hook nào)", () => {
    expect(register({ relayUrl: "http://127.0.0.1:1/x", sessionPrefix: "" })).toEqual({});
    expect(register({ relayUrl: "http://10.0.0.5:1/x" })).toEqual({});
    expect(register({ relayUrl: "http://relay.example.com/x" })).toEqual({});
  });

  it("H3: tin của agent khác không bao giờ được chuyển tiếp", async () => {
    const real = globalThis.fetch;
    const calls = [];
    process.env.OPENCLAW_STATE_DIR = tmp(); // spool riêng, không lẫn sự kiện test khác
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response("ok");
    };
    try {
      const h = register({ relayUrl: "http://127.0.0.1:1/x" });
      const ctx = (sk) => ({ conversationId: "telegram:1", sessionKey: sk });
      for (const sk of [
        "agent:other-agent:telegram:ticket:direct:1",
        "agent:ticket-intake-agent-2:shadow:1",
        "agent:ticket-intake-agent",
        "",
        undefined,
        "main",
      ]) {
        h.message_received({ content: "x", sessionKey: sk }, ctx(sk));
        h.message_sent({ content: "x", sessionKey: sk }, ctx(sk));
        h.after_tool_call({ toolName: "t" }, ctx(sk));
      }
      await Bun.sleep(30);
      expect(calls).toHaveLength(0);
      resetState();
      h.message_received({ content: "x", sessionKey: SK, messageId: "1" }, ctx(SK));
      await Bun.sleep(30);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
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

describe("validateConfig", () => {
  const ok = { relayUrl: "http://127.0.0.1:3106/ingest" };
  const err = (c, env = {}) => validateConfig(c, env).error;

  it("không có mặc định cho relayUrl; nhận từ config hoặc env", () => {
    expect(err({}, {})).toContain("relayUrl");
    const env = {
      SHADOW_RELAY_URL: "http://10.0.0.5:3106/ingest",
      SHADOW_RELAY_TOKEN: "t".repeat(16),
    };
    expect(resolveConfig({}, env)?.relayUrl).toBe("http://10.0.0.5:3106/ingest");
    const c = resolveConfig({ ...ok, timeoutMs: 900 }, { OPENCLAW_STATE_DIR: "/x" });
    expect(c).toMatchObject({ timeoutMs: 900, sessionPrefix: PREFIX });
    expect(c?.spoolPath).toBe("/x/shadow-forwarder.spool.jsonl");
  });

  it("H3: sessionPrefix rỗng, thiếu dấu ':' cuối hoặc sai dạng bị từ chối", () => {
    for (const bad of [
      "",
      "agent:",
      "agent::",
      "agent:ticket-intake-agent",
      "agent:Bad:",
      "x:",
      "agent:a:b:",
      ":",
    ]) {
      expect([bad, err({ ...ok, sessionPrefix: bad })]).toEqual([
        bad,
        expect.stringContaining("sessionPrefix"),
      ]);
    }
    expect(err({ ...ok, sessionPrefix: 5 })).toContain("sessionPrefix");
    expect(validateConfig({ ...ok, sessionPrefix: "agent:ticket-intake-agent:" }).cfg).toBeTruthy();
  });

  it("H4: relay ngoài loopback bắt buộc token đủ dài; loopback thì không", () => {
    const lan = { relayUrl: "http://10.0.0.5:3106/ingest" };
    expect(err(lan)).toContain("token");
    expect(err({ ...lan, token: "ngan" })).toContain("token");
    expect(validateConfig({ ...lan, token: "t".repeat(16) }).cfg?.token).toBe("t".repeat(16));
    expect(validateConfig(ok).cfg).toBeTruthy();
    expect(validateConfig({ relayUrl: "http://[::1]:3106/x" }).cfg).toBeTruthy();
  });

  it("M5: relayUrl phải là http(s) tới IP, không userinfo, không hostname", () => {
    for (const bad of [
      "ftp://10.0.0.5/x",
      "http://relay.example.com/x",
      "http://user:pw@127.0.0.1/x",
      "khong-phai-url",
      "file:///etc/passwd",
    ]) {
      expect([bad, typeof err({ relayUrl: bad, token: "t".repeat(16) })]).toEqual([bad, "string"]);
    }
  });

  it("timeoutMs sai bị từ chối thay vì thành NaN", () => {
    for (const bad of ["abc", 50, 99999, 1.5, NaN])
      expect(err({ ...ok, timeoutMs: bad })).toContain("timeoutMs");
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

  it("M3: tool không mang result; params quá lớn bị thay bằng cỡ", () => {
    const t = buildTool(
      { toolName: "t", params: { a: 1 }, result: { secret: "dữ liệu khách" } },
      {},
    );
    expect("result" in t).toBe(false);
    expect(JSON.stringify(t)).not.toContain("dữ liệu khách");
    const big = boundedParams({ text: "x".repeat(MAX_PARAMS_CHARS * 2) });
    expect(big).toMatchObject({ _truncated: true });
    expect(JSON.stringify(big).length).toBeLessThan(100);
    const circular = {};
    circular.self = circular;
    expect(boundedParams(circular)).toEqual({ _unserializable: true });
  });

  it("chatId bị cắt ở 64 ký tự", () => {
    const p = buildInbound({ content: "x", sessionKey: SK }, { conversationId: "9".repeat(500) });
    expect(p.chatId).toHaveLength(64);
    expect(inScope(SK, "")).toBe(false);
    expect(inScope(SK, "agent:")).toBe(false);
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
      { kind: "inbound", text: "z", ts: Date.now() },
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
    expect(() =>
      send(cfg, { kind: "inbound", eid: "a", text: "một", ts: Date.now() }),
    ).not.toThrow();
    await Bun.sleep(150);
    const lines = readFileSync(cfg.spoolPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]).text).toBe("một");
    expect(statSync(cfg.spoolPath).mode & 0o777).toBe(0o600);
  });

  it("M2: relay từ chối 4xx thì bỏ (không spool); 408/429/5xx thì spool", async () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    const status = (s) => async () => new Response("no", { status: s });
    send(cfg, { kind: "inbound", eid: "a", ts: Date.now() }, status(400));
    await Bun.sleep(30);
    expect(existsSync(cfg.spoolPath)).toBe(false);
    for (const s of [429, 503]) {
      resetState();
      send(cfg, { kind: "inbound", eid: `s${s}`, ts: Date.now() }, status(s));
      await Bun.sleep(30);
    }
    const eids = readFileSync(cfg.spoolPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).eid);
    expect(eids).toEqual(["s429", "s503"]);
  });

  it("M4: cầu dao 60 giây sau lỗi: không gọi mạng nữa, chỉ spool", async () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    let calls = 0;
    const down = async () => {
      calls++;
      throw new Error("down");
    };
    send(cfg, { kind: "inbound", eid: "1", ts: Date.now() }, down);
    await Bun.sleep(30);
    send(cfg, { kind: "inbound", eid: "2", ts: Date.now() }, down);
    send(cfg, { kind: "inbound", eid: "3", ts: Date.now() }, down);
    await Bun.sleep(30);
    expect(calls).toBe(1);
    expect(readFileSync(cfg.spoolPath, "utf8").trim().split("\n")).toHaveLength(3);
    expect(BREAKER_MS).toBe(60_000);
  });

  it("M4: drain bỏ sự kiện quá TTL 48 giờ và sự kiện bị relay từ chối hẳn", async () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    const now = Date.now();
    spoolAppend(cfg, { kind: "inbound", eid: "cu", ts: now - SPOOL_TTL_MS - 1000 });
    spoolAppend(cfg, { kind: "inbound", eid: "xau", ts: now });
    spoolAppend(cfg, { kind: "inbound", eid: "tot", ts: now });
    const seen = [];
    const f = async (_u, init) => {
      const p = JSON.parse(init.body);
      seen.push(p.eid);
      return p.eid === "xau" ? new Response("no", { status: 400 }) : new Response("ok");
    };
    expect(await drainSpool(cfg, f, { force: true })).toBe(1);
    expect(seen).toEqual(["xau", "tot"]);
    expect(existsSync(cfg.spoolPath)).toBe(false);
  });

  it("M4: pruneSpool dọn sự kiện quá hạn, giữ sự kiện còn hạn", async () => {
    const dir = tmp();
    const cfg = cfgFor(dir);
    const now = Date.now();
    spoolAppend(cfg, { eid: "cu", ts: now - SPOOL_TTL_MS - 1 });
    spoolAppend(cfg, { eid: "moi", ts: now });
    expect(await pruneSpool(cfg, now)).toBe(1);
    expect(readFileSync(cfg.spoolPath, "utf8")).toContain("moi");
    expect(readFileSync(cfg.spoolPath, "utf8")).not.toContain("cu");
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
    for (const n of ["1", "2", "3"]) spoolAppend(cfg, { kind: "inbound", eid: n, ts: Date.now() });
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
