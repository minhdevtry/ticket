import { describe, expect, it } from "bun:test";
import { UsageMeter, estimateCost } from "./index";

const ev = (model: string, input: number, output: number) => ({
  api: "openai-chat" as const,
  model,
  usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
  stopReason: "end" as const,
  durationMs: 1,
  attempts: 1,
});

describe("usage", () => {
  it("estimateCost theo đơn giá một triệu token", () => {
    expect(
      estimateCost(
        { inputTokens: 2_000_000, outputTokens: 500_000, totalTokens: 2_500_000 },
        { inputPerMTok: 0.3, outputPerMTok: 1.2 },
      ),
    ).toBeCloseTo(1.2);
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
      calls: 3,
    });
    expect(meter.models().a).toMatchObject({ inputTokens: 2000, calls: 2 });
    expect(meter.cost({ a: { inputPerMTok: 1000, outputPerMTok: 1000 } })).toBeCloseTo(2.2);
    meter.reset();
    expect(meter.total().calls).toBe(0);
  });
});
