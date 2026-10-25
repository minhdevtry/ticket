/**
 * Kho bền của bot (SQLite, `bun:sqlite`): MỘT file cho mỗi bot, dùng chung cho
 *  - sổ kết quả run chưa báo được (`RunLedger` của `AgentRunWorker`),
 *  - các khoá chống trùng đã ghi (`reply#n` của comment, sự kiện webhook mà luật đã xử lý),
 *  - lịch cron (mốc chạy gần nhất mỗi lịch) và lease một-instance,
 *  - hẹn giờ của luật (`after`, `closeAfter`) cùng khoá huỷ.
 *
 * Quy ước:
 *  - Chế độ WAL, `busy_timeout` 5 giây; mọi thao tác nhiều bước nằm trong một transaction
 *    `IMMEDIATE`, nên hai process cùng mở một file không giẫm nhau (xem lease và `claimTimer`).
 *  - Schema có phiên bản (`PRAGMA user_version`); mỗi migration chạy đúng một lần trong một
 *    transaction. File do bản code MỚI HƠN tạo ra bị từ chối (không ghi đè dữ liệu lạ).
 *  - Mọi mốc thời gian là epoch ms do caller truyền (đồng hồ tiêm vào được, không dùng giờ SQLite),
 *    nên test dùng đồng hồ giả.
 *  - itsaplan vẫn là nguồn sự thật (ADR-0003): kho này chỉ giữ thứ bot không thể suy ra lại
 *    (hẹn giờ, mốc cron, kết quả đã tính xong). Mất file thì mất các thứ đó, không hỏng dữ liệu ticket.
 *
 * `BotStore.memory()` dùng cùng mã trên SQLite `:memory:`: là mặc định của test và của bot
 * không đặt `dataDir`.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { AgentRunResult, RunLedger } from "../itsaplan";

/**
 * `bun:sqlite` chỉ nạp khi thật sự mở kho (lazy), để barrel `@vuihoc/bot-core/backoffice` vẫn
 * import được dưới Node: chỉ `BotStore.open/memory` cần Bun.
 */
