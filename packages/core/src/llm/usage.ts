/**
 * Báo cáo token và chi phí. Đơn giá do bot khai (không viết cứng: giá đổi theo nhà cung cấp).
 */
import type { LlmUsage, LlmUsageEvent } from "./types";

/** Đơn giá theo một triệu token, đơn vị tiền tuỳ bot (USD, VND…). */
export interface LlmPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Chi phí ước tính của một lượng token. */
export function estimateCost(usage: LlmUsage, pricing: LlmPricing): number {
  return (
    (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

/** Tổng hợp token theo model, dùng làm `onUsage` của `createLlm`. */
export class UsageMeter {
  private readonly byModel = new Map<string, LlmUsage & { calls: number }>();

  /** Ghi một sự kiện. Truyền thẳng làm `onUsage`: `createLlm({ onUsage: meter.record })`. */
  readonly record = (event: LlmUsageEvent): void => {
    const row = this.byModel.get(event.model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
    };
    row.inputTokens += event.usage.inputTokens;
    row.outputTokens += event.usage.outputTokens;
    row.totalTokens += event.usage.totalTokens;
    row.calls += 1;
    this.byModel.set(event.model, row);
  };

  /** Tổng của mọi model. */
  total(): LlmUsage & { calls: number } {
    const sum = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
    for (const row of this.byModel.values()) {
      sum.inputTokens += row.inputTokens;
      sum.outputTokens += row.outputTokens;
      sum.totalTokens += row.totalTokens;
      sum.calls += row.calls;
    }
    return sum;
  }

  /** Số liệu từng model (bản sao). */
  models(): Record<string, LlmUsage & { calls: number }> {
    return Object.fromEntries([...this.byModel].map(([k, v]) => [k, { ...v }]));
  }

  /** Chi phí ước tính theo bảng giá từng model (model không có giá thì bỏ qua). */
  cost(pricing: Record<string, LlmPricing>): number {
    let sum = 0;
    for (const [model, row] of this.byModel) {
      const price = pricing[model];
      if (price) sum += estimateCost(row, price);
    }
    return sum;
  }

  reset(): void {
    this.byModel.clear();
  }
}
