import { describe, expect, it } from "bun:test";
import { type LlmUsageEvent, UsageMeter, estimateCost } from "./index";

const usage = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheCreation,
});

const ev = (
  model: string,
  input: number,
  output: number,
  outcome: "ok" | "error" = "ok",
): LlmUsageEvent => ({
  outcome,
  api: "openai-chat",
  model,
  usage: usage(input, output),
  stopReason: "end",
  durationMs: 1,
  attempts: 1,
});

describe("usage", () => {
  it("estimateCost theo đơn giá một triệu token", () => {
    expect(
      estimateCost(usage(2_000_000, 500_000), { inputPerMTok: 0.3, outputPerMTok: 1.2 }),
    ).toBeCloseTo(1.2);
  });

  it("estimateCost: token cache tính theo giá cache, mặc định bằng giá input", () => {
    // inputTokens đã gồm cache: 1M = 600k thường + 300k đọc cache + 100k ghi cache.
    const u = usage(1_000_000, 0, 300_000, 100_000);
    expect(estimateCost(u, { inputPerMTok: 10, outputPerMTok: 0 })).toBeCloseTo(10);
    expect(
      estimateCost(u, {
        inputPerMTok: 10,
        outputPerMTok: 0,
        cacheReadPerMTok: 1,
        cacheCreationPerMTok: 12.5,
      }),
    ).toBeCloseTo(6 + 0.3 + 1.25);
  });

  it("UsageMeter cộng theo model, tổng, chi phí và reset; dùng thẳng làm onUsage", () => {
    const meter = new UsageMeter();
    const record = meter.record; // không cần bind
    record(ev("a", 1000, 100));
    record(ev("a", 1000, 100));
    record(ev("b", 500, 50));
    expect(meter.total()).toEqual({
      inputTokens: 2500,
      outputTokens: 250,
      totalTokens: 2750,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      calls: 3,
      failedCalls: 0,
    });
    expect(meter.models().a).toMatchObject({ inputTokens: 2000, calls: 2 });
    expect(meter.cost({ a: { inputPerMTok: 1000, outputPerMTok: 1000 } })).toBeCloseTo(2.2);
    meter.reset();
    expect(meter.total().calls).toBe(0);
  });

  it("UsageMeter tính cả lần gọi hỏng đã có token và cộng token cache", () => {
    const meter = new UsageMeter();
    meter.record(ev("a", 100, 10, "error"));
    meter.record({ ...ev("a", 200, 20), usage: usage(200, 20, 150, 30) });
    expect(meter.total()).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 150,
      cacheCreationTokens: 30,
      calls: 2,
      failedCalls: 1,
    });
  });
});
