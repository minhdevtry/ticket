/**
 * `runBot` — chạy bot cho tới khi nhận tín hiệu dừng (SIGINT/SIGTERM), rồi dừng êm.
 * Tín hiệu thứ hai (hoặc quá `forceExitMs`) thoát ngay.
 */
import type { Bot } from "./create";

export interface RunBotOptions {
  signals?: NodeJS.Signals[];
  /** Quá hạn này sau tín hiệu đầu thì thoát cưỡng bức. Mặc định 15 000 ms. */
  forceExitMs?: number;
  /** Thay `process` (test). */
  proc?: Pick<NodeJS.Process, "on" | "off" | "exit">;
}

/** Start bot và trả khi bot đã dừng. Ném nếu `start()` thất bại. */
export async function runBot(bot: Bot, options: RunBotOptions = {}): Promise<void> {
  const proc = options.proc ?? process;
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  let stopping = false;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const onSignal = () => {
    if (stopping) {
      proc.exit(1);
      return;
    }
    stopping = true;
    const timer = setTimeout(() => proc.exit(1), options.forceExitMs ?? 15_000);
    timer.unref?.();
    bot.stop().finally(() => {
      clearTimeout(timer);
      done();
    });
  };
  for (const sig of signals) proc.on(sig, onSignal);
  try {
    await bot.start();
    await finished;
  } finally {
    for (const sig of signals) proc.off(sig, onSignal);
  }
}
