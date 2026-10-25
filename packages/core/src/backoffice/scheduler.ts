/**
 * Bộ chạy lịch và hẹn giờ của bot: MỘT vòng tick (mặc định mỗi giây) làm hai việc.
 *
 *  1. **Lịch cron** (`backoffice.schedule`). Mỗi lịch có mốc "đã xử lý tới đâu" trong kho bền.
 *     Mỗi tick, nếu có mốc mới đến hạn thì process này CHIẾM mốc đó một cách nguyên tử
 *     (`BotStore.claimCronSlot`) trước khi chạy handler, nên hai process cùng kho chỉ một bên
 *     chạy mỗi mốc, và mốc không chạy lại sau khi sập giữa chừng (at-most-once). Lease của lịch
 *     chặn hai lần chạy chồng nhau khi handler chạy lâu hơn chu kỳ.
 *  2. **Hẹn giờ của luật** (`after`, `closeAfter`). Timer `pending` quá hạn (hoặc `firing` mà
 *     process chạy nó đã sập: lease hết) được claim bằng CAS rồi chạy; lỗi thì thử lại có backoff
 *     và có giới hạn (at-least-once: hành động phải chạy lại được).
 *
 * Mọi quyết định thời gian dùng `clock` tiêm vào; chỉ việc ngủ giữa hai tick dùng timer thật.
 * Test gọi `tick()` trực tiếp với đồng hồ giả, không cần `start()`.
 */
import type { IntakeLogger } from "../core/logger";
import type { Clock } from "../intake/ports";
import type { CronSchedule } from "./cron";
import type { TimerFireResult } from "./rules";
import type { BotStore, TimerRow } from "./store";
import type { MissedPolicy } from "./types";

