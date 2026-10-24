import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeOpenLazyDb,
  isDegradedDb,
  setLogger,
  getLogger,
  resolveDbPath,
  inspectBindingDb,
} from "./index";
import { Database } from "bun:sqlite";

/**
 * Bản gốc intake không có test cho `lazy-db` (nó khoá vào schema intake). Lõi
 * tiêm `applySchema` nên hành vi cần kiểm là: (1) cùng `dbPath` chia sẻ đúng một
 * kết nối; (2) `applySchema` được gọi đúng một lần; (3) không truyền schema thì
 * mở DB trần chạy được. Dùng `:memory:` để không chạm đĩa.
 */
describe("makeOpenLazyDb", () => {
  it("cùng dbPath → cùng một kết nối, applySchema gọi đúng một lần", () => {
    let applied = 0;
    const open = makeOpenLazyDb({
      applySchema: (db) => {
        db.run("CREATE TABLE t (id INTEGER)");
        applied++;
      },
    });

    const a = open(":memory:");
    const b = open(":memory:");

    expect(a).toBe(b);
    expect(applied).toBe(1);
  });

  it("không truyền applySchema → mở DB trần, vẫn chạy được query", () => {
    const open = makeOpenLazyDb();
    const db = open(":memory:");
    db.run("CREATE TABLE x (v TEXT)");
    db.run("INSERT INTO x (v) VALUES ('hi')");
    const row = db.query("SELECT v FROM x").get() as { v: string };
    expect(row.v).toBe("hi");
  });

  it("hai factory khác nhau không dùng chung cache", () => {
    const open1 = makeOpenLazyDb();
    const open2 = makeOpenLazyDb();
    expect(open1(":memory:")).not.toBe(open2(":memory:"));
  });

  // ── ADR-0003 điểm 3: file hỏng không được làm chết bot ──────────────────────
  it("file SQLite hỏng → không ném, hạ xuống :memory: (isDegradedDb=true), vẫn query được", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazydb-corrupt-"));
    const bad = join(dir, "corrupt.db");
    writeFileSync(bad, "đây không phải là file SQLite hợp lệ, chỉ là rác\n".repeat(10));

    // bắt log cảnh báo để chắc có log, không im lặng nuốt lỗi
    const warnings: string[] = [];
    const prev = getLogger();
    setLogger({ ...prev, warn: (m: string) => warnings.push(m) } as any);
    try {
      const open = makeOpenLazyDb({ applySchema: (db) => db.run("CREATE TABLE t (id INTEGER)") });
      let db!: ReturnType<typeof open>;
      expect(() => {
        db = open(bad);
      }).not.toThrow();
      expect(isDegradedDb(db)).toBe(true);
      // schema vẫn áp trên bản :memory: → bảng dùng được, coi như cache rỗng
      db.run("INSERT INTO t (id) VALUES (1)");
      expect((db.query("SELECT COUNT(*) c FROM t").get() as { c: number }).c).toBe(1);
      // cùng path gọi lại không mở lại file hỏng → cùng một kết nối degraded
      expect(open(bad)).toBe(db);
      expect(warnings.some((w) => w.includes("hạ xuống"))).toBe(true);
    } finally {
      setLogger(prev);
    }
  });

  it('onOpenError: "throw" → file không mở được thì ném, không hạ xuống :memory:', () => {
    const dir = mkdtempSync(join(tmpdir(), "lazydb-throw-"));
    // Một FILE chắn ngang đường thư mục cha ⇒ mkdir/open chắc chắn lỗi.
    const obstacle = join(dir, "obstacle.txt");
    writeFileSync(obstacle, "not-a-directory");
    const bad = join(obstacle, "sub", "store.sqlite");

    const open = makeOpenLazyDb({
      applySchema: (db) => db.run("CREATE TABLE t (id INTEGER)"),
      onOpenError: "throw",
    });
    expect(() => open(bad)).toThrow();
    // Không cache kết quả lỗi: gọi lại vẫn ném (không trả một DB rỗng giả).
    expect(() => open(bad)).toThrow();

    // Mặc định vẫn là "degrade".
    const degrade = makeOpenLazyDb({ applySchema: (db) => db.run("CREATE TABLE t (id INTEGER)") });
    const prev = getLogger();
    setLogger({ ...prev, warn: () => {} } as any);
    try {
      expect(isDegradedDb(degrade(bad))).toBe(true);
    } finally {
      setLogger(prev);
    }
  });

  it("DB mở bình thường thì KHÔNG degraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazydb-ok-"));
    const open = makeOpenLazyDb({ applySchema: (db) => db.run("CREATE TABLE t (id INTEGER)") });
    const db = open(join(dir, "ok.db"));
    expect(isDegradedDb(db)).toBe(false);
    expect(isDegradedDb(open(":memory:"))).toBe(false);
  });
});