let sqliteModule: typeof import("bun:sqlite") | undefined;
function sqlite(): typeof import("bun:sqlite") {
  if (!sqliteModule) {
    try {
      sqliteModule = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
    } catch (err) {
      throw new Error(
        `BotStore cần runtime Bun (bun:sqlite): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return sqliteModule;
}

type Migration = (db: Database) => void;

/** Danh sách migration, theo thứ tự. KHÔNG sửa migration đã phát hành: thêm cái mới ở cuối. */
const MIGRATIONS: readonly Migration[] = [
  // v1: nền tảng M2.
  (db) => {
    db.run(`CREATE TABLE run_ledger (
      run_id INTEGER PRIMARY KEY,
      result TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE dedupe_keys (
      ns TEXT NOT NULL,
      key TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (ns, key)
    )`);
    db.run("CREATE INDEX idx_dedupe_keys_at ON dedupe_keys (ns, at)");
    db.run(`CREATE TABLE leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE cron_jobs (
      job TEXT PRIMARY KEY,
      last_slot INTEGER NOT NULL,
      last_status TEXT,
      updated_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE timers (
      key TEXT PRIMARY KEY,
      gen INTEGER NOT NULL DEFAULT 1,
      rule TEXT NOT NULL,
      step INTEGER NOT NULL,
      issue_id INTEGER,
      identifier TEXT,
      armed_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      payload TEXT,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      owner TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX idx_timers_due ON timers (state, due_at)");
    db.run("CREATE INDEX idx_timers_issue ON timers (issue_id, state)");
    db.run(`CREATE TABLE timer_cancel_on (
      key TEXT NOT NULL,
      token TEXT NOT NULL,
      PRIMARY KEY (key, token)
    )`);
  },
  // v2: định danh hành động của hẹn, cờ yêu cầu huỷ khi đang chạy, hẹn xếp hàng khi hẹn lại lúc đang chạy.
  (db) => {
    db.run("ALTER TABLE timers ADD COLUMN action_id TEXT");
    db.run("ALTER TABLE timers ADD COLUMN cancel_requested TEXT");
    db.run(`CREATE TABLE timer_queued (
      key TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      step INTEGER NOT NULL,
      issue_id INTEGER,
      identifier TEXT,
      due_at INTEGER NOT NULL,
      payload TEXT,
      action_id TEXT,
      cancel_on TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX idx_timer_queued_issue ON timer_queued (issue_id)");
  },
];

/** Phiên bản schema mà code này hiểu (= số migration). */
export const BOT_STORE_SCHEMA_VERSION = MIGRATIONS.length;

/** Ném khi file kho do một phiên bản code mới hơn tạo ra. */
export class BotStoreVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `kho dữ liệu có schema v${found} mới hơn code này hiểu (v${supported}): cập nhật bot-core, đừng chạy bản cũ trên file này`,
    );
    this.name = "BotStoreVersionError";
  }
}

/** Tập khoá "đã làm rồi" (chống trùng). Đồng bộ vì `bun:sqlite` đồng bộ. */
export interface KeySet {
  has(key: string): boolean;
  add(key: string): void;
}

/**
 * Mở (và nhớ) một tập khoá có tên cho handler của bot (`ctx.keys("ten")`): chống trùng việc đã làm
 * (đã chuyển comment, đã nhắc quá hạn…). Bền qua restart khi bot có kho (`BOT_DATA_DIR`), không có
 * thì in-memory. Tên được cách ly với tập khoá nội bộ của bot kit. `ttlMs` mặc định 14 ngày.
 */
export type KeysProvider = (namespace: string, options?: { ttlMs?: number }) => KeySet;

/** Dựng {@link KeysProvider}: bền nếu có `store`, không thì in-memory (một tập cho mỗi tên). */
export function createKeysProvider(
  store: BotStore | null | undefined,
  now: () => number = Date.now,
): KeysProvider {
  const open = new Map<string, KeySet>();
  return (namespace, options = {}) => {
    let keys = open.get(namespace);
    if (!keys) {
      keys =
        store?.durable === true
          ? store.keys(`user:${namespace}`, { ttlMs: options.ttlMs, now })
          : new MemoryKeySet(10_000);
      open.set(namespace, keys);
    }
    return keys;
  };
}

/**
 * Kết quả `arm`: hẹn mới, hẹn lại (hẹn cũ đã xong/huỷ), giữ nguyên hẹn đang chờ, thay hẹn đang
 * chờ, hoặc `queued` (hẹn cũ ĐANG chạy: lần hẹn này được xếp hàng và tự thành hẹn mới khi lần chạy
 * kia kết thúc, không bị mất).
 */
export type TimerArmOutcome = "new" | "rearmed" | "kept" | "replaced" | "queued";

export type TimerState = "pending" | "firing" | "done" | "cancelled" | "failed";

/** Một hẹn giờ trong kho. */
export interface TimerRow {
  /** Khoá định danh, duy nhất trong bot. Cũng là khoá huỷ trực tiếp. */
  key: string;
  /** Số lần hẹn (tăng khi hẹn lại sau khi đã xong/huỷ); phần của khoá chống trùng khi chạy. */
  gen: number;
  /** Tên luật và vị trí hành động `after`/`closeAfter` trong luật đó. */
  rule: string;
  step: number;
  issueId: number | null;
  identifier: string | null;
  armedAt: number;
  dueAt: number;
  payload: unknown;
  state: TimerState;
  attempts: number;
  owner: string | null;
  leaseUntil: number;
  lastError: string | null;
  cancelOn: string[];
  /** Định danh hành động lúc hẹn (xem `TimerArmSpec.actionId`); `null` với hẹn cũ chưa ghi. */
  actionId: string | null;
  /** Lý do một yêu cầu huỷ tới khi hẹn đang chạy (hành động phải dừng trước khi ghi); `null` nếu không. */
  cancelRequested: string | null;
}

/** Thông tin để hẹn một timer (xem `RuleContext.timers`). */
export interface TimerArmSpec {
  key: string;
  rule: string;
  step: number;
  dueAt: number;
  issueId?: number | null;
  identifier?: string | null;
  cancelOn?: readonly string[];
  payload?: unknown;
  /**
   * Định danh ổn định của HÀNH ĐỘNG được hẹn (khác với vị trí `step`): bộ chạy bỏ qua hẹn nếu hành
   * động hiện tại ở (luật, bước) có định danh khác, tránh chạy nhầm hành động sau khi sửa luật.
   */
  actionId?: string;
  /** Hẹn lại đang chờ: `true` dời hẹn và thay payload; mặc định `false` (giữ hẹn cũ, nên webhook giao trùng không dời hạn). */
  replace?: boolean;
}

/** Kết quả một lần thử claim mốc cron. */
export type CronClaim = "claimed" | "already" | "busy";

export interface BotStoreOptions {
  /** Định danh instance (ghi vào lease). Mặc định UUID ngẫu nhiên mỗi lần mở. */
  instanceId?: string;
}

/** Hàng thô của bảng timers (tên cột snake_case). */
interface RawTimer {
  key: string;
  gen: number;
  rule: string;
  step: number;
  issue_id: number | null;
  identifier: string | null;
  armed_at: number;
  due_at: number;
  payload: string | null;
  state: TimerState;
  attempts: number;
  owner: string | null;
  lease_until: number;
  last_error: string | null;
  action_id: string | null;
  cancel_requested: string | null;
}

const DAY = 86_400_000;
/** Chu kỳ dọn ledger/khoá chống trùng cũ trong tiến trình sống lâu (ms). */
const PRUNE_EVERY_MS = 3_600_000;

const readVersion = (db: Database): number =>
  (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

function migrate(db: Database): void {
  const apply = db.transaction(() => {
    // Đọc LẠI trong transaction: hai process cùng nâng cấp một file thì chỉ một bên chạy migration.
    const current = readVersion(db);
    if (current > MIGRATIONS.length) throw new BotStoreVersionError(current, MIGRATIONS.length);
    for (let v = current; v < MIGRATIONS.length; v++) {
      MIGRATIONS[v](db);
      db.run(`PRAGMA user_version = ${v + 1}`);
    }
  });
  apply.immediate();
}

const isBusy = (err: unknown): boolean =>
  /database is locked|SQLITE_BUSY|SQLITE_LOCKED|database table is locked/i.test(
    err instanceof Error
      ? `${err.name} ${err.message} ${(err as { code?: string }).code ?? ""}`
      : String(err),
  );

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Thời gian tối đa thử lại khi file đang bị process khác khoá lúc mở (ms). */
const OPEN_RETRY_BUDGET_MS = 20_000;

function secureFiles(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      // best effort (vd hệ thống file không hỗ trợ chmod)
    }
  }
}

/**
 * Mở file kho: `busy_timeout` đặt TRƯỚC mọi thứ khác (kể cả chuyển WAL, vốn cần khoá độc quyền),
 * rồi bọc mở + WAL + migration trong vòng thử lại ngắn với backoff ngẫu nhiên: nhiều process khởi
 * động cùng lúc trên một file mới có thể gặp "database is locked" ngay cả khi có busy_timeout
 * (SQLite tránh deadlock bằng cách báo lỗi tức thì). Thư mục dữ liệu 0700, file kho 0600.
 */
function initDatabase(path: string, durable: boolean): Database {
  const { Database: Sqlite } = sqlite();
  if (durable) {
    const dir = dirname(path);
    const createdDir = !existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (createdDir) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best effort
      }
    }
    if (!existsSync(path)) {
      try {
        closeSync(openSync(path, "a", 0o600));
      } catch {
        // để SQLite tự tạo
      }
    }
  }
  const deadline = Date.now() + OPEN_RETRY_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    let db: Database | undefined;
    try {
      db = new Sqlite(path, { create: true });
      db.run("PRAGMA busy_timeout = 5000");
      if (durable) {
        db.run("PRAGMA journal_mode = WAL");
        db.run("PRAGMA synchronous = NORMAL");
      }
      migrate(db);
      if (durable) secureFiles(path);
      return db;
    } catch (err) {
      try {
        db?.close();
      } catch {
        // đã hỏng thì thôi
      }
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(500, 5 + Math.random() * 25 * (attempt + 1)));
    }
  }
}

/**
 * Kho bền của một bot. Mở bằng {@link BotStore.open} (file) hoặc {@link BotStore.memory}.
 * Đóng bằng `close()` khi bot dừng.
 */
export class BotStore {
  /** Định danh process này trong lease và claim timer. */
  readonly instanceId: string;
  /** `true` khi là file thật (sống qua restart); `false` với `:memory:`. */
  readonly durable: boolean;
  /** Đường dẫn file, hoặc `:memory:`. */
  readonly path: string;
  private readonly db: Database;
  private closed = false;

  private constructor(path: string, durable: boolean, options: BotStoreOptions) {
    this.path = path;
    this.durable = durable;
    this.instanceId = options.instanceId ?? randomUUID();
    this.db = initDatabase(path, durable);
  }

  /** Mở (tạo nếu chưa có) file kho, áp migration còn thiếu. Ném nếu file mới hơn code. */
  static open(path: string, options: BotStoreOptions = {}): BotStore {
    return new BotStore(resolve(path), true, options);
  }

  /** Kho trong bộ nhớ: cùng mã, không sống qua restart. Mặc định của test. */
  static memory(options: BotStoreOptions = {}): BotStore {
    return new BotStore(":memory:", false, options);
  }

  /** Phiên bản schema đang ở trong file. */
  schemaVersion(): number {
    return readVersion(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ── ledger run ─────────────────────────────────────────────────────────────

  /** `RunLedger` bền cho `AgentRunWorker`: kết quả đã tính xong nhưng chưa báo được. */
  ledger(options: { now?: () => number; retentionMs?: number } = {}): RunLedger {
    const now = options.now ?? Date.now;
    const retention = options.retentionMs ?? 14 * DAY;
    const prune = () => this.db.run("DELETE FROM run_ledger WHERE at < ?", [now() - retention]);
    prune();
    let lastPrune = now();
    return {
      get: (runId) => {
        const row = this.db.query("SELECT result FROM run_ledger WHERE run_id = ?").get(runId) as {
          result: string;
        } | null;
        return row ? (JSON.parse(row.result) as AgentRunResult) : undefined;
      },
      set: (runId, result) => {
        this.db.run("INSERT OR REPLACE INTO run_ledger (run_id, result, at) VALUES (?, ?, ?)", [
          runId,
          JSON.stringify(result),
          now(),
        ]);
        // Tiến trình sống lâu: dọn định kỳ, không chỉ lúc mở.
        if (now() - lastPrune > PRUNE_EVERY_MS) {
          lastPrune = now();
          prune();
        }
      },
      delete: (runId) => {
        this.db.run("DELETE FROM run_ledger WHERE run_id = ?", [runId]);
      },
    };
  }

  // ── khoá chống trùng ───────────────────────────────────────────────────────

  /**
   * Tập khoá có tên (`ns`), tự dọn khoá cũ hơn `ttlMs` (mặc định 14 ngày) lúc mở và định kỳ.
   * Dùng cho khoá comment (`agent-run:<id>:reply#n`) và sự kiện webhook mà luật đã xử lý.
   */
  keys(ns: string, options: { ttlMs?: number; now?: () => number } = {}): KeySet {
    const ttl = options.ttlMs ?? 14 * DAY;
    const now = options.now ?? Date.now;
    const prune = () =>
      this.db.run("DELETE FROM dedupe_keys WHERE ns = ? AND at < ?", [ns, now() - ttl]);
    prune();
    let adds = 0;
    let lastPrune = now();
    return {
      has: (key) =>
        this.db.query("SELECT 1 FROM dedupe_keys WHERE ns = ? AND key = ?").get(ns, key) !== null,
      add: (key) => {
        this.db.run("INSERT OR REPLACE INTO dedupe_keys (ns, key, at) VALUES (?, ?, ?)", [
          ns,
          key,
          now(),
        ]);
        if (++adds % 500 === 0 || now() - lastPrune > PRUNE_EVERY_MS) {
          lastPrune = now();
          prune();
        }
      },
    };
  }

  // ── lease ──────────────────────────────────────────────────────────────────

  /**
   * Giành (hoặc gia hạn) lease `name`. `true` nếu process này đang giữ nó sau lời gọi: lease
   * còn hạn của process khác thì `false`; hết hạn thì giành được.
   */
  acquireLease(name: string, ttlMs: number, now: number, owner = this.instanceId): boolean {
    const run = this.db.transaction(() => {
      const res = this.db
        .query(
          `INSERT INTO leases (name, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE leases.owner = excluded.owner OR leases.expires_at <= ?`,
        )
        .run(name, owner, now + ttlMs, now);
      return res.changes > 0;
    });
    return run.immediate();
  }

  /** Nhả lease nếu đang là của `owner`. */
  releaseLease(name: string, owner = this.instanceId): void {
    this.db.run("DELETE FROM leases WHERE name = ? AND owner = ?", [name, owner]);
  }

  /** Chủ và hạn của lease (cho health/test); `null` nếu không có. */
  leaseInfo(name: string): { owner: string; expiresAt: number } | null {
    const row = this.db.query("SELECT owner, expires_at FROM leases WHERE name = ?").get(name) as {
      owner: string;
      expires_at: number;
    } | null;
    return row ? { owner: row.owner, expiresAt: row.expires_at } : null;
  }

  // ── cron ───────────────────────────────────────────────────────────────────

  /**
   * Đăng ký một lịch lần đầu: ghi mốc `baselineMs` (thường là giờ hiện tại) nếu CHƯA có.
   * Chỉ các mốc SAU baseline mới được chạy, nên thêm lịch mới không "bù" quá khứ.
   * Trả mốc gần nhất đã xử lý.
   */
  registerCron(job: string, baselineMs: number): number {
    this.db.run(
      "INSERT OR IGNORE INTO cron_jobs (job, last_slot, last_status, updated_at) VALUES (?, ?, 'registered', ?)",
      [job, baselineMs, baselineMs],
    );
    return this.cronLastSlot(job) ?? baselineMs;
  }

  cronLastSlot(job: string): number | null {
    const row = this.db.query("SELECT last_slot FROM cron_jobs WHERE job = ?").get(job) as {
      last_slot: number;
    } | null;
    return row ? row.last_slot : null;
  }

  /**
   * Chiếm mốc `slot` của lịch `job` một cách nguyên tử: chỉ MỘT process thắng cho mỗi mốc.
   *  - `"claimed"`: process này được chạy (hoặc ghi nhận bỏ qua nếu `run` là `false`);
   *  - `"already"`: mốc này (hoặc mốc sau) đã được xử lý rồi;
   *  - `"busy"`: process KHÁC đang giữ lease của lịch (lượt trước còn chạy): chưa quyết định gì,
   *    lần tick sau xét lại.
   * Chiếm TRƯỚC khi chạy nên mỗi mốc chạy tối đa một lần (at-most-once): handler sập giữa chừng
   * thì mốc đó không chạy lại.
   */
  claimCronSlot(args: {
    job: string;
    slot: number;
    now: number;
    leaseMs: number;
    /** `false`: chỉ ghi nhận đã bỏ qua mốc (chính sách `skip`), không lấy lease. */
    run: boolean;
    owner?: string;
  }): CronClaim {
    const owner = args.owner ?? this.instanceId;
    const txn = this.db.transaction((): CronClaim => {
      const last = this.cronLastSlot(args.job);
      if (last !== null && last >= args.slot) return "already";
      const lease = this.db
        .query("SELECT owner, expires_at FROM leases WHERE name = ?")
        .get(`cron:${args.job}`) as { owner: string; expires_at: number } | null;
      if (lease && lease.owner !== owner && lease.expires_at > args.now) return "busy";
      this.db.run(
        `INSERT INTO cron_jobs (job, last_slot, last_status, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET last_slot = excluded.last_slot, last_status = excluded.last_status, updated_at = excluded.updated_at`,
        [args.job, args.slot, args.run ? "running" : "skipped", args.now],
      );
      if (args.run) {
        this.db.run(
          `INSERT INTO leases (name, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
          [`cron:${args.job}`, owner, args.now + args.leaseMs],
        );
      }
      return "claimed";
    });
    return txn.immediate();
  }

  /** Ghi kết quả lần chạy và nhả lease của lịch. */
  finishCron(job: string, status: "done" | "failed", now: number, owner = this.instanceId): void {
    this.db.run("UPDATE cron_jobs SET last_status = ?, updated_at = ? WHERE job = ?", [
      status,
      now,
      job,
    ]);
    this.releaseLease(`cron:${job}`, owner);
  }

  /**
   * Xoá mốc và lease của các lịch KHÔNG còn trong `keepJobs` (lịch bị gỡ khỏi khai báo, hoặc đổi
   * múi giờ nên id đổi), để bảng không tích rác và lịch được thêm lại bắt đầu từ baseline mới.
   */
  pruneCronJobs(keepJobs: readonly string[]): number {
    const txn = this.db.transaction((): number => {
      const keep = new Set(keepJobs);
      const rows = this.db.query("SELECT job FROM cron_jobs").all() as { job: string }[];
      let removed = 0;
      for (const { job } of rows) {
        if (keep.has(job)) continue;
        this.db.run("DELETE FROM cron_jobs WHERE job = ?", [job]);
        this.db.run("DELETE FROM leases WHERE name = ?", [`cron:${job}`]);
        removed++;
      }
      return removed;
    });
    return txn.immediate();
  }

  cronStatus(job: string): { lastSlot: number; status: string | null } | null {
    const row = this.db
      .query("SELECT last_slot, last_status FROM cron_jobs WHERE job = ?")
      .get(job) as {
      last_slot: number;
      last_status: string | null;
    } | null;
    return row ? { lastSlot: row.last_slot, status: row.last_status } : null;
  }

  // ── hẹn giờ ────────────────────────────────────────────────────────────────

  private toRow(raw: RawTimer): TimerRow {
    const cancelOn = (
      this.db
        .query("SELECT token FROM timer_cancel_on WHERE key = ? ORDER BY token")
        .all(raw.key) as {
        token: string;
      }[]
    ).map((r) => r.token);
    let payload: unknown = null;
    try {
      payload = raw.payload === null ? null : JSON.parse(raw.payload);
    } catch {
      payload = null;
    }
    return {
      key: raw.key,
      gen: raw.gen,
      rule: raw.rule,
      step: raw.step,
      issueId: raw.issue_id,
      identifier: raw.identifier,
      armedAt: raw.armed_at,
      dueAt: raw.due_at,
      payload,
      state: raw.state,
      attempts: raw.attempts,
      owner: raw.owner,
      leaseUntil: raw.lease_until,
      lastError: raw.last_error,
      cancelOn,
      actionId: raw.action_id,
      cancelRequested: raw.cancel_requested,
    };
  }

  private setCancelOn(key: string, tokens: Iterable<string>): void {
    this.db.run("DELETE FROM timer_cancel_on WHERE key = ?", [key]);
    for (const token of new Set(tokens)) {
      this.db.run("INSERT INTO timer_cancel_on (key, token) VALUES (?, ?)", [key, token]);
    }
  }

  /** Ghi đè hàng `key` bằng một lần hẹn MỚI (gen + 1 nếu đã có). Gọi trong transaction. */
  private writeArmed(
    key: string,
    gen: number,
    spec: {
      rule: string;
      step: number;
      issueId: number | null;
      identifier: string | null;
      armedAt: number;
      dueAt: number;
      payload: string | null;
      actionId: string | null;
      cancelOn: Iterable<string>;
    },
    insert: boolean,
  ): void {
    if (insert) {
      this.db.run(
        `INSERT INTO timers (key, gen, rule, step, issue_id, identifier, armed_at, due_at, payload, state, updated_at, action_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          key,
          gen,
          spec.rule,
          spec.step,
          spec.issueId,
          spec.identifier,
          spec.armedAt,
          spec.dueAt,
          spec.payload,
          spec.armedAt,
          spec.actionId,
        ],
      );
    } else {
      this.db.run(
        `UPDATE timers SET gen = ?, rule = ?, step = ?, issue_id = ?, identifier = ?, armed_at = ?, due_at = ?,
           payload = ?, state = 'pending', attempts = 0, owner = NULL, lease_until = 0, last_error = NULL,
           cancel_requested = NULL, action_id = ?, updated_at = ?
         WHERE key = ?`,
        [
          gen,
          spec.rule,
          spec.step,
          spec.issueId,
          spec.identifier,
          spec.armedAt,
          spec.dueAt,
          spec.payload,
          spec.actionId,
          spec.armedAt,
          key,
        ],
      );
    }
    this.setCancelOn(key, spec.cancelOn);
  }

  /**
   * Hẹn một timer theo `spec.key`:
   *  - chưa có → `"new"`;
   *  - đang `pending` → `"kept"` (hoặc `"replaced"` nếu `replace`);
   *  - đang `firing` → `"queued"`: lần hẹn này được xếp hàng, tự thành hẹn mới (gen + 1) khi lần
   *    chạy hiện tại kết thúc, nên không bị mất;
   *  - đã `done`/`cancelled`/`failed` → `"rearmed"` (tăng `gen`, nên khoá chống trùng của lần chạy mới khác lần trước).
   */
  armTimer(spec: TimerArmSpec, now: number): { outcome: TimerArmOutcome; gen: number } {
    const txn = this.db.transaction((): { outcome: TimerArmOutcome; gen: number } => {
      const payload = spec.payload === undefined ? null : JSON.stringify(spec.payload);
      const full = {
        rule: spec.rule,
        step: spec.step,
        issueId: spec.issueId ?? null,
        identifier: spec.identifier ?? null,
        armedAt: now,
        dueAt: spec.dueAt,
        payload,
        actionId: spec.actionId ?? null,
        cancelOn: spec.cancelOn ?? [],
      };
      const existing = this.db
        .query("SELECT * FROM timers WHERE key = ?")
        .get(spec.key) as RawTimer | null;
      if (!existing) {
        this.writeArmed(spec.key, 1, full, true);
        return { outcome: "new", gen: 1 };
      }
      if (existing.state === "pending") {
        if (spec.replace) {
          this.db.run(
            "UPDATE timers SET armed_at = ?, due_at = ?, payload = ?, rule = ?, step = ?, issue_id = ?, identifier = ?, action_id = ?, updated_at = ? WHERE key = ?",
            [
              now,
              spec.dueAt,
              payload,
              spec.rule,
              spec.step,
              full.issueId,
              full.identifier,
              full.actionId,
              now,
              spec.key,
            ],
          );
          this.setCancelOn(spec.key, full.cancelOn);
          return { outcome: "replaced", gen: existing.gen };
        }
        return { outcome: "kept", gen: existing.gen };
      }
      if (existing.state === "firing") {
        this.db.run(
          `INSERT OR REPLACE INTO timer_queued (key, rule, step, issue_id, identifier, due_at, payload, action_id, cancel_on, queued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            spec.key,
            spec.rule,
            spec.step,
            full.issueId,
            full.identifier,
            spec.dueAt,
            payload,
            full.actionId,
            JSON.stringify([...new Set(full.cancelOn)]),
            now,
          ],
        );
        return { outcome: "queued", gen: existing.gen };
      }
      const gen = existing.gen + 1;
      this.writeArmed(spec.key, gen, full, false);
      return { outcome: "rearmed", gen };
    });
    return txn.immediate();
  }

  /** Nếu có hẹn xếp hàng cho `key` (hẹn lại lúc đang chạy), biến nó thành hẹn mới. Gọi trong transaction. */
  private applyQueued(key: string): boolean {
    const q = this.db.query("SELECT * FROM timer_queued WHERE key = ?").get(key) as {
      rule: string;
      step: number;
      issue_id: number | null;
      identifier: string | null;
      due_at: number;
      payload: string | null;
      action_id: string | null;
      cancel_on: string;
      queued_at: number;
    } | null;
    if (!q) return false;
    this.db.run("DELETE FROM timer_queued WHERE key = ?", [key]);
    const cur = this.db.query("SELECT gen FROM timers WHERE key = ?").get(key) as {
      gen: number;
    } | null;
    if (!cur) return false;
    this.writeArmed(
      key,
      cur.gen + 1,
      {
        rule: q.rule,
        step: q.step,
        issueId: q.issue_id,
        identifier: q.identifier,
        armedAt: q.queued_at,
        dueAt: q.due_at,
        payload: q.payload,
        actionId: q.action_id,
        cancelOn: JSON.parse(q.cancel_on) as string[],
      },
      false,
    );
    return true;
  }

  getTimer(key: string): TimerRow | null {
    const raw = this.db.query("SELECT * FROM timers WHERE key = ?").get(key) as RawTimer | null;
    return raw ? this.toRow(raw) : null;
  }

  /** Liệt kê timer (cho health/test/vận hành), mới hẹn trước. */
  listTimers(filter: { state?: TimerState; issueId?: number } = {}): TimerRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.state) {
      where.push("state = ?");
      args.push(filter.state);
    }
    if (filter.issueId !== undefined) {
      where.push("issue_id = ?");
      args.push(filter.issueId);
    }
    const sql = `SELECT * FROM timers ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY due_at, key`;
    return (this.db.query(sql).all(...args) as RawTimer[]).map((r) => this.toRow(r));
  }

  /** Số timer ở một trạng thái; `updatedSince` chỉ đếm timer cập nhật từ mốc đó (vd `failed` gần đây). */
  countTimers(state: TimerState, updatedSince?: number): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM timers WHERE state = ? AND updated_at >= ?")
        .get(state, updatedSince ?? 0) as { n: number }
    ).n;
  }

  /**
   * Huỷ timer theo khoá: `pending` thì huỷ ngay; `firing` thì chỉ ĐÁNH DẤU yêu cầu huỷ (hành động
   * đang chạy phải kiểm trước khi ghi, xem `timerBlocked`); hẹn xếp hàng của khoá cũng bị bỏ.
   * `true` nếu có gì bị huỷ hoặc đánh dấu.
   */
  cancelTimer(key: string, reason: string, now: number): boolean {
    const txn = this.db.transaction((): boolean => {
      this.db.run("DELETE FROM timer_queued WHERE key = ?", [key]);
      const a = this.db.run(
        "UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ? WHERE key = ? AND state = 'pending'",
        [reason, now, key],
      ).changes;
      const b = this.db.run(
        "UPDATE timers SET cancel_requested = COALESCE(cancel_requested, ?), updated_at = ? WHERE key = ? AND state = 'firing'",
        [reason, now, key],
      ).changes;
      return a + b > 0;
    });
    return txn.immediate();
  }

  /**
   * Huỷ mọi timer của issue có khai `token` trong `cancelOn`: `pending` huỷ ngay, `firing` đánh dấu
   * yêu cầu huỷ, hẹn xếp hàng có token đó bị bỏ. Trả số timer bị huỷ hoặc đánh dấu.
   */
  cancelByToken(issueId: number, token: string, reason: string, now: number): number {
    const txn = this.db.transaction((): number => {
      this.db.run(
        `DELETE FROM timer_queued WHERE issue_id = ?
           AND EXISTS (SELECT 1 FROM json_each(timer_queued.cancel_on) WHERE value = ?)`,
        [issueId, token],
      );
      const a = this.db.run(
        `UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ?
         WHERE issue_id = ? AND state = 'pending'
           AND key IN (SELECT key FROM timer_cancel_on WHERE token = ?)`,
        [reason, now, issueId, token],
      ).changes;
      const b = this.db.run(
        `UPDATE timers SET cancel_requested = COALESCE(cancel_requested, ?), updated_at = ?
         WHERE issue_id = ? AND state = 'firing'
           AND key IN (SELECT key FROM timer_cancel_on WHERE token = ?)`,
        [reason, now, issueId, token],
      ).changes;
      return a + b;
    });
    return txn.immediate();
  }

  /** Huỷ (hoặc đánh dấu huỷ, nếu đang chạy) MỌI timer của issue (issue bị xoá). */
  cancelAllForIssue(issueId: number, reason: string, now: number): number {
    const txn = this.db.transaction((): number => {
      this.db.run("DELETE FROM timer_queued WHERE issue_id = ?", [issueId]);
      const a = this.db.run(
        "UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ? WHERE issue_id = ? AND state = 'pending'",
        [reason, now, issueId],
      ).changes;
      const b = this.db.run(
        "UPDATE timers SET cancel_requested = COALESCE(cancel_requested, ?), updated_at = ? WHERE issue_id = ? AND state = 'firing'",
        [reason, now, issueId],
      ).changes;
      return a + b;
    });
    return txn.immediate();
  }

  /**
   * Lần chạy `(key, gen)` của `owner` còn được phép ghi không? Trả `null` nếu còn; ngược lại trả
   * lý do phải dừng: có yêu cầu huỷ, hoặc hẹn không còn đang chạy ở process này (lease đã bị
   * process khác tiếp quản, đã bị huỷ hoặc hẹn lại). Hành động hẹn giờ gọi trước MỖI thao tác ghi.
   */
  timerBlocked(key: string, gen: number, owner = this.instanceId): string | null {
    const row = this.db
      .query("SELECT state, gen, owner, cancel_requested FROM timers WHERE key = ?")
      .get(key) as {
      state: string;
      gen: number;
      owner: string | null;
      cancel_requested: string | null;
    } | null;
    if (!row || row.gen !== gen) return "hẹn đã bị thay hoặc xoá";
    if (row.state !== "firing" || row.owner !== owner) {
      return `hẹn không còn đang chạy ở process này (${row.state})`;
    }
    return row.cancel_requested;
  }

  /** Timer đến hạn: `pending` quá hạn, hoặc `firing` mà lease của process đang chạy nó đã hết (process đó sập). */
  dueTimers(now: number, limit = 20): TimerRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM timers
         WHERE (state = 'pending' AND due_at <= ?1) OR (state = 'firing' AND lease_until <= ?1)
         ORDER BY due_at LIMIT ?2`,
      )
      .all(now, limit) as RawTimer[];
    return rows.map((r) => this.toRow(r));
  }

  /** Giành quyền chạy một timer (CAS): chỉ một process thắng. Tăng `attempts`. */
  claimTimer(
    key: string,
    gen: number,
    now: number,
    leaseMs: number,
    owner = this.instanceId,
  ): boolean {
    return (
      this.db.run(
        `UPDATE timers SET state = 'firing', owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE key = ? AND gen = ?
           AND ((state = 'pending' AND due_at <= ?) OR (state = 'firing' AND lease_until <= ?))`,
        [owner, now + leaseMs, now, key, gen, now, now],
      ).changes > 0
    );
  }

  /** Gia hạn lease của timer đang chạy. */
  renewTimer(
    key: string,
    gen: number,
    now: number,
    leaseMs: number,
    owner = this.instanceId,
  ): boolean {
    return (
      this.db.run(
        "UPDATE timers SET lease_until = ?, updated_at = ? WHERE key = ? AND gen = ? AND owner = ? AND state = 'firing'",
        [now + leaseMs, now, key, gen, owner],
      ).changes > 0
    );
  }

  /**
   * Kết thúc timer đang chạy (`done`, hoặc `cancelled` khi điều kiện không còn). Nếu trong lúc
   * chạy có lần hẹn lại (xếp hàng), nó trở thành hẹn mới ngay trong cùng transaction.
   */
  finishTimer(
    key: string,
    gen: number,
    state: "done" | "cancelled",
    note: string | null,
    now: number,
    owner = this.instanceId,
  ): boolean {
    const txn = this.db.transaction((): boolean => {
      const changed =
        this.db.run(
          "UPDATE timers SET state = ?, last_error = ?, updated_at = ? WHERE key = ? AND gen = ? AND owner = ? AND state = 'firing'",
          [state, note, now, key, gen, owner],
        ).changes > 0;
      if (changed) this.applyQueued(key);
      return changed;
    });
    return txn.immediate();
  }

  /**
   * Báo lỗi một lần chạy: `retryAt` đặt thì hẹn lại lúc đó, không thì đánh `failed` (và áp hẹn
   * xếp hàng nếu có). Nếu có yêu cầu huỷ đang chờ thì huỷ luôn thay vì thử lại.
   */
  failTimer(
    key: string,
    gen: number,
    error: string,
    retryAt: number | null,
    now: number,
    owner = this.instanceId,
  ): boolean {
    const txn = this.db.transaction((): boolean => {
      const row = this.db
        .query(
          "SELECT cancel_requested FROM timers WHERE key = ? AND gen = ? AND owner = ? AND state = 'firing'",
        )
        .get(key, gen, owner) as { cancel_requested: string | null } | null;
      if (!row) return false;
      if (retryAt !== null && row.cancel_requested !== null) {
        this.db.run(
          "UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ? WHERE key = ?",
          [row.cancel_requested, now, key],
        );
        this.applyQueued(key);
        return true;
      }
      this.db.run(
        `UPDATE timers SET state = ?, due_at = COALESCE(?, due_at), last_error = ?, updated_at = ?
         WHERE key = ? AND gen = ?`,
        [retryAt === null ? "failed" : "pending", retryAt, error.slice(0, 500), now, key, gen],
      );
      if (retryAt === null) this.applyQueued(key);
      return true;
    });
    return txn.immediate();
  }

  /**
   * Trả timer về `pending` mà KHÔNG tính là một lần thử (bot đang tắt nên lần chạy bị huỷ):
   * hoàn lại lượt `attempts` đã cộng lúc claim, giữ nguyên hạn.
   */
  releaseTimer(
    key: string,
    gen: number,
    note: string,
    now: number,
    owner = this.instanceId,
  ): boolean {
    return (
      this.db.run(
        `UPDATE timers SET state = 'pending', attempts = MAX(attempts - 1, 0), owner = NULL, lease_until = 0,
           last_error = ?, updated_at = ?
         WHERE key = ? AND gen = ? AND owner = ? AND state = 'firing'`,
        [note, now, key, gen, owner],
      ).changes > 0
    );
  }

  /** Dọn timer đã kết thúc (`done`/`cancelled`/`failed`) cũ hơn `olderThanMs`. Trả số dòng xoá. */
  purgeTimers(olderThanMs: number, now: number): number {
    this.db.run(
      "DELETE FROM timer_cancel_on WHERE key IN (SELECT key FROM timers WHERE state IN ('done','cancelled','failed') AND updated_at < ?)",
      [now - olderThanMs],
    );
    return this.db.run(
      "DELETE FROM timers WHERE state IN ('done','cancelled','failed') AND updated_at < ?",
      [now - olderThanMs],
    ).changes;
  }
}

/** Tập khoá in-memory có chặn kích thước (dùng khi không có kho bền). */
export class MemoryKeySet implements KeySet {
  private readonly keys = new Set<string>();
  constructor(private readonly max = 2000) {}
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.add(key);
    if (this.keys.size > this.max) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
  }
}
