import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ItsaplanClient,
  ItsaplanApiError,
  ItsaplanMalformedResponseError,
  isRetryableItsaplanError,
} from "./client";

// Ported from intake `lib/itsaplan/client.test.ts` + CM `tests/itsaplan-client.test.ts`.
describe("ItsaplanClient (merged)", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(async (input: any, init?: any) => {
      const url = String(input);
      const method = init?.method || "GET";

      if (url.endsWith("/projects") && method === "GET") {
        return new Response(
          JSON.stringify([
            { id: 1, key: "CMSUPPORT", name: "CM Support Bot" },
            { id: 2, key: "TECH", name: "Tech Support" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/TECH")) {
        return new Response(
          JSON.stringify({
            id: 1,
            key: "TECH",
            name: "Tech Support",
            columns: [{ id: 10, name: "Backlog", stateType: "backlog", position: 0 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/CMSUPPORT/columns") && method === "POST") {
        const body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ id: 20, name: body.name, stateType: body.stateType, position: 5 }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/100/comments") || url.endsWith("/issues/101/comments")) {
        return new Response(JSON.stringify({ id: 50, body: "Updated note" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/projects/TECH/issues")) {
        return new Response(
          JSON.stringify({ id: 101, identifier: "TECH-101", title: "Test Ticket", columnId: 10 }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/101") && method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 101, identifier: "TECH-101", title: "Updated", columnId: 14 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends x-api-key and Authorization headers", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "test-secret-key");
    await client.getProject("TECH");
    const headers = (mockFetch.mock.calls[0] as any)[1].headers;
    expect(headers["x-api-key"]).toBe("test-secret-key");
    expect(headers["Authorization"]).toBe("Bearer test-secret-key");
  });

  test("parses successful responses", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    const project = await client.getProject("TECH");
    expect(project.key).toBe("TECH");
    expect(project.columns).toHaveLength(1);
  });

  test("creates issues and moves them (updateIssue columnId)", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    const created = await client.createIssue("TECH", {
      title: "Test Ticket",
      columnId: 10,
      priority: "high",
    });
    expect(created.identifier).toBe("TECH-101");
    const moved = await client.updateIssue(created.id, { columnId: 14 });
    expect(moved.columnId).toBe(14);
  });

  test("creates columns (CM method)", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    const col = await client.createColumn("CMSUPPORT", {
      name: "Chờ GV bổ sung",
      stateType: "started",
    });
    expect(col.name).toBe("Chờ GV bổ sung");
  });

  test("adds comment to an issue", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    expect((await client.addComment(100, "Updated note")).id).toBe(50);
  });

  test("throws typed ItsaplanApiError carrying status + path + body on non-2xx", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    let err: unknown;
    try {
      await client.getProject("UNKNOWN");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ItsaplanApiError);
    expect((err as ItsaplanApiError).status).toBe(404);
    expect((err as ItsaplanApiError).path).toBe("/projects/UNKNOWN");
    const msg = (err as Error).message;
    expect(msg).toContain("Itsaplan API error: 404");
    expect(msg).toContain("/projects/UNKNOWN");
    expect(msg).toContain("Not found");
  });

  test("isRetryableItsaplanError: 404 not retryable, 429/5xx retryable, non-ApiError retryable", () => {
    expect(isRetryableItsaplanError(new ItsaplanApiError(404, "/x", "nf"))).toBe(false);
    expect(isRetryableItsaplanError(new ItsaplanApiError(429, "/x", "rate"))).toBe(true);
    expect(isRetryableItsaplanError(new ItsaplanApiError(503, "/x", "down"))).toBe(true);
    expect(isRetryableItsaplanError(new ItsaplanMalformedResponseError("/x", "empty"))).toBe(true);
    expect(isRetryableItsaplanError(new Error("network"))).toBe(true);
  });
});

// Lifted from Tiểu Linh: `page` cho listProjectIssues, listComments có kiểu + ép kiểu.
describe("ItsaplanClient.listProjectIssues / listComments", () => {
  const originalFetch = globalThis.fetch;
  let urls: string[];

  const respond = (payload: unknown) => {
    globalThis.fetch = mock(async (input: any) => {
      urls.push(String(input));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;
  };

  beforeEach(() => {
    urls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("listProjectIssues đưa limit và page lên query, nhận cả mảng lẫn { issues }", async () => {
    respond([{ id: 1 }]);
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    expect(await client.listProjectIssues("TECH", { limit: 100, page: 3 })).toEqual([
      { id: 1 } as any,
    ]);
    expect(urls[0]).toBe("http://mock-itsaplan:3100/projects/TECH/issues?limit=100&page=3");

    respond({ issues: [{ id: 2 }] });
    expect(await client.listProjectIssues("TECH")).toEqual([{ id: 2 } as any]);
    expect(urls[1]).toBe("http://mock-itsaplan:3100/projects/TECH/issues");
  });

  test("listComments chỉ lấy comment, ép id về number và bỏ field sai kiểu", async () => {
    respond([
      {
        kind: "comment",
        id: "7",
        body: "xin chào",
        actorName: "An",
        actorUserId: "u1",
        createdAt: "2026-10-01T00:00:00Z",
      },
      { kind: "comment", id: 8, body: null, actorName: 5, actorUserId: {}, createdAt: 123 },
      { kind: "state_changed", id: 9, body: "bỏ" },
    ]);
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "k");
    expect(await client.listComments(1)).toEqual([
      {
        id: 7,
        body: "xin chào",
        author: { name: "An", id: "u1" },
        createdAt: "2026-10-01T00:00:00Z",
      },
      { id: 8, body: "", author: { name: undefined, id: undefined }, createdAt: undefined },
    ]);
  });
});

describe("ItsaplanClient options: timeoutMs <= 0, strictResponses", () => {
  const originalFetch = globalThis.fetch;
  let signals: Array<AbortSignal | null | undefined>;

  const respond = (body: string | null, status = 200) => {
    globalThis.fetch = mock(async (_input: any, init?: any) => {
      signals.push(init?.signal);
      return new Response(body, { status });
    }) as any;
  };

  beforeEach(() => {
    signals = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("mặc định có timeout (AbortSignal); timeoutMs: 0 hoặc âm → không đặt signal", async () => {
    respond("{}");
    await new ItsaplanClient("http://x", "k").getProject("TECH");
    expect(signals[0]).toBeDefined();

    for (const timeoutMs of [0, -1]) {
      signals.length = 0;
      respond("{}");
      await new ItsaplanClient("http://x", "k", {
        retryOptions: { maxRetries: 0 },
        timeoutMs,
      }).getProject("TECH");
      expect(signals[0]).toBeUndefined();
    }
  });

  test("timeoutMs: 0 áp cho cả uploadAttachment", async () => {
    respond(JSON.stringify({ id: "1", url: "/u", filename: "a.png" }));
    await new ItsaplanClient("http://x", "k", {
      retryOptions: { maxRetries: 0 },
      timeoutMs: 0,
    }).uploadAttachment(1, "a.png", Buffer.from("x"), "image/png");
    expect(signals[0]).toBeUndefined();
  });

  test("mặc định strict: body rỗng và body không phải JSON ném ItsaplanMalformedResponseError", async () => {
    const client = new ItsaplanClient("http://x", "k");
    respond("");
    await expect(client.deleteLink(1, 2)).rejects.toBeInstanceOf(ItsaplanMalformedResponseError);
    respond("<html>oops</html>");
    await expect(client.getProject("TECH")).rejects.toBeInstanceOf(ItsaplanMalformedResponseError);
  });

  test("strictResponses: false → body rỗng trả {}, body không phải JSON trả nguyên chuỗi (intake cũ)", async () => {
    const client = new ItsaplanClient("http://x", "k", {
      retryOptions: { maxRetries: 0 },
      strictResponses: false,
    });
    respond("");
    expect(await client.request("/anything")).toEqual({});
    respond("plain text ok");
    expect(await client.request("/anything")).toBe("plain text ok");
    // lỗi HTTP vẫn ném ItsaplanApiError
    respond("nope", 404);
    await expect(client.request("/anything")).rejects.toBeInstanceOf(ItsaplanApiError);
  });
});
