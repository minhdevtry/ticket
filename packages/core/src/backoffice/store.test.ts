import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_STORE_SCHEMA_VERSION, BotStore, BotStoreVersionError, MemoryKeySet } from "./store";

const dirs: string[] = [];
const stores: BotStore[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "botstore-"));
  dirs.push(d);
  return join(d, "bot.sqlite");
};
const open = (path: string, id?: string) => {
  const s = BotStore.open(path, { instanceId: id });
  stores.push(s);
  return s;
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0))
    rmSync(d.replace(/\/bot\.sqlite$/, ""), { recursive: true, force: true });
});

const spec = (key: string, dueAt: number, extra: object = {}) => ({
  key,
  rule: "r",
  step: 0,
  dueAt,
  issueId: 7,
  ...extra,
});

describe("BotStore: schema có phiên bản", () => {
  it("tạo file, đặt user_version, mở lại không chạy lại migration", () => {
    const path = tmp();
    const a = open(path);
    expect(a.durable).toBe(true);
    expect(a.schemaVersion()).toBe(BOT_STORE_SCHEMA_VERSION);
    a.armTimer(spec("k", 10), 1);
    a.close();
    const b = open(path);
    expect(b.schemaVersion()).toBe(BOT_STORE_SCHEMA_VERSION);
    expect(b.getTimer("k")?.dueAt).toBe(10); // dữ liệu còn nguyên
  });

  it("file do bản code mới hơn tạo ra bị từ chối, không bị sửa", () => {
    const path = tmp();
    open(path).close();
    const raw = new Database(path);
    raw.run(`PRAGMA user_version = ${BOT_STORE_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => BotStore.open(path)).toThrow(BotStoreVersionError);
    const check = new Database(path);
    expect(
      (check.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(BOT_STORE_SCHEMA_VERSION + 1);
    check.close();
  });

  it("memory(): cùng mã, không bền", () => {
    const m = BotStore.memory();
    stores.push(m);
    expect(m.durable).toBe(false);
    expect(m.schemaVersion()).toBe(BOT_STORE_SCHEMA_VERSION);
  });

  it("bật WAL cho file", () => {
    const path = tmp();
    open(path);
    const raw = new Database(path);
    expect((raw.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    raw.close();
  });
});

describe("BotStore: ledger và khoá bền qua restart", () => {
  it("ledger giữ kết quả run sau khi mở lại", async () => {
    const path = tmp();
    const a = open(path);
    await a.ledger().set(5, { status: "success", output: "xong" });
    a.close();
    const ledger = open(path).ledger();
    expect(await ledger.get(5)).toEqual({ status: "success", output: "xong" });
    await ledger.delete(5);
    expect(await ledger.get(5)).toBeUndefined();
  });

  it("ledger dọn mục cũ hơn hạn lưu", async () => {
    const s = BotStore.memory();
    stores.push(s);
    await s.ledger({ now: () => 0 }).set(1, { status: "success" });
    const later = s.ledger({ now: () => 15 * 86_400_000 });
    expect(await later.get(1)).toBeUndefined();
  });

  it("keys: sống qua restart, tách theo namespace, hết hạn theo ttl", () => {
    const path = tmp();
    const a = open(path);
    a.keys("comment").add("agent-run:1:reply#1");
    a.close();
    const b = open(path);
    expect(b.keys("comment").has("agent-run:1:reply#1")).toBe(true);
    expect(b.keys("rule-seen").has("agent-run:1:reply#1")).toBe(false);
    const old = b.keys("x", { now: () => 0 });
    old.add("cũ");
    expect(b.keys("x", { ttlMs: 1000, now: () => 5000 }).has("cũ")).toBe(false);
  });

  it("MemoryKeySet chặn kích thước", () => {
    const k = new MemoryKeySet(2);
    k.add("a");
    k.add("b");
    k.add("c");
    expect([k.has("a"), k.has("b"), k.has("c")]).toEqual([false, true, true]);
  });
});

describe("BotStore: lease", () => {
  it("một chủ tại một thời điểm; hết hạn thì giành được; chủ cũ gia hạn được", () => {
    const path = tmp();
    const a = open(path, "A");
    const b = open(path, "B");
    expect(a.acquireLease("x", 1000, 0)).toBe(true);
    expect(b.acquireLease("x", 1000, 500)).toBe(false);
    expect(a.acquireLease("x", 1000, 600)).toBe(true); // gia hạn
    expect(b.acquireLease("x", 1000, 1500)).toBe(false);
    expect(b.acquireLease("x", 1000, 1700)).toBe(true); // A hết hạn
    expect(a.leaseInfo("x")?.owner).toBe("B");
    a.releaseLease("x"); // không phải chủ: không nhả được
    expect(b.leaseInfo("x")?.owner).toBe("B");
    b.releaseLease("x");
    expect(b.leaseInfo("x")).toBeNull();
  });
});

describe("BotStore: mốc cron", () => {
  it("registerCron chỉ đặt baseline lần đầu", () => {
    const s = open(tmp());
    expect(s.registerCron("j", 100)).toBe(100);
    expect(s.registerCron("j", 999)).toBe(100);
  });

  it("claimCronSlot: một bên thắng mỗi mốc; mốc cũ hơn là already; lease giữ bên kia ở busy ở mốc kế tiếp", () => {
    const path = tmp();
    const a = open(path, "A");
    const b = open(path, "B");
    a.registerCron("j", 0);
    const args = { job: "j", now: 1000, leaseMs: 5000, run: true } as const;
    expect(a.claimCronSlot({ ...args, slot: 100 })).toBe("claimed");
    expect(b.claimCronSlot({ ...args, slot: 100 })).toBe("already");
    // mốc kế tiếp trong lúc A còn giữ lease: B phải chờ
    expect(b.claimCronSlot({ ...args, slot: 200 })).toBe("busy");
    a.finishCron("j", "done", 1100);
    expect(b.claimCronSlot({ ...args, slot: 200 })).toBe("claimed");
    expect(a.claimCronSlot({ ...args, slot: 150 })).toBe("already");
    expect(a.cronStatus("j")).toMatchObject({ lastSlot: 200, status: "running" });
  });

  it("claim kiểu bỏ qua (run=false) ghi mốc nhưng không lấy lease", () => {
    const s = open(tmp(), "A");
    s.registerCron("j", 0);
    expect(s.claimCronSlot({ job: "j", slot: 50, now: 10, leaseMs: 1000, run: false })).toBe(
      "claimed",
    );
    expect(s.leaseInfo("cron:j")).toBeNull();
    expect(s.cronStatus("j")).toMatchObject({ lastSlot: 50, status: "skipped" });
  });

  it("lease hết hạn (process sập) thì bên khác chạy được mốc kế tiếp", () => {
    const path = tmp();
    const a = open(path, "A");
    const b = open(path, "B");
    a.registerCron("j", 0);
    expect(a.claimCronSlot({ job: "j", slot: 10, now: 0, leaseMs: 100, run: true })).toBe(
      "claimed",
    );
    expect(b.claimCronSlot({ job: "j", slot: 20, now: 50, leaseMs: 100, run: true })).toBe("busy");
    expect(b.claimCronSlot({ job: "j", slot: 20, now: 150, leaseMs: 100, run: true })).toBe(
      "claimed",
    );
  });
});

describe("BotStore: hẹn giờ", () => {
  it("arm mới, giữ hẹn đang chờ, thay khi replace, hẹn lại sau khi huỷ (gen tăng)", () => {
    const s = open(tmp());
    expect(s.armTimer(spec("k", 100, { cancelOn: ["comment"] }), 0)).toEqual({
      outcome: "new",
      gen: 1,
    });
    expect(s.armTimer(spec("k", 999), 5)).toEqual({ outcome: "kept", gen: 1 });
    expect(s.getTimer("k")?.dueAt).toBe(100);
    expect(s.getTimer("k")?.cancelOn).toEqual(["comment"]);
    expect(s.armTimer(spec("k", 300, { replace: true, cancelOn: ["state-change"] }), 6)).toEqual({
      outcome: "replaced",
      gen: 1,
    });
    expect(s.getTimer("k")).toMatchObject({ dueAt: 300, armedAt: 6, cancelOn: ["state-change"] });
    expect(s.cancelTimer("k", "thử", 7)).toBe(true);
    expect(s.cancelTimer("k", "thử", 8)).toBe(false);
    expect(s.armTimer(spec("k", 400), 9)).toEqual({ outcome: "rearmed", gen: 2 });
    expect(s.getTimer("k")).toMatchObject({
      state: "pending",
      attempts: 0,
      dueAt: 400,
      lastError: null,
    });
  });

  it("payload khứ hồi JSON", () => {
    const s = open(tmp());
    s.armTimer(spec("k", 1, { payload: { a: [1, 2], b: "x" } }), 0);
    expect(s.getTimer("k")?.payload).toEqual({ a: [1, 2], b: "x" });
  });

  it("cancelByToken chỉ huỷ timer pending của đúng issue có token đó", () => {
    const s = open(tmp());
    s.armTimer(spec("a", 100, { issueId: 1, cancelOn: ["comment"] }), 0);
    s.armTimer(spec("b", 100, { issueId: 1, cancelOn: ["state-change"] }), 0);
    s.armTimer(spec("c", 100, { issueId: 2, cancelOn: ["comment"] }), 0);
    expect(s.cancelByToken(1, "comment", "x", 5)).toBe(1);
    expect(s.listTimers({ state: "pending" }).map((t) => t.key)).toEqual(["b", "c"]);
    expect(s.cancelAllForIssue(1, "xoá", 6)).toBe(1);
    expect(s.listTimers({ state: "pending" }).map((t) => t.key)).toEqual(["c"]);
  });

  it("dueTimers/claimTimer: chỉ một bên claim; sập thì lease hết hạn cho bên khác", () => {
    const path = tmp();
    const a = open(path, "A");
    const b = open(path, "B");
    a.armTimer(spec("k", 100), 0);
    expect(a.dueTimers(99)).toEqual([]);
    const [due] = a.dueTimers(100);
    expect(a.claimTimer(due.key, due.gen, 100, 50)).toBe(true);
    expect(b.claimTimer(due.key, due.gen, 100, 50)).toBe(false);
    expect(b.dueTimers(120)).toEqual([]); // A còn lease
    const [stale] = b.dueTimers(150); // lease hết: A coi như sập
    expect(b.claimTimer(stale.key, stale.gen, 150, 50)).toBe(true);
    expect(b.getTimer("k")).toMatchObject({ attempts: 2, owner: "B", state: "firing" });
    // A (đã mất quyền) không ghi đè được kết quả của B
    expect(a.finishTimer("k", 1, "done", null, 160)).toBe(false);
    expect(b.finishTimer("k", 1, "done", null, 160)).toBe(true);
  });

  it("huỷ không chạm timer đang firing; failTimer hẹn lại hoặc đánh failed", () => {
    const s = open(tmp(), "A");
    s.armTimer(spec("k", 0), 0);
    s.claimTimer("k", 1, 0, 100);
    expect(s.cancelTimer("k", "x", 1)).toBe(false);
    expect(s.cancelByToken(7, "comment", "x", 1)).toBe(0);
    expect(s.failTimer("k", 1, "lỗi", 500, 2)).toBe(true);
    expect(s.getTimer("k")).toMatchObject({ state: "pending", dueAt: 500, lastError: "lỗi" });
    s.claimTimer("k", 1, 500, 100);
    s.failTimer("k", 1, "lại lỗi", null, 501);
    expect(s.getTimer("k")?.state).toBe("failed");
  });

  it("purgeTimers dọn timer đã kết thúc cũ", () => {
    const s = open(tmp());
    s.armTimer(spec("old", 0, { cancelOn: ["comment"] }), 0);
    s.cancelTimer("old", "x", 0);
    s.armTimer(spec("live", 0), 0);
    expect(s.purgeTimers(1000, 5000)).toBe(1);
    expect(s.listTimers().map((t) => t.key)).toEqual(["live"]);
  });
});
