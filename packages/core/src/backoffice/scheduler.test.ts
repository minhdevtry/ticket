import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntakeLogger } from "../core/logger";
import { parseCron } from "./cron";
import { BotScheduler, type ScheduleEntry } from "./scheduler";
import { BotStore, type TimerRow } from "./store";
import type { MissedPolicy } from "./types";

const logs: string[] = [];
const logger: IntakeLogger = {
  debug() {},
  info: (m) => void logs.push(m),
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
};
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (f: { scheduledFor: number }) => iso(f.scheduledFor).slice(11, 16);

class FakeClock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  set(isoText: string) {
    this.t = at(isoText);
  }
}

const dirs: string[] = [];
const closers: (() => void)[] = [];
const dbPath = () => {
  const d = mkdtempSync(join(tmpdir(), "sched-"));
  dirs.push(d);
  return join(d, "bot.sqlite");
};
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  logs.length = 0;
});

interface Fire {
  scheduledFor: number;
  missed: boolean;
  missedCount: number;
}

function setup(opts: {
  path?: string;
  id?: string;
  clock: FakeClock;
  expr?: string;
  missed?: MissedPolicy;
  fires?: Fire[];
  handler?: (info: Fire, signal: AbortSignal) => Promise<void>;
  graceMs?: number;
  timers?: { fire(row: TimerRow, signal: AbortSignal): Promise<any> };
  timerBackoffMs?: number;
  timerMaxAttempts?: number;
}) {
  const store = opts.path ? BotStore.open(opts.path, { instanceId: opts.id }) : BotStore.memory();
  const fires = opts.fires ?? [];
  const entries: ScheduleEntry[] = opts.expr
    ? [
        {
          id: parseCron(opts.expr, "UTC").expression,
          cron: parseCron(opts.expr, "UTC"),
          missed: opts.missed ?? "skip",
          run: async (info, signal) => {
            const f = {
              scheduledFor: info.scheduledFor,
              missed: info.missed,
              missedCount: info.missedCount,
            };
            fires.push(f);
            await opts.handler?.(f, signal);
          },
        },
      ]
    : [];
  const scheduler = new BotScheduler({
    store,
    clock: opts.clock,
    logger,
    entries,
    timers: opts.timers,
    graceMs: opts.graceMs ?? 120_000,
    timerBackoffMs: opts.timerBackoffMs,
    timerMaxAttempts: opts.timerMaxAttempts,
  });
  closers.push(() => store.close());
  return { store, scheduler, fires };
}

