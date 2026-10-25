import { describe, expect, it } from "bun:test";
import { AgentRunsApiError } from "./agent-runs/client";
import { ItsaplanApiError, ItsaplanMalformedResponseError } from "./client";
import { HttpError } from "./http";
import { isTransientError } from "./transient";

describe("isTransientError", () => {
  it("5xx và 429 của itsaplan/agent-runs là tạm thời, 4xx khác thì không", () => {
    expect(isTransientError(new ItsaplanApiError(503, "/x", "m"))).toBe(true);
    expect(isTransientError(new ItsaplanApiError(429, "/x", "m"))).toBe(true);
    expect(isTransientError(new ItsaplanApiError(404, "/x", "m"))).toBe(false);
    expect(isTransientError(new ItsaplanApiError(403, "/x", "m"))).toBe(false);
    expect(isTransientError(new AgentRunsApiError(502, "/agent-runs/claim", ""))).toBe(true);
    expect(isTransientError(new AgentRunsApiError(401, "/agent-runs/claim", ""))).toBe(false);
    expect(isTransientError(new HttpError(500, "m"))).toBe(true);
    expect(isTransientError(new HttpError(400, "m"))).toBe(false);
  });

  it("phản hồi 2xx đọc hỏng, hết giờ và lỗi mạng là tạm thời", () => {
    expect(isTransientError(new ItsaplanMalformedResponseError("/x", "body rỗng"))).toBe(true);
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(isTransientError(timeout)).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("boom"), { code: "ConnectionRefused" }))).toBe(
      true,
    );
  });

  it("lỗi tự khai `transient: true` (vd LlmError) là tạm thời, `false` thì không", () => {
    const flagged = (transient: boolean) => Object.assign(new Error("lỗi từ LLM"), { transient });
    expect(isTransientError(flagged(true))).toBe(true);
    expect(isTransientError(flagged(false))).toBe(false);
  });

  it("bug của chính ta và lỗi do ta huỷ KHÔNG phải tạm thời (thử lại cũng vô ích)", () => {
    expect(isTransientError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientError(new Error("hỏng rồi"))).toBe(false);
    expect(isTransientError(new RangeError("sai"))).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isTransientError(abort)).toBe(false);
    expect(isTransientError("chuỗi")).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});