describe("resolveDbPath", () => {
  it("path tương đối → tuyệt đối theo base, và cảnh báo", () => {
    const prev = getLogger();
    const warns: string[] = [];
    setLogger({ ...prev, warn: (m: string) => warns.push(m) } as any);
    try {
      const abs = resolveDbPath("data/op.db", "/srv/intake-agents");
      expect(abs).toBe("/srv/intake-agents/data/op.db");
      expect(warns.some((w) => w.includes("tương đối") && w.includes("op.db"))).toBe(true);
    } finally {
      setLogger(prev);
    }
  });

  it("path tuyệt đối giữ nguyên, không cảnh báo", () => {
    const prev = getLogger();
    const warns: string[] = [];
    setLogger({ ...prev, warn: (m: string) => warns.push(m) } as any);
    try {
      expect(resolveDbPath("/abs/op.db")).toBe("/abs/op.db");
      expect(warns.length).toBe(0);
    } finally {
      setLogger(prev);
    }
  });

  it(":memory: và file: URI giữ nguyên", () => {
    expect(resolveDbPath(":memory:")).toBe(":memory:");
    expect(resolveDbPath("file:x?mode=memory&cache=shared")).toBe(
      "file:x?mode=memory&cache=shared",
    );
  });
});

describe("inspectBindingDb (chốt chặn worker trỏ nhầm DB — mục 3)", () => {
  function captureWarns(run: () => void): string[] {
    const prev = getLogger();
    const warns: string[] = [];
    setLogger({ ...prev, warn: (m: string) => warns.push(m), info: () => {} } as any);
    try {
      run();
      return warns;
    } finally {
      setLogger(prev);
    }
  }

  it("DB có binding → đếm đúng, không cảnh báo", () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-ok-"));
    const p = join(dir, "op.db");
    const db = new Database(p, { create: true });
    db.run(
      `CREATE TABLE ticket_bindings (issue_id INTEGER PRIMARY KEY, chat_id TEXT, identifier TEXT)`,
    );
    db.run(
      `INSERT INTO ticket_bindings (issue_id, chat_id, identifier) VALUES (1,'c','OP-1'),(2,'c','OP-2')`,
    );
    db.close();

    let report!: ReturnType<typeof inspectBindingDb>;
    const warns = captureWarns(() => {
      report = inspectBindingDb(p);
    });
    expect(report.bindingCount).toBe(2);
    expect(report.opened).toBe(true);
    expect(report.resolvedPath).toBe(p);
    expect(warns.length).toBe(0);
  });

  it("DB rỗng (0 binding) → cảnh báo trỏ nhầm DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-empty-"));
    const p = join(dir, "op.db");
    const db = new Database(p, { create: true });
    db.run(
      `CREATE TABLE ticket_bindings (issue_id INTEGER PRIMARY KEY, chat_id TEXT, identifier TEXT)`,
    );
    db.close();

    let report!: ReturnType<typeof inspectBindingDb>;
    const warns = captureWarns(() => {
      report = inspectBindingDb(p);
    });
    expect(report.bindingCount).toBe(0);
    expect(warns.some((w) => w.includes("RỖNG"))).toBe(true);
  });

  it("DB chưa có bảng ticket_bindings → cảnh báo + bindingCount null", () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-notable-"));
    const p = join(dir, "op.db");
    const db = new Database(p, { create: true });
    db.run(`CREATE TABLE something_else (x INTEGER)`);
    db.close();

    let report!: ReturnType<typeof inspectBindingDb>;
    const warns = captureWarns(() => {
      report = inspectBindingDb(p);
    });
    expect(report.bindingCount).toBeNull();
    expect(warns.some((w) => w.includes("CHƯA có bảng"))).toBe(true);
  });

  it(":memory: → không chẩn đoán (opened false)", () => {
    const report = inspectBindingDb(":memory:");
    expect(report.opened).toBe(false);
    expect(report.bindingCount).toBeNull();
  });
});
