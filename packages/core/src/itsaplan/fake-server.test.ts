import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ItsaplanClient, ItsaplanApiError, ItsaplanMalformedResponseError } from "./client";

/**
 * Integration test against a real HTTP server (Bun.serve on 127.0.0.1:0).
 * Exercises the client's public surface end to end: typed errors, bounded retry
 * on 429/5xx, NO retry on other 4xx, and malformed (2xx non-JSON / empty) bodies.
 */
type Counts = Record<string, number>;
const counts: Counts = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/projects/OK") {
        return Response.json({ id: 1, key: "OK", name: "Ok Project" });
      }
      // Always 404 — not retryable, must stop after one attempt.
      if (p === "/projects/MISSING") {
        bump("missing");
        return new Response(JSON.stringify({ error: "no such project" }), { status: 404 });
      }
      // Always 400 — a non-retryable 4xx.
      if (p === "/projects/BAD") {
        bump("bad");
        return new Response("bad request", { status: 400 });
      }
      // 503 twice, then 200 — bounded retry should recover.
      if (p === "/projects/FLAKY") {
        bump("flaky");
        if (counts["flaky"] < 3) return new Response("down", { status: 503 });
        return Response.json({ id: 2, key: "FLAKY", name: "Recovered" });
      }
      // Always 429 — retryable, should exhaust maxRetries then throw.
      if (p === "/projects/RATE") {
        bump("rate");
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }
      // 2xx but empty body — malformed.
      if (p === "/projects/EMPTY") {
        return new Response("", { status: 200 });
      }
      // 2xx but HTML, not JSON — malformed.
      if (p === "/projects/HTML") {
        return new Response("<!doctype html><html>nope</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      // 204 no content — valid empty.
      if (p === "/issues/1" && req.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function client() {
  // Fast retry so the test is quick, bounded to 2 retries.
  return new ItsaplanClient(baseUrl, "k", {
    retryOptions: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
  });
}

describe("ItsaplanClient against a fake HTTP server", () => {
  test("parses a 2xx JSON body", async () => {
    const project = await client().getProject("OK");
    expect(project.key).toBe("OK");
  });

  test("404 throws typed ItsaplanApiError and does NOT retry", async () => {
    counts["missing"] = 0;
    let err: unknown;
    try {
      await client().getProject("MISSING");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ItsaplanApiError);
    expect((err as ItsaplanApiError).status).toBe(404);
    expect((err as ItsaplanApiError).path).toBe("/projects/MISSING");
    expect(counts["missing"]).toBe(1); // one attempt only
  });

  test("other 4xx (400) is not retried", async () => {
    counts["bad"] = 0;
    let err: unknown;
    try {
      await client().getProject("BAD");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ItsaplanApiError);
    expect((err as ItsaplanApiError).status).toBe(400);
    expect(counts["bad"]).toBe(1);
  });

  test("bounded retry on 5xx eventually succeeds", async () => {
    counts["flaky"] = 0;
    const project = await client().getProject("FLAKY");
    expect(project.key).toBe("FLAKY");
    expect(counts["flaky"]).toBe(3); // 2 failures + 1 success
  });

  test("retry on 429 is bounded then throws typed error", async () => {
    counts["rate"] = 0;
    let err: unknown;
    try {
      await client().getProject("RATE");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ItsaplanApiError);
    expect((err as ItsaplanApiError).status).toBe(429);
    expect(counts["rate"]).toBe(3); // initial + 2 retries
  });

  test("2xx with empty body throws ItsaplanMalformedResponseError", async () => {
    await expect(client().getProject("EMPTY")).rejects.toBeInstanceOf(
      ItsaplanMalformedResponseError,
    );
  });

  test("2xx with non-JSON (HTML) body throws ItsaplanMalformedResponseError", async () => {
    await expect(client().getProject("HTML")).rejects.toBeInstanceOf(
      ItsaplanMalformedResponseError,
    );
  });

  test("204 No Content is a valid empty response", async () => {
    await expect(client().deleteIssue(1)).resolves.toBeUndefined();
  });
});