describe("BotScheduler: cron", () => {
  it("chỉ chạy các mốc SAU lúc đăng ký, đúng một lần mỗi mốc", async () => {
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const { scheduler, fires } = setup({ clock, expr: "*/5 * * * *" });
    await scheduler.tick();
    await scheduler.idle();
    expect(fires).toEqual([]); // 00:00 là quá khứ, không bù

    clock.set("2026-10-25T00:05:10Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(fires.map(hhmm)).toEqual(["00:05"]);
    expect(fires[0]).toMatchObject({ missed: false, missedCount: 0 });

    await scheduler.tick();
    await scheduler.idle();
    expect(fires).toHaveLength(1); // cùng mốc không chạy lại

    clock.set("2026-10-25T00:10:01Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(fires.map(hhmm)).toEqual(["00:05", "00:10"]);
  });

  it("skip: mốc lỡ quá hạn bị bỏ, mốc kế tiếp vẫn chạy", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:30:00Z"));
    const a = setup({ path, clock, expr: "0 * * * *", missed: "skip" });
    await a.scheduler.tick(); // đăng ký baseline 00:30
    a.store.close();
    clock.set("2026-10-25T03:30:00Z"); // bot tắt 3 giờ
    const b = setup({ path, clock, expr: "0 * * * *", missed: "skip" });
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(b.fires).toEqual([]);
    expect(logs.some((l) => l.includes("bỏ qua 3 mốc"))).toBe(true);
    await b.scheduler.tick();
    expect(b.fires).toEqual([]); // đã ghi nhận, không thử lại mỗi tick

    clock.set("2026-10-25T04:00:05Z");
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(b.fires.map(hhmm)).toEqual(["04:00"]);
    expect(b.fires[0].missed).toBe(false);
  });

  it("catch-up-once: chạy bù MỘT lần cho mọi mốc đã lỡ", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:30:00Z"));
    const a = setup({ path, clock, expr: "0 * * * *", missed: "catch-up-once" });
    await a.scheduler.tick();
    a.store.close();
    clock.set("2026-10-25T03:30:00Z");
    const b = setup({ path, clock, expr: "0 * * * *", missed: "catch-up-once" });
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(b.fires).toHaveLength(1);
    expect(b.fires[0]).toMatchObject({ missed: true, missedCount: 3 });
    expect(iso(b.fires[0].scheduledFor)).toBe("2026-10-25T03:00:00.000Z");
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(b.fires).toHaveLength(1);
  });

  it("mốc trễ trong hạn graceMs vẫn là đúng giờ", async () => {
    const clock = new FakeClock(at("2026-10-25T00:30:00Z"));
    const { scheduler, fires } = setup({ clock, expr: "0 * * * *", graceMs: 120_000 });
    await scheduler.tick();
    clock.set("2026-10-25T01:01:30Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(fires).toHaveLength(1);
    expect(fires[0].missed).toBe(false);
  });

  it("restart giữa chừng: instance mới cùng kho không chạy lại mốc đã chạy", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const first = setup({ path, id: "A", clock, expr: "*/5 * * * *" });
    await first.scheduler.tick();
    clock.set("2026-10-25T00:05:05Z");
    await first.scheduler.tick();
    await first.scheduler.idle();
    expect(first.fires).toHaveLength(1);
    await first.scheduler.stop();
    first.store.close();

    const second = setup({ path, id: "B", clock, expr: "*/5 * * * *" });
    await second.scheduler.tick();
    await second.scheduler.idle();
    expect(second.fires).toHaveLength(0);
    clock.set("2026-10-25T00:10:05Z");
    await second.scheduler.tick();
    await second.scheduler.idle();
    expect(second.fires.map(hhmm)).toEqual(["00:10"]);
  });

  it("hai instance cùng kho: mỗi mốc chỉ MỘT bên chạy, kể cả khi tick đồng thời", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const fires: Fire[] = [];
    const a = setup({ path, id: "A", clock, expr: "*/5 * * * *", fires });
    const b = setup({ path, id: "B", clock, expr: "*/5 * * * *", fires });
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    for (const slot of ["00:05:05", "00:10:05", "00:15:05"]) {
      clock.set(`2026-10-25T${slot}Z`);
      await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
      await Promise.all([a.scheduler.idle(), b.scheduler.idle()]);
    }
    expect(fires.map(hhmm)).toEqual(["00:05", "00:10", "00:15"]);
  });

  it("lease chặn chạy chồng: handler chậm ở A thì B không chạy mốc kế tiếp", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const fires: Fire[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = setup({ path, id: "A", clock, expr: "* * * * *", fires, handler: () => gate });
    const b = setup({ path, id: "B", clock, expr: "* * * * *", fires });
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    clock.set("2026-10-25T00:01:05Z");
    await a.scheduler.tick(); // A bắt đầu mốc 00:01 và treo
    await b.scheduler.tick(); // B thấy lease của A: chờ
    await b.scheduler.idle();
    expect(fires.map(hhmm)).toEqual(["00:01"]);

    clock.set("2026-10-25T00:02:05Z");
    await b.scheduler.tick(); // lease của A (tới 00:03:05) còn hạn
    await b.scheduler.idle();
    expect(fires).toHaveLength(1);
    release();
    await a.scheduler.idle();
    await b.scheduler.tick(); // lease đã nhả: B chạy mốc 00:02
    await b.scheduler.idle();
    expect(fires.map(hhmm)).toEqual(["00:01", "00:02"]);
  });

  it("lease của process đã sập hết hạn thì bên khác chạy tiếp", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const fires: Fire[] = [];
    const a = setup({ path, id: "A", clock, expr: "*/5 * * * *", fires });
    const b = setup({ path, id: "B", clock, expr: "*/5 * * * *", fires });
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    // A chiếm mốc 00:05 rồi "sập": không bao giờ chạy handler hay finishCron.
    clock.set("2026-10-25T00:05:05Z");
    expect(
      a.store.claimCronSlot({
        job: "*/5 * * * *",
        slot: at("2026-10-25T00:05:00Z"),
        now: clock.t,
        leaseMs: 120_000,
        run: true,
      }),
    ).toBe("claimed");
    // Tới 00:10:05 lease (00:05:05 + 120 s) đã hết hạn.
    clock.set("2026-10-25T00:10:05Z");
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(fires.map(hhmm)).toEqual(["00:10"]);
  });

  it("handler lỗi: ghi log, mốc không chạy lại, lịch vẫn tiếp tục", async () => {
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    let calls = 0;
    const { scheduler, store } = setup({
      clock,
      expr: "*/5 * * * *",
      handler: async () => {
        calls++;
        if (calls === 1) throw new Error("hỏng");
      },
    });
    await scheduler.tick();
    clock.set("2026-10-25T00:05:05Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(store.cronStatus("*/5 * * * *")?.status).toBe("failed");
    expect(logs.some((l) => l.includes("hỏng"))).toBe(true);
    await scheduler.tick();
    await scheduler.idle();
    expect(calls).toBe(1);
    clock.set("2026-10-25T00:10:05Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(calls).toBe(2);
    expect(store.cronStatus("*/5 * * * *")?.status).toBe("done");
  });

  it("stop(): quá hạn drain thì huỷ signal của handler", async () => {
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    let aborted = false;
    const { scheduler } = setup({
      clock,
      expr: "*/5 * * * *",
      handler: (_f, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    });
    await scheduler.tick();
    clock.set("2026-10-25T00:05:05Z");
    await scheduler.tick();
    await scheduler.stop(20, 200);
    expect(aborted).toBe(true);
  });

  it("start/stop thật chạy tick đầu ngay và báo health", async () => {
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const { scheduler } = setup({ clock, expr: "*/5 * * * *" });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(scheduler.health()).toMatchObject({ running: true, jobs: 1, pendingTimers: 0 });
    expect(scheduler.health().lastTickAt).toBe(clock.t);
    await scheduler.stop();
    expect(scheduler.health().running).toBe(false);
  });
});

describe("BotScheduler: hẹn giờ", () => {
  const spec = (key: string, dueAt: number) => ({ key, rule: "r", step: 0, dueAt, issueId: 1 });

  it("chạy timer đến hạn đúng một lần và đánh done", async () => {
    const clock = new FakeClock(1000);
    const ran: string[] = [];
    const { scheduler, store } = setup({
      clock,
      timers: { fire: async (row) => (ran.push(row.key), { status: "done" }) },
    });
    store.armTimer(spec("k", 5000), clock.t);
    await scheduler.tick();
    await scheduler.idle();
    expect(ran).toEqual([]);
    clock.t = 5000;
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.tick();
    expect(ran).toEqual(["k"]);
    expect(store.getTimer("k")?.state).toBe("done");
  });

  it("skipped → cancelled kèm lý do", async () => {
    const clock = new FakeClock(0);
    const { scheduler, store } = setup({
      clock,
      timers: { fire: async () => ({ status: "skipped", reason: "đã mở lại" }) },
    });
    store.armTimer(spec("k", 0), 0);
    await scheduler.tick();
    await scheduler.idle();
    expect(store.getTimer("k")).toMatchObject({ state: "cancelled", lastError: "đã mở lại" });
  });

  it("lỗi: thử lại có backoff, quá số lần thì failed", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const { scheduler, store } = setup({
      clock,
      timerBackoffMs: 1000,
      timerMaxAttempts: 3,
      timers: {
        fire: async () => {
          calls++;
          throw new Error("itsaplan lỗi");
        },
      },
    });
    store.armTimer(spec("k", 0), 0);
    await scheduler.tick();
    await scheduler.idle();
    expect(calls).toBe(1);
    expect(store.getTimer("k")).toMatchObject({ state: "pending", dueAt: 1000, attempts: 1 });
    await scheduler.tick();
    await scheduler.idle();
    expect(calls).toBe(1); // chưa tới hạn thử lại
    clock.t = 1000;
    await scheduler.tick();
    await scheduler.idle();
    expect(store.getTimer("k")).toMatchObject({ state: "pending", dueAt: 3000, attempts: 2 });
    clock.t = 3000;
    await scheduler.tick();
    await scheduler.idle();
    expect(calls).toBe(3);
    expect(store.getTimer("k")).toMatchObject({ state: "failed", lastError: "itsaplan lỗi" });
  });

  it("hai instance cùng kho: timer đến hạn chỉ chạy một lần", async () => {
    const path = dbPath();
    const clock = new FakeClock(0);
    const ran: string[] = [];
    const timers = {
      fire: async (row: TimerRow) => (ran.push(row.key), { status: "done" as const }),
    };
    const a = setup({ path, id: "A", clock, timers });
    const b = setup({ path, id: "B", clock, timers });
    for (let i = 0; i < 5; i++) a.store.armTimer(spec(`k${i}`, 100), 0);
    clock.t = 100;
    for (let round = 0; round < 3; round++) {
      await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
      await Promise.all([a.scheduler.idle(), b.scheduler.idle()]);
    }
    expect(ran.sort()).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });

  it("timer đang chạy mà process sập: lease hết thì instance khác chạy lại", async () => {
    const path = dbPath();
    const clock = new FakeClock(0);
    const ran: number[] = [];
    const a = setup({ path, id: "A", clock });
    const b = setup({
      path,
      id: "B",
      clock,
      timers: { fire: async (row) => (ran.push(row.attempts), { status: "done" }) },
    });
    a.store.armTimer(spec("k", 0), 0);
    expect(a.store.claimTimer("k", 1, 0, 1000)).toBe(true); // A claim rồi "sập"
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(ran).toEqual([]); // lease của A còn hạn
    clock.t = 1001;
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(ran).toEqual([2]);
    expect(b.store.getTimer("k")?.state).toBe("done");
  });

  it("bot dừng giữa lúc chạy timer: timer được hẹn lại ngay, không tính lỗi", async () => {
    const clock = new FakeClock(0);
    const { scheduler, store } = setup({
      clock,
      timers: {
        fire: (_row, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    });
    store.armTimer(spec("k", 0), 0);
    await scheduler.tick();
    await scheduler.stop(10, 200);
    expect(store.getTimer("k")).toMatchObject({ state: "pending", dueAt: 0 });
  });
});
