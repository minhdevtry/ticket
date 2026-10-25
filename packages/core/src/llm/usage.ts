/**
 * Báo cáo token và chi phí. Đơn giá do bot khai (không viết cứng: giá đổi theo nhà cung cấp).
 */
import type { LlmUsage, LlmUsageEvent } from "./types";

/** Đơn giá theo một triệu token, đơn vị tiền tuỳ bot (USD, VND…). */
export interface LlmPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Giá token đọc từ cache; mặc định bằng `inputPerMTok`. */
  cacheReadPerMTok?: number;
  /** Giá token ghi vào cache; mặc định bằng `inputPerMTok`. */
  cacheCreationPerMTok?: number;
}

/**
 * Chi phí ước tính của một lượng token. `inputTokens` đã gồm token cache, nên phần không cache
 * tính theo `inputPerMTok`, phần cache theo giá riêng (nếu có).
 */
export function estimateCost(usage: LlmUsage, pricing: LlmPricing): number {
  const read = usage.cacheReadTokens ?? 0;
  const creation = usage.cacheCreationTokens ?? 0;
  const plain = Math.max(0, usage.inputTokens - read - creation);
  return (
    (plain * pricing.inputPerMTok +
      read * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
      creation * (pricing.cacheCreationPerMTok ?? pricing.inputPerMTok) +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

/** Một dòng của {@link UsageMeter}. */
export type UsageRow = LlmUsage & {
  /** Số lần gọi HTTP đã báo token (gồm cả lần hỏng/thử lại). */
  calls: number;
  /** Trong đó số lần phản hồi hỏng nhưng vẫn bị tính tiền. */
  failedCalls: number;
};

const emptyRow = (): UsageRow => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  calls: 0,
  failedCalls: 0,
});

const addRow = (row: UsageRow, usage: LlmUsage, failed: boolean): void => {
  row.inputTokens += usage.inputTokens;
  row.outputTokens += usage.outputTokens;
  row.totalTokens += usage.totalTokens;
  row.cacheReadTokens += usage.cacheReadTokens ?? 0;
  row.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  row.calls += 1;
  if (failed) row.failedCalls += 1;
};

/** Tổng hợp token theo model, dùng làm `onUsage` của `createLlm`. */
export class UsageMeter {
  private readonly byModel = new Map<string, UsageRow>();

  /**
   * Ghi một sự kiện. Truyền thẳng làm `onUsage`: `createLlm({ onUsage: meter.record })`. Tính cả
   * lần gọi hỏng/thử lại mà server đã báo token, vì chúng vẫn bị tính tiền.
   */
  readonly record = (event: LlmUsageEvent): void => {
    const row = this.byModel.get(event.model) ?? emptyRow();
    addRow(row, event.usage, event.outcome === "error");
    this.byModel.set(event.model, row);
  };

  /** Tổng của mọi model. */
  total(): UsageRow {
    const sum = emptyRow();
    for (const row of this.byModel.values()) {
      sum.inputTokens += row.inputTokens;
      sum.outputTokens += row.outputTokens;
      sum.totalTokens += row.totalTokens;
      sum.cacheReadTokens += row.cacheReadTokens;
      sum.cacheCreationTokens += row.cacheCreationTokens;
      sum.calls += row.calls;
      sum.failedCalls += row.failedCalls;
    }
    return sum;
  }

  /** Số liệu từng model (bản sao). */
  models(): Record<string, UsageRow> {
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
