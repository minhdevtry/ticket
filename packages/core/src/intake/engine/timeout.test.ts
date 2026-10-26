import { describe, expect, it } from "bun:test";
import { withTimeout } from "./timeout";

describe("withTimeout", () => {
  it("resolves when promise settles before timeout", async () => {
    const res = await withTimeout(Promise.resolve(42), 1000, "fast-op");
    expect(res).toBe(42);
  });

  it("rejects with descriptive error on timeout", async () => {
    const { promise: pending } = Promise.withResolvers<never>();
    await expect(withTimeout(pending, 10, "slow-op")).rejects.toThrow("slow-op timeout");
  });
});