/** Một lịch đã sẵn sàng chạy (handler đã được bọc để tự dựng ngữ cảnh). */
export interface ScheduleEntry {
  /** Biểu thức cron (khoá của lịch trong kho). */
  id: string;
  cron: CronSchedule;
  missed: MissedPolicy;
  run(
    info: {
      scheduledFor: number;
      firedAt: number;
      missed: boolean;
      missedCount: number;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface BotSchedulerOptions {
  store: BotStore;
  clock: Clock;
  logger: IntakeLogger;
  entries?: readonly ScheduleEntry[];
  /** Chạy hành động của timer đến hạn (thường là `RuleEngine.fireTimer`). Không có thì không chạy timer. */
  timers?: { fire(row: TimerRow, signal: AbortSignal): Promise<TimerFireResult> };
  /** Chu kỳ tick (ms). Mặc định 1000. */
  tickMs?: number;
  /** Hạn một mốc còn là "đúng giờ" (ms). Mặc định 120 000. */
  graceMs?: number;
  /** Lease của lịch/timer đang chạy (ms), được gia hạn tự động khi còn chạy. Mặc định 120 000. */
  leaseMs?: number;
  /** Số lần chạy tối đa của một timer trước khi đánh `failed`. Mặc định 5. */
  timerMaxAttempts?: number;
  /** Backoff cơ sở giữa các lần thử lại timer (ms), nhân đôi mỗi lần, trần 30 phút. Mặc định 30 000. */
  timerBackoffMs?: number;
  /** Số timer chạy song song tối đa. Mặc định 4. */
  timerConcurrency?: number;
}

/** Ảnh chụp sức khoẻ của bộ chạy lịch (JSON thuần). */
export interface BotSchedulerHealth {
  running: boolean;
  jobs: number;
  pendingTimers: number;
  /** Số lần chạy lịch/timer đang dở. */
  inflight: number;
  lastTickAt: number | null;
  lastError: string | null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_TIMER_BACKOFF_MS = 30 * 60_000;
const PURGE_AFTER_MS = 7 * 86_400_000;

/** Bộ chạy lịch cron và hẹn giờ. Xem mô tả đầu file. */
export class BotScheduler {
  private readonly store: BotStore;
  private readonly clock: Clock;
  private readonly logger: IntakeLogger;
  private readonly entries: readonly ScheduleEntry[];
  private readonly timers?: BotSchedulerOptions["timers"];
  private readonly tickMs: number;
  private readonly graceMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly timerConcurrency: number;

  private running = false;
  private loop: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private lastPurge = 0;
  private readonly controller = new AbortController();
  private readonly inflightJobs = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private timersInflight = 0;

  constructor(options: BotSchedulerOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.logger = options.logger;
    this.entries = options.entries ?? [];
    this.timers = options.timers;
    this.tickMs = Math.max(10, options.tickMs ?? 1000);
    this.graceMs = options.graceMs ?? 120_000;
    this.leaseMs = options.leaseMs ?? 120_000;
    this.maxAttempts = Math.max(1, options.timerMaxAttempts ?? 5);
    this.backoffMs = options.timerBackoffMs ?? 30_000;
    this.timerConcurrency = Math.max(1, options.timerConcurrency ?? 4);
  }

  /** Bắt đầu vòng tick (tick đầu chạy ngay: bù các mốc/timer đến hạn lúc bot tắt). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const next = () => {
      if (!this.running) return;
      this.loop = setTimeout(() => {
        void this.tick().finally(next);
      }, this.tickMs);
      this.loop.unref?.();
    };
    void this.tick().finally(next);
  }

  /**
   * Dừng: ngừng tick, chờ lần chạy đang dở tối đa `drainMs`, quá hạn thì huỷ `signal` và chờ
   * thêm `graceMs` rồi bỏ mặc. Timer bị huỷ giữa chừng được hẹn lại ngay (chạy lại khi bot lên).
   */
  async stop(drainMs = 5000, graceMs = 1000): Promise<void> {
    this.running = false;
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
    await this.ticking;
    const settled = () => Promise.allSettled([...this.inflight]);
    const wait = (p: Promise<unknown>, ms: number) =>
      new Promise<"done" | "timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), ms);
        t.unref?.();
        void p.then(() => {
          clearTimeout(t);
          resolve("done");
        });
      });
    if (this.inflight.size === 0) return;
    if ((await wait(settled(), drainMs)) === "timeout") {
      this.logger.warn(`[schedule] ${this.inflight.size} việc chưa xong sau ${drainMs}ms, huỷ`);
      this.controller.abort(new Error("shutdown"));
      if ((await wait(settled(), graceMs)) === "timeout") {
        this.logger.error(`[schedule] ${this.inflight.size} việc không dừng sau khi huỷ; bỏ mặc`);
      }
    }
  }

  /** Chờ mọi lần chạy đang dở xong (cho test). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  health(): BotSchedulerHealth {
    return {
      running: this.running,
      jobs: this.entries.length,
      pendingTimers: this.store.countTimers("pending"),
      inflight: this.inflight.size,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  /**
   * Một lượt kiểm tra: chiếm và khởi chạy lịch/timer đến hạn (chạy nền, không chờ handler xong;
   * dùng `idle()` để chờ). Không ném. Các lời gọi chồng nhau được gộp.
   */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const current: Promise<void> = (async () => {
      await null; // để `ticking` được gán trước khi thân hàm chạy
      try {
        const now = this.clock.now();
        for (const entry of this.entries) {
          try {
            this.tickJob(entry, now);
          } catch (err) {
            this.lastError = errMsg(err);
            this.logger.error(`[schedule] ${entry.id}: lỗi khi xét lịch: ${errMsg(err)}`);
          }
        }
        if (this.timers) this.tickTimers(now);
        if (now - this.lastPurge > 3_600_000) {
          this.lastPurge = now;
          this.store.purgeTimers(PURGE_AFTER_MS, now);
        }
        this.lastTickAt = now;
      } catch (err) {
        this.lastError = errMsg(err);
        this.logger.error(`[schedule] tick lỗi: ${errMsg(err)}`);
      }
    })().finally(() => {
      if (this.ticking === current) this.ticking = null;
    });
    this.ticking = current;
    return current;
  }

  private track(promise: Promise<void>): void {
    this.inflight.add(promise);
    void promise.finally(() => this.inflight.delete(promise));
  }

  // ── cron ───────────────────────────────────────────────────────────────────

  private tickJob(entry: ScheduleEntry, now: number): void {
    if (this.inflightJobs.has(entry.id) || this.controller.signal.aborted) return;
    const last = this.store.registerCron(entry.id, now);
    const { count, last: latest, capped } = entry.cron.between(last, now);
    if (count === 0 || latest === null) return;
    const onTime = now - latest <= this.graceMs;
    const run = onTime || entry.missed === "catch-up-once";
    const claim = this.store.claimCronSlot({
      job: entry.id,
      slot: latest,
      now,
      leaseMs: this.leaseMs,
      run,
    });
    if (claim !== "claimed") return;

    if (!run) {
      this.logger.warn(
        `[schedule] ${entry.id}: bỏ qua ${count}${capped ? "+" : ""} mốc đã lỡ (mốc gần nhất ${new Date(latest).toISOString()}, chính sách skip)`,
      );
      return;
    }
    const missedCount = onTime ? count - 1 : count;
    if (missedCount > 0) {
      this.logger.warn(
        onTime
          ? `[schedule] ${entry.id}: ${missedCount} mốc trước đó đã lỡ và bị bỏ; chạy mốc ${new Date(latest).toISOString()}`
          : `[schedule] ${entry.id}: chạy bù một lần cho ${count}${capped ? "+" : ""} mốc đã lỡ (mốc gần nhất ${new Date(latest).toISOString()})`,
      );
    }
    this.inflightJobs.add(entry.id);
    this.track(this.runJob(entry, latest, now, !onTime, missedCount));
  }

  private async runJob(
    entry: ScheduleEntry,
    slot: number,
    firedAt: number,
    missed: boolean,
    missedCount: number,
  ): Promise<void> {
    const lease = `cron:${entry.id}`;
    const renew = setInterval(
      () => {
        try {
          this.store.acquireLease(lease, this.leaseMs, this.clock.now());
        } catch {
          // gia hạn lỗi: lease tự hết hạn, tệ nhất là lần tick sau cho phép bên khác chạy
        }
      },
      Math.max(1000, this.leaseMs / 3),
    );
    renew.unref?.();
    let status: "done" | "failed" = "done";
    try {
      await entry.run({ scheduledFor: slot, firedAt, missed, missedCount }, this.controller.signal);
    } catch (err) {
      status = "failed";
      this.lastError = errMsg(err);
      this.logger.error(`[schedule] ${entry.id}: handler lỗi (mốc không chạy lại): ${errMsg(err)}`);
    } finally {
      clearInterval(renew);
      this.inflightJobs.delete(entry.id);
      try {
        this.store.finishCron(entry.id, status, this.clock.now());
      } catch (err) {
        this.logger.warn(`[schedule] ${entry.id}: không ghi được kết quả: ${errMsg(err)}`);
      }
    }
  }

  // ── hẹn giờ ────────────────────────────────────────────────────────────────

  private tickTimers(now: number): void {
    if (this.controller.signal.aborted) return;
    const room = this.timerConcurrency - this.timersInflight;
    if (room <= 0) return;
    for (const row of this.store.dueTimers(now, room)) {
      if (!this.store.claimTimer(row.key, row.gen, now, this.leaseMs)) continue; // process khác nhanh tay hơn
      this.timersInflight++;
      this.track(
        this.runTimer({ ...row, attempts: row.attempts + 1 }).finally(() => {
          this.timersInflight--;
        }),
      );
    }
  }

  private async runTimer(row: TimerRow): Promise<void> {
    const renew = setInterval(
      () => {
        try {
          this.store.renewTimer(row.key, row.gen, this.clock.now(), this.leaseMs);
        } catch {
          // xem runJob
        }
      },
      Math.max(1000, this.leaseMs / 3),
    );
    renew.unref?.();
    const signal = this.controller.signal;
    try {
      const result = await (this.timers as NonNullable<typeof this.timers>).fire(row, signal);
      const now = this.clock.now();
      if (result.status === "done") {
        this.store.finishTimer(row.key, row.gen, "done", null, now);
      } else {
        this.store.finishTimer(row.key, row.gen, "cancelled", result.reason, now);
        this.logger.info(`[timers] ${row.key}: huỷ lúc đến hạn: ${result.reason}`);
      }
    } catch (err) {
      const now = this.clock.now();
      if (signal.aborted) {
        // Bot đang tắt: không tính là lỗi, hẹn lại ngay để chạy khi bot lên.
        this.store.failTimer(row.key, row.gen, "bị huỷ khi bot dừng", now, now);
        return;
      }
      const giveUp = row.attempts >= this.maxAttempts;
      const delay = Math.min(MAX_TIMER_BACKOFF_MS, this.backoffMs * 2 ** (row.attempts - 1));
      this.lastError = errMsg(err);
      this.store.failTimer(row.key, row.gen, errMsg(err), giveUp ? null : now + delay, now);
      this.logger[giveUp ? "error" : "warn"](
        giveUp
          ? `[timers] ${row.key}: lỗi lần ${row.attempts}/${this.maxAttempts}, bỏ cuộc: ${errMsg(err)}`
          : `[timers] ${row.key}: lỗi lần ${row.attempts}/${this.maxAttempts}, thử lại sau ${Math.round(delay / 1000)}s: ${errMsg(err)}`,
      );
    } finally {
      clearInterval(renew);
    }
  }
}
