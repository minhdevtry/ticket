import { describe, expect, it } from "bun:test";
import { calculateBackoff, parseRetryAfter, withRetry, HttpError } from "./http";

// Ported from CM `tests/http-client.test.ts`.
describe("http retry & 429 handling", () => {
  it("backoff within bounds", () => {
    for (let i = 0; i < 5; i++) {
      const d = calculateBackoff(i, 100, 1000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
  it("parses Retry-After seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
  });
  it("retries on 500 then succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async (attempt) => {
        attempts++;
        if (attempt < 2) throw new HttpError(500, "Server Error");
        return "success";
      },
      { baseDelayMs: 5, maxRetries: 3 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });
  it("respects 429 retry-after", async () => {
    let attempts = 0;
    const headers = new Headers();
    headers.set("retry-after", "0.02");
    const result = await withRetry(
      async (attempt) => {
        attempts++;
        if (attempt === 0) throw new HttpError(429, "Too Many Requests", headers);
        return "done";
      },
      { baseDelayMs: 5, maxRetries: 2 },
    );
    expect(result).toBe("done");
    expect(attempts).toBe(2);
  });
  it("does not retry on 400", async () => {
    let attempts = 0;
    const run = () =>
      withRetry(
        async () => {
          attempts++;
          throw new HttpError(400, "Bad Request");
        },
        { baseDelayMs: 5, maxRetries: 3 },
      );
    await expect(run()).rejects.toThrow(/Bad Request/);
    expect(attempts).toBe(1);
  });
});
