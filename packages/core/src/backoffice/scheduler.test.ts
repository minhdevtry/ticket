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

describe("BotScheduler: hiệu năng quét mốc lỡ", () => {
  it("lịch mỗi phút sau 4 ngày tắt máy (skip): một tick, lượt quét có trần, không chặn event loop", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const a = setup({ path, clock, expr: "* * * * *", missed: "skip" });
    // Tick đầu: đăng ký baseline, đồng thời là MỐC THAM CHIẾU để đo tỉ lệ.
    const tBase = performance.now();
    await a.scheduler.tick();
    const baseMs = performance.now() - tBase;
    a.store.close();
    clock.t = at("2026-10-29T00:00:30Z"); // tắt 4 ngày
    const b = setup({ path, clock, expr: "* * * * *", missed: "skip" });
    const t0 = performance.now();
    await b.scheduler.tick();
    const elapsed = performance.now() - t0;
    await b.scheduler.idle();
    // Mốc gần nhất (00:00) trễ 30 giây, trong hạn graceMs: chạy đúng giờ; các mốc trước bị bỏ.
    expect(b.fires).toHaveLength(1);
    expect(b.fires[0]).toMatchObject({ missed: false, missedCount: 4 * 24 * 60 - 1 });
    expect(logs.some((l) => /mốc trước đó đã lỡ và bị bỏ/.test(l))).toBe(true);
    // Ngân sách thời gian phụ thuộc tốc độ máy: dưới tải nặng (CI, nhiều agent chạy
    // song song) một tick vẫn có thể chậm hơn 50 ms mà khối lượng tính thì không đổi.
    // Nên đo TỈ LỆ với một tick bình thường đo cùng lúc: tải máy ảnh hưởng cả hai như
    // nhau, còn việc quét 5.760 mốc lỡ thì tăng thật. Ngưỡng 50 ms vẫn giữ làm trần
    // tối thiểu để một tick quá tải vẫn bị bắt.
    expect(elapsed).toBeLessThan(Math.max(50, baseMs * 10));
  });

  it("lịch giờ một lần/ngày sau 4 ngày tắt (skip, trễ quá hạn): bỏ qua, không chạy, tick nhanh", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const a = setup({ path, clock, expr: "0 8 * * *", missed: "skip" });
    await a.scheduler.tick();
    a.store.close();
    clock.t = at("2026-10-29T12:00:00Z");
    const b = setup({ path, clock, expr: "0 8 * * *", missed: "skip" });
    const t0 = performance.now();
    await b.scheduler.tick();
    const elapsed = performance.now() - t0;
    await b.scheduler.idle();
    expect(b.fires).toEqual([]);
    expect(logs.some((l) => /bỏ qua \d+ mốc đã lỡ/.test(l))).toBe(true);
    // Lịch giờ một lần/ngày chỉ có vài mốc lỡ, nên ca này không đo tỉ lệ được; giữ
    // một trần rộng để bắt treo, và ý "không chạy job lỡ" đã khẳng định ở trên.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("6 giờ tắt máy với catch-up-once: một lần chạy bù, missedCount đúng, tick nhanh", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const a = setup({ path, clock, expr: "* * * * *", missed: "catch-up-once" });
    await a.scheduler.tick();
    a.store.close();
    clock.t = at("2026-10-25T06:00:30Z");
    const b = setup({ path, clock, expr: "* * * * *", missed: "catch-up-once" });
    const t0 = performance.now();
    await b.scheduler.tick();
    await b.scheduler.idle();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(b.fires).toHaveLength(1);
    // Mốc 06:00 trễ 30 giây (trong hạn): chạy đúng giờ, 359 mốc trước đó được gộp.
    expect(b.fires[0]).toMatchObject({ missed: false, missedCount: 359 });
  });

  it("tick thường (không có mốc nào đến hạn) gần như không tốn gì: nhớ mốc kế tiếp", async () => {
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const { scheduler } = setup({ clock, expr: "0 8 * * *" });
    await scheduler.tick();
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      clock.t += 1000;
      await scheduler.tick();
    }
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("BotScheduler: không để lỗi lọt thành unhandled rejection", () => {
  async function noUnhandled(body: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const handler = (reason: unknown) => void seen.push(reason);
    process.on("unhandledRejection", handler);
    try {
      await body();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off("unhandledRejection", handler);
    }
    return seen;
  }

  it("kho ném khi ghi kết quả timer (done): thử lại thay vì unhandled", async () => {
    const clock = new FakeClock(0);
    const { scheduler, store } = setup({
      clock,
      timers: { fire: async () => ({ status: "done" }) },
    });
    store.armTimer({ key: "k", rule: "r", step: 0, dueAt: 0, issueId: 1 }, 0);
    store.finishTimer = () => {
      throw new Error("database is locked");
    };
    const seen = await noUnhandled(async () => {
      await scheduler.tick();
      await scheduler.idle();
    });
    expect(seen).toEqual([]);
    // finishTimer lỗi sau khi hành động xong: coi như lần chạy lỗi, thử lại có backoff (at-least-once)
    expect(store.getTimer("k")).toMatchObject({ state: "pending", attempts: 1 });
    expect(store.getTimer("k")?.lastError).toContain("database is locked");
  });

  it("kho ném cả trong nhánh xử lý lỗi của timer (failTimer): ghi log, hẹn ở firing chờ hết lease", async () => {
    const clock = new FakeClock(0);
    const { scheduler, store } = setup({
      clock,
      timers: {
        fire: async () => {
          throw new Error("itsaplan lỗi");
        },
      },
    });
    store.armTimer({ key: "k", rule: "r", step: 0, dueAt: 0, issueId: 1 }, 0);
    store.failTimer = () => {
      throw new Error("database is locked");
    };
    const seen = await noUnhandled(async () => {
      await scheduler.tick();
      await scheduler.idle();
    });
    expect(seen).toEqual([]);
    expect(scheduler.health().lastError).toContain("database is locked");
    expect(logs.some((l) => l.includes("không ghi được kết quả"))).toBe(true);
    expect(store.getTimer("k")?.state).toBe("firing");
  });

  it("handler lịch lỗi và kho ném khi finishCron", async () => {
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const { scheduler, store } = setup({
      clock,
      expr: "*/5 * * * *",
      handler: async () => {
        throw new Error("hỏng");
      },
    });
    await scheduler.tick();
    store.finishCron = () => {
      throw new Error("locked");
    };
    clock.set("2026-10-25T00:05:05Z");
    const seen = await noUnhandled(async () => {
      await scheduler.tick();
      await scheduler.idle();
    });
    expect(seen).toEqual([]);
  });
});

describe("BotScheduler: vòng đời, health, dọn dẹp", () => {
  it("start() sau stop() ném lỗi rõ ràng", async () => {
    const clock = new FakeClock(0);
    const { scheduler } = setup({ clock });
    scheduler.start();
    await scheduler.stop();
    expect(() => scheduler.start()).toThrow(/đã dừng/);
  });

  it("timer bị huỷ vì bot dừng không bị tính một lần thử", async () => {
    const clock = new FakeClock(0);
    const { scheduler, store } = setup({
      clock,
      timers: {
        fire: (_row, signal) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      },
    });
    store.armTimer({ key: "k", rule: "r", step: 0, dueAt: 0, issueId: 1 }, 0);
    await scheduler.tick();
    await scheduler.stop(10, 200);
    expect(store.getTimer("k")).toMatchObject({ state: "pending", attempts: 0 });
  });

  it("health đếm hẹn đang chạy và hẹn đã bỏ cuộc gần đây; lỗi tự hết sau cửa sổ 15 phút", async () => {
    const clock = new FakeClock(1_000_000);
    const { scheduler, store } = setup({
      clock,
      timerMaxAttempts: 1,
      timers: {
        fire: async (row) => {
          if (row.key === "bad") throw new Error("hỏng nặng");
          return new Promise(() => {}); // treo: giữ ở firing
        },
      },
    });
    store.armTimer({ key: "bad", rule: "r", step: 0, dueAt: 0, issueId: 1 }, 0);
    store.armTimer({ key: "hang", rule: "r", step: 0, dueAt: 0, issueId: 2 }, 0);
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
    let h = scheduler.health();
    expect(h).toMatchObject({ failedTimers: 1, firingTimers: 1 });
    expect(h.lastError).toContain("hỏng nặng");
    clock.t += 16 * 60_000;
    h = scheduler.health();
    expect(h.lastError).toBeNull();
    expect(h.failedTimers).toBe(1); // vẫn trong 24 giờ
    clock.t += 25 * 3_600_000;
    expect(scheduler.health().failedTimers).toBe(0);
  });

  it("tickLagMs báo vòng tick bị kẹt", async () => {
    const clock = new FakeClock(5000);
    const { scheduler } = setup({ clock });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(scheduler.health().tickLagMs).toBe(0);
    clock.t += 60_000;
    expect(scheduler.health().tickLagMs).toBe(60_000);
    await scheduler.stop();
    expect(scheduler.health().tickLagMs).toBeNull();
  });

  it("lịch bị gỡ khỏi khai báo (hoặc đổi múi giờ/id) bị dọn khỏi kho", async () => {
    const path = dbPath();
    const clock = new FakeClock(at("2026-10-25T00:00:30Z"));
    const a = setup({ path, clock, expr: "0 8 * * *" });
    await a.scheduler.tick();
    expect(a.store.cronStatus("0 8 * * *")).not.toBeNull();
    a.store.close();
    const b = setup({ path, clock, expr: "0 9 * * *" });
    await b.scheduler.tick();
    expect(b.store.cronStatus("0 8 * * *")).toBeNull();
    expect(b.store.cronStatus("0 9 * * *")).not.toBeNull();
  });
});
