import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { ItsaplanClient } from "./client";

describe("ItsaplanClient", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/projects/TECH")) {
        return new Response(
          JSON.stringify({
            id: 1,
            key: "TECH",
            name: "Tech Support",
            columns: [{ id: 10, name: "Backlog", stateType: "backlog" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/100/comments")) {
        return new Response(
          JSON.stringify({ id: 50, issueId: 100, body: "Updated note" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/projects/TECH/issues")) {
        return new Response(
          JSON.stringify({
            id: 101,
            identifier: "TECH-101",
            title: "Test Ticket",
            columnId: 10,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends x-api-key header and parses successful responses", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "test-secret-key");
    const project = await client.getProject("TECH");

    expect(project.key).toBe("TECH");
    expect(project.name).toBe("Tech Support");
    expect(mockFetch).toHaveBeenCalled();

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers["x-api-key"]).toBe("test-secret-key");
  });

  test("creates issues with correct payload", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "test-secret-key");
    const created = await client.createIssue("TECH", {
      title: "Test Ticket",
      columnId: 10,
      priority: "high",
    });

    expect(created.identifier).toBe("TECH-101");
  });

  test("adds comment to an issue", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "test-secret-key");
    const comment = await client.addComment(100, "Updated note");
    expect(comment.id).toBe(50);
  });

  test("throws error when API returns non-2xx response", async () => {
    const client = new ItsaplanClient("http://mock-itsaplan:3100", "test-secret-key");
    expect(client.getProject("UNKNOWN")).rejects.toThrow("Itsaplan API error: 404");
  });
});
