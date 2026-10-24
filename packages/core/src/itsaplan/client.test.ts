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
