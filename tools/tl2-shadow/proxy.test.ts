import { describe, expect, it } from "bun:test";
import {
  createItsaplanProxy,
  createMinimaxProxy,
  matchWrite,
  safePath,
  selfTest,
} from "./proxy.ts";

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

  it("M7: Host không phải loopback (DNS rebinding) và content-type không phải JSON bị từ chối", async () => {
    const { proxy, calls } = mm();
    const body = JSON.stringify({ model: "MiniMax-M3.1-Flash" });
    const evil = new Request("http://evil.example.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect((await proxy(evil)).status).toBe(403);
    const text = new Request("http://127.0.0.1:18999/v1/messages", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    expect((await proxy(text)).status).toBe(415);
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

const PROJECT = {
  project: { id: 10, key: "TECH2", ref: "tech.TECH2" },
  columns: [{ id: 51 }, { id: 52 }],
  labels: [{ id: 7 }],
  issueTypes: [{ id: 3 }],
  assignees: [{ userId: "u1" }],
  customFields: [{ id: 20 }],
};

type Upstream = { method: string; url: string; headers: Headers; body?: string };

function it2(issues: Record<number, { identifier: string; projectId: number }>, extra = {}) {
  const calls: Upstream[] = [];
  const logs: Record<string, unknown>[] = [];
  let nextId = 900;
  const proxy = createItsaplanProxy({
    upstream: "https://tracker.example.com/api",
    apiKey: KEY,
    projectKey: "TECH2",
    log: (e) => logs.push(e),
    ...extra,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      const path = u.pathname.replace("/api", "");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: `${path}${u.search}`,
        headers: new Headers(init?.headers),
        body: init?.body ? String(init.body) : undefined,
      });
      if (method === "GET" && path === "/projects/TECH2") return Response.json(PROJECT);
      const m = path.match(/^\/issues\/(\d+)$/);
      if (method === "GET" && m) {
        const issue = issues[Number(m[1])];
        return issue
          ? Response.json({ id: Number(m[1]), ...issue })
          : new Response("nf", { status: 404 });
      }
      if (method === "POST" && path === "/projects/TECH2/issues") {
        const id = nextId++;
        issues[id] = { identifier: `TECH2-${id}`, projectId: 10 };
        return Response.json({ id, identifier: `TECH2-${id}`, projectId: 10 }, { status: 201 });
      }
      return Response.json({ ok: true });
    },
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { proxy, calls, logs, writes };
}

const OWN = { identifier: "TECH2-5", projectId: 10 };
const PROD = { identifier: "TECH-6", projectId: 3 };
const base = { 5: OWN, 6: PROD, 7: { identifier: "TECH2-7", projectId: 10 } };

const ireq = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) =>
  new Request(`http://127.0.0.1:18998${path}`, {
    method,
    headers: { authorization: "Bearer khoa-gia", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const status = async (p: ReturnType<typeof it2>["proxy"], r: Request) => (await p(r)).status;

describe("itsaplan proxy: đọc (H2)", () => {
  it("chỉ đọc project thử (cả dạng có team) và ticket thuộc project thử; kèm khoá thật", async () => {
    const { proxy, calls } = it2({ ...base });
    expect(await status(proxy, ireq("GET", "/projects/TECH2/issues?limit=2"))).toBe(200);
    expect(await status(proxy, ireq("GET", "/projects/tech.TECH2/issues/search?q=a"))).toBe(200);
    expect(await status(proxy, ireq("GET", "/issues/5"))).toBe(200);
    expect(await status(proxy, ireq("GET", "/issues/5/comments"))).toBe(200);
    const h = calls.at(-1)?.headers as Headers;
    expect(h.get("x-api-key")).toBe(KEY);
    expect(h.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("chặn danh sách project, project/team khác, ticket ngoài project thử, ticket sai projectId", async () => {
    const { proxy } = it2({ ...base, 8: { identifier: "TECH2-8", projectId: 99 } });
    for (const p of [
      "/projects",
      "/projects/TECH/issues",
      "/projects/PO",
      "/projects/other.TECH2",
      "/teams/32",
      "/users",
      "/issues/6",
      "/issues/8", // mã TECH2 nhưng projectId khác: không tin mã
      "/issues/404",
      "/webhooks/1",
      "/projects/TECH2/webhooks",
      "/issues/5/attachments",
      "/",
    ]) {
      expect([p, await status(proxy, ireq("GET", p))]).toEqual([p, expect.any(Number)]);
      expect([p, (await status(proxy, ireq("GET", p))) >= 400]).toEqual([p, true]);
    }
  });
});

describe("itsaplan proxy: ghi (H1)", () => {
  it("tạo ticket hợp lệ vào TECH2, bỏ query string, body serialize lại", async () => {
    const { proxy, writes } = it2({ ...base });
    const res = await proxy(
      ireq("POST", "/projects/TECH2/issues?projectId=3&x=1", {
        title: "[smoke] a",
        columnId: 51,
        priority: "high",
        labelIds: [7],
        typeId: 3,
        assigneeUserId: "u1",
        dueDate: "2026-10-30",
      }),
    );
    expect(res.status).toBe(201);
    expect(writes()[0].url).toBe("/projects/TECH2/issues");
    expect(JSON.parse(writes()[0].body as string).columnId).toBe(51);
  });

  it("chặn khoá lạ và tham chiếu ngoài project thử khi tạo", async () => {
    const { proxy, writes } = it2({ ...base });
    const bad: unknown[] = [
      { title: "x", projectId: 3 },
      { title: "x", parentId: 1 },
      { title: "x", teamId: 1 },
      { title: "x", columnId: 999 },
      { title: "x", labelIds: [7, 8] },
      { title: "x", typeId: 99 },
      { title: "x", assigneeUserId: "ke-la" },
      { title: "x", priority: "critical" },
      { title: "" },
      { title: "x".repeat(501) },
      ["mảng"],
    ];
    for (const b of bad)
      expect([
        JSON.stringify(b),
        await status(proxy, ireq("POST", "/projects/TECH2/issues", b)),
      ]).toEqual([JSON.stringify(b), 403]);
    expect(await status(proxy, ireq("POST", "/projects/TECH/issues", { title: "x" }))).toBe(403);
    expect(await status(proxy, ireq("POST", "/projects/PO/issues", { title: "x" }))).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("sửa ticket: chặn đổi projectId/parent, cột/nhãn ngoài project, ticket ngoài project", async () => {
    const { proxy, writes } = it2({ ...base });
    expect(await status(proxy, ireq("PATCH", "/issues/5", { title: "mới", columnId: 52 }))).toBe(
      200,
    );
    for (const b of [
      { projectId: 3 },
      { columnId: 999 },
      { labelIds: [1] },
      { parentId: 7 },
      { id: 1 },
    ]) {
      expect(await status(proxy, ireq("PATCH", "/issues/5", b))).toBe(403);
    }
    expect(await status(proxy, ireq("PATCH", "/issues/6", { title: "hack" }))).toBe(403);
    expect(await status(proxy, ireq("PATCH", "/issues/404", { title: "x" }))).toBe(403);
    expect(writes()).toHaveLength(1);
  });

  it("ticket vừa tạo qua proxy sửa được ngay", async () => {
    const { proxy } = it2({ ...base });
    const created = (await (
      await proxy(ireq("POST", "/projects/TECH2/issues", { title: "[smoke]" }))
    ).json()) as { id: number };
    expect(await status(proxy, ireq("PATCH", `/issues/${created.id}`, { title: "ok" }))).toBe(200);
  });

  it("comment chỉ nhận {body}; field chỉ nhận fieldId của project; link chỉ tới ticket của project", async () => {
    const { proxy } = it2({ ...base });
    expect(await status(proxy, ireq("POST", "/issues/5/comments", { body: "hi" }))).toBe(200);
    expect(
      await status(proxy, ireq("POST", "/issues/5/comments", { body: "hi", authorId: "x" })),
    ).toBe(403);
    expect(await status(proxy, ireq("PUT", "/issues/5/fields/20", { value: "a" }))).toBe(200);
    expect(await status(proxy, ireq("PUT", "/issues/5/fields/21", { value: "a" }))).toBe(403);
    expect(await status(proxy, ireq("POST", "/issues/5/fields", { fieldId: 20, value: 1 }))).toBe(
      200,
    );
    expect(await status(proxy, ireq("POST", "/issues/5/fields", { fieldId: 21, value: 1 }))).toBe(
      403,
    );
    expect(
      await status(proxy, ireq("POST", "/issues/5/links", { targetIssueId: 7, kind: "relates" })),
    ).toBe(200);
    expect(
      await status(proxy, ireq("POST", "/issues/5/links", { targetIssueId: 6, kind: "relates" })),
    ).toBe(403);
    expect(
      await status(proxy, ireq("POST", "/issues/5/links", { targetIssueId: 7, kind: "parent" })),
    ).toBe(403);
    expect(
      await status(proxy, ireq("POST", "/issues/5/links", { targetIssueId: "7", kind: "relates" })),
    ).toBe(403);
  });

  it("chặn DELETE, webhook, đính kèm, route ghi lạ, team/project", async () => {
    const { proxy, writes } = it2({ ...base });
    const cases: [string, string][] = [
      ["DELETE", "/issues/5"],
      ["DELETE", "/issues/5/links/1"],
      ["POST", "/projects/TECH2/webhooks"],
      ["POST", "/issues/5/attachments"],
      ["POST", "/issues/5/watchers"],
      ["PUT", "/issues/5"],
      ["POST", "/projects"],
      ["PATCH", "/projects/TECH2"],
      ["PATCH", "/teams/32"],
      ["POST", "/projects/TECH2/columns"],
      ["PATCH", "/issues/5/../../projects/TECH"],
      ["PATCH", "/issues/5%2f..%2fprojects"],
    ];
    for (const [m, p] of cases) {
      expect([m, p, (await status(proxy, ireq(m, p, {}))) >= 400]).toEqual([m, p, true]);
    }
    expect(writes()).toHaveLength(0);
  });

  it("ghi bắt buộc content-type JSON (415) và Host loopback (403)", async () => {
    const { proxy, writes } = it2({ ...base });
    expect(
      await status(
        proxy,
        ireq("PATCH", "/issues/5", { title: "a" }, { "content-type": "text/plain" }),
      ),
    ).toBe(415);
    const evil = new Request("http://evil.example.com/issues/5", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await status(proxy, evil)).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("trần ghi mỗi phút trả 429", async () => {
    const { proxy } = it2({ ...base }, { writesPerMin: 2 });
    const patch = () => status(proxy, ireq("PATCH", "/issues/5", { title: "a" }));
    expect(await patch()).toBe(200);
    expect(await patch()).toBe(200);
    expect(await patch()).toBe(429);
  });

  it("log mọi lệnh gọi, không có body hay khoá", async () => {
    const { proxy, logs } = it2({ ...base });
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

describe("matchWrite / safePath", () => {
  it("chỉ các route ghi đã khai báo", () => {
    expect(matchWrite("PATCH", ["issues", "5"])).toEqual({ kind: "patch", id: 5 });
    expect(matchWrite("PUT", ["issues", "5", "fields", "20"])).toEqual({
      kind: "fieldPut",
      id: 5,
      fieldId: 20,
    });
    expect(matchWrite("DELETE", ["issues", "5"])).toBeNull();
    expect(matchWrite("POST", ["issues", "5", "attachments"])).toBeNull();
    expect(matchWrite("POST", ["issues", "abc", "comments"])).toBeNull();
  });

  it("safePath từ chối .., //, %, \\ và ký tự lạ", () => {
    expect(safePath("/issues/5/comments")).toBe(true);
    for (const p of ["/a/../b", "/a//b", "/a%2fb", "/a\\b", "/a b", "issues"])
      expect(safePath(p)).toBe(false);
  });
});

describe("selfTest khi khởi động (H2)", () => {
  const up = (code: number) => async () => new Response("x", { status: code });
  const strict = async () => new Response("denied", { status: 403 });
  const args = (over = {}) => ({
    handler: strict,
    upstream: "https://tracker.example.com",
    apiKey: KEY,
    forbidden: ["TECH", "PO"],
    fetchImpl: up(404),
    ...over,
  });

  it("đạt khi proxy chặn và khoá upstream không thấy project cấm", async () => {
    await expect(selfTest(args())).resolves.toBeUndefined();
    await expect(selfTest(args({ fetchImpl: up(403) }))).resolves.toBeUndefined();
  });

  it("từ chối khởi động nếu khoá nhìn thấy project cấm hoặc proxy cho đọc", async () => {
    await expect(selfTest(args({ fetchImpl: up(200) }))).rejects.toThrow(/khoá itsaplan đọc được/);
    await expect(selfTest(args({ handler: async () => new Response("ok") }))).rejects.toThrow(
      /cho đọc project cấm/,
    );
  });
});
