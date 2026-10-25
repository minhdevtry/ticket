/**
 * `runBot` — chạy bot cho tới khi nhận tín hiệu dừng (SIGINT/SIGTERM) hoặc bot gặp lỗi chết,
 * rồi dừng êm. Tín hiệu thứ hai (hoặc quá hạn thoát cưỡng bức) thoát ngay.
 *
 * Một nguồn duy nhất cho thời gian dừng: hạn thoát cưỡng bức lấy từ `bot.stopBudgetMs`
 * (drain + chờ sau khi huỷ + dọn server), không phải một con số riêng dễ lệch. Mặc định
 * khoảng 7,5 giây: nằm trong hạn 10 giây của `docker stop`. Handler chạy lâu thì nâng
 * `BOT_DRAIN_TIMEOUT_MS` cùng hạn dừng của orchestrator (`docker stop -t`, `TimeoutStopSec`).
 */
import type { Bot } from "./create";

export interface RunBotOptions {
  signals?: NodeJS.Signals[];
  /** Ghi đè hạn thoát cưỡng bức sau tín hiệu đầu (ms). Mặc định `bot.stopBudgetMs`. */
  forceExitMs?: number;
  /**
   * Khi bot gặp lỗi chết (key bị từ chối liên tiếp…): dừng êm rồi `process.exit(1)` để
   * orchestrator khởi động lại và cảnh báo. Mặc định true. `false` thì `runBot` dừng êm rồi ném
   * lỗi đó cho caller tự quyết.
   */
  exitOnFatal?: boolean;
  /** Thay `process` (test). */
  proc?: Pick<NodeJS.Process, "on" | "off" | "exit">;
}

/** Start bot và trả khi bot đã dừng. Ném nếu `start()` thất bại. */
export async function runBot(bot: Bot, options: RunBotOptions = {}): Promise<void> {
  const proc = options.proc ?? process;
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  const exitOnFatal = options.exitOnFatal ?? true;
  let stopping = false;
  let fatal: Error | null = null;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const beginStop = () => {
    stopping = true;
    const timer = setTimeout(() => proc.exit(1), options.forceExitMs ?? bot.stopBudgetMs);
    timer.unref?.();
    bot.stop().finally(() => {
      clearTimeout(timer);
      done();
    });
  };
  const onSignal = () => {
    if (stopping) {
      proc.exit(1);
      return;
    }
    beginStop();
  };
  const offFatal = bot.onFatal((err) => {
    fatal ??= err;
    if (!stopping) beginStop();
  });
  for (const sig of signals) proc.on(sig, onSignal);
  try {
    await bot.start();
    await finished;
  } finally {
    offFatal();
    for (const sig of signals) proc.off(sig, onSignal);
  }
  if (fatal) {
    if (exitOnFatal) proc.exit(1);
    else throw fatal;
  }
}
