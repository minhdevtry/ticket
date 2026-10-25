/**
 * Đồng hồ tay cho test hội thoại: thời gian chỉ đi khi test gọi `advance`. Khớp `Clock` của
 * `@vuihoc/bot-core/intake` (chỉ cần `now()`), nên truyền thẳng vào `IntakeEngine`.
 */
export class ManualClock {
  private t: number;

  /** @param startMs Mốc ban đầu (ms epoch). Mặc định 2026-01-01T00:00:00Z để kết quả không đổi giữa các lần chạy. */
  constructor(startMs = Date.UTC(2026, 0, 1)) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError(`ManualClock.advance: ms không hợp lệ: ${ms}`);
    this.t += ms;
  }
}
