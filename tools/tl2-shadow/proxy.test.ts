import { describe, expect, it } from "bun:test";
import { createItsaplanProxy, createMinimaxProxy, safePath } from "./proxy.ts";

const KEY = "khoa-that-gia-lap";
type Call = { url: string; init: RequestInit };

function mm(over: Partial<Parameters<typeof createMinimaxProxy>[0]> = {}) {
  const calls: Call[] = [];
  const logs: Record<string, unknown>[] = [];
  const proxy = createMinimaxProxy({
    upstream: "https://llm.example.com/",
    apiKey: KEY,
    models: ["MiniMax-M3.1-Flash"],
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    },
    log: (e) => logs.push(e),
    ...over,
  });
  return { proxy, calls, logs };
}
const req = (path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`http://127.0.0.1:18999${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

describe("MiniMax proxy", () => {
  it("thay xác thực đến bằng khoá thật, chuyển đúng đường dẫn, không log nội dung", async () => {
    const { proxy, calls, logs } = mm();
    const res = await proxy(
      req(
        "/v1/messages",
        { model: "MiniMax-M3.1-Flash", messages: [{ role: "user", content: "bí mật khách hàng" }] },
        {
          authorization: "Bearer khoa-gia-cua-colab",
          "x-api-key": "khoa-gia-cua-colab",
          cookie: "a=b",
          "anthropic-version": "2023-06-01",
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://llm.example.com/v1/messages");
    const h = new Headers(calls[0].init.headers);
    expect(h.get("x-api-key")).toBe(KEY);
    expect(h.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("bí mật");
    expect(logged).not.toContain(KEY);
    expect(logs[0]).toMatchObject({
      svc: "minimax",
      path: "/v1/messages",
      status: 200,
      model: "MiniMax-M3.1-Flash",
    });
  });

  it("chặn đường dẫn, phương thức và model ngoài allowlist", async () => {
    const { proxy, calls } = mm();
    expect((await proxy(req("/v1/models", {}, {}, "GET"))).status).toBe(403);
    expect((await proxy(req("/v1/embeddings", { model: "MiniMax-M3.1-Flash" }))).status).toBe(403);
    expect((await proxy(req("/v1/messages", { model: "gpt-x" }))).status).toBe(403);
    expect((await proxy(req("/v1/messages", {}, {}, "GET"))).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("trần tốc độ trả 429", async () => {
    let t = 1_000_000;
    const { proxy } = mm({ ratePerMin: 2, now: () => t });
    const ok = () => proxy(req("/v1/chat/completions", { model: "MiniMax-M3.1-Flash" }));
    expect((await ok()).status).toBe(200);
    expect((await ok()).status).toBe(200);
    expect((await ok()).status).toBe(429);
    t += 61_000;
    expect((await ok()).status).toBe(200);
  });

  it("upstream lỗi trả 502 không lộ chi tiết", async () => {
    const { proxy } = mm({
      fetchImpl: async () => {
        throw new Error(`connect tới ${KEY} thất bại`);
      },
    });
    const res = await proxy(req("/v1/messages", { model: "MiniMax-M3.1-Flash" }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(KEY);
  });
});

function it2(issues: Record<number, string>) {
  const calls: { method: string; path: string; headers: Headers; body?: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  let nextId = 900;
  const proxy = createItsaplanProxy({
    upstream: "https://tracker.example.com/api",
    apiKey: KEY,
    projectKey: "TECH2",
    log: (e) => logs.push(e),
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      const path = u.pathname.replace("/api", "");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        headers: new Headers(init?.headers),
        body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined,
      });
      const m = path.match(/^\/issues\/(\d+)$/);
      if (method === "GET" && m) {
        const ident = issues[Number(m[1])];
        return ident
          ? Response.json({ id: Number(m[1]), identifier: ident })
          : new Response("nf", { status: 404 });
      }
      if (method === "POST" && path === "/projects/TECH2/issues") {
        const id = nextId++;
        issues[id] = `TECH2-${id}`;
        return Response.json({ id, identifier: `TECH2-${id}` }, { status: 201 });
      }
      return Response.json({ ok: true });
    },
  });
  return { proxy, calls, logs };
}
const ireq = (method: string, path: string, body?: unknown) =>
  new Request(`http://127.0.0.1:18998${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer khoa-gia" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("itsaplan proxy", () => {
  it("GET đi qua kèm khoá thật, bỏ xác thực đến", async () => {
    const { proxy, calls } = it2({});
    const res = await proxy(ireq("GET", "/projects/TECH2/issues?limit=2"));
    expect(res.status).toBe(200);
    expect(calls[0].headers.get("x-api-key")).toBe(KEY);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("tạo ticket chỉ vào TECH2; project khác bị chặn", async () => {
    const { proxy, calls } = it2({});
    expect(
      (await proxy(ireq("POST", "/projects/TECH2/issues", { title: "[smoke] x" }))).status,
    ).toBe(201);
    expect((await proxy(ireq("POST", "/projects/TECH/issues", { title: "x" }))).status).toBe(403);
    expect((await proxy(ireq("POST", "/projects/PO/issues", { title: "x" }))).status).toBe(403);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("ghi vào ticket chỉ khi đã kiểm tra thuộc TECH2 (kể cả ticket vừa tạo qua proxy)", async () => {
    const { proxy, calls } = it2({ 5: "TECH2-5", 6: "TECH-6" });
    expect((await proxy(ireq("PATCH", "/issues/5", { title: "mới" }))).status).toBe(200);
    expect((await proxy(ireq("POST", "/issues/5/comments", { body: "hi" }))).status).toBe(200);
    expect((await proxy(ireq("PATCH", "/issues/6", { title: "hack" }))).status).toBe(403);
    expect((await proxy(ireq("PATCH", "/issues/404", { title: "x" }))).status).toBe(403);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    const created = (await (
      await proxy(ireq("POST", "/projects/TECH2/issues", { title: "[smoke]" }))
    ).json()) as { id: number };
    expect((await proxy(ireq("PATCH", `/issues/${created.id}`, { title: "ok" }))).status).toBe(200);
  });

  it("link sang ticket ngoài TECH2 bị chặn", async () => {
    const { proxy } = it2({ 5: "TECH2-5", 6: "TECH-6", 7: "TECH2-7" });
    expect(
      (await proxy(ireq("POST", "/issues/5/links", { targetIssueId: 6, kind: "relates" }))).status,
    ).toBe(403);
    expect(
      (await proxy(ireq("POST", "/issues/5/links", { targetIssueId: 7, kind: "relates" }))).status,
    ).toBe(200);
  });

  it("chặn DELETE, webhook, đổi project/team, đường dẫn gian lận", async () => {
    const { proxy, calls } = it2({ 5: "TECH2-5" });
    const cases: [string, string][] = [
      ["DELETE", "/issues/5"],
      ["DELETE", "/issues/5/links/1"],
      ["POST", "/projects/TECH2/webhooks"],
      ["GET", "/projects/TECH2/webhooks"],
      ["POST", "/projects"],
      ["PATCH", "/projects/TECH2"],
      ["PATCH", "/teams/32"],
      ["PATCH", "/issues/5/../../projects/TECH"],
      ["PATCH", "/issues/5%2f..%2fprojects"],
    ];
    for (const [m, p] of cases) {
      const res = await proxy(ireq(m, p, {}));
      expect([m, p, res.status >= 400]).toEqual([m, p, true]);
    }
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("log mọi lệnh gọi, không có body hay khoá", async () => {
    const { proxy, logs } = it2({ 5: "TECH2-5" });
    await proxy(ireq("PATCH", "/issues/5", { description: "nội dung nhạy cảm" }));
    await proxy(ireq("DELETE", "/issues/5"));
    expect(logs.map((l) => [l.method, l.decision])).toEqual([
      ["PATCH", "allow"],
      ["DELETE", "deny"],
    ]);
    expect(JSON.stringify(logs)).not.toContain("nhạy cảm");
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });
});

describe("safePath", () => {
  it("từ chối .., //, %, \\ và ký tự lạ", () => {
    expect(safePath("/issues/5/comments")).toBe(true);
    for (const p of ["/a/../b", "/a//b", "/a%2fb", "/a\\b", "/a b", "issues"])
      expect(safePath(p)).toBe(false);
  });
});
