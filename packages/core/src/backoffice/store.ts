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
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentRunResult, RunLedger } from "../itsaplan";

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

/** Kết quả `arm`: hẹn mới, hẹn lại (hẹn cũ đã xong/huỷ), giữ nguyên hẹn đang chờ, hoặc thay hẹn đang chờ. */
export type TimerArmOutcome = "new" | "rearmed" | "kept" | "replaced";

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
}

const DAY = 86_400_000;

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
    if (durable) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    try {
      if (durable) {
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA synchronous = NORMAL");
      }
      this.db.run("PRAGMA busy_timeout = 5000");
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
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
    return (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  private migrate(): void {
    const apply = this.db.transaction(() => {
      // Đọc LẠI trong transaction: hai process cùng nâng cấp một file thì chỉ một bên chạy migration.
      const current = this.schemaVersion();
      if (current > MIGRATIONS.length) throw new BotStoreVersionError(current, MIGRATIONS.length);
      for (let v = current; v < MIGRATIONS.length; v++) {
        MIGRATIONS[v](this.db);
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      }
    });
    apply.immediate();
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
    this.db.run("DELETE FROM run_ledger WHERE at < ?", [now() - (options.retentionMs ?? 14 * DAY)]);
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
    return {
      has: (key) =>
        this.db.query("SELECT 1 FROM dedupe_keys WHERE ns = ? AND key = ?").get(ns, key) !== null,
      add: (key) => {
        this.db.run("INSERT OR REPLACE INTO dedupe_keys (ns, key, at) VALUES (?, ?, ?)", [
          ns,
          key,
          now(),
        ]);
        if (++adds % 500 === 0) prune();
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
    };
  }

  /**
   * Hẹn một timer theo `spec.key`:
   *  - chưa có → `"new"`;
   *  - đã có và đang `pending`/`firing` → `"kept"` (hoặc `"replaced"` nếu `replace` và còn `pending`);
   *  - đã `done`/`cancelled`/`failed` → `"rearmed"` (tăng `gen`, nên khoá chống trùng của lần chạy mới khác lần trước).
   */
  armTimer(spec: TimerArmSpec, now: number): { outcome: TimerArmOutcome; gen: number } {
    const txn = this.db.transaction((): { outcome: TimerArmOutcome; gen: number } => {
      const payload = spec.payload === undefined ? null : JSON.stringify(spec.payload);
      const existing = this.db
        .query("SELECT * FROM timers WHERE key = ?")
        .get(spec.key) as RawTimer | null;
      let outcome: TimerArmOutcome;
      let gen = 1;
      const setCancel = () => {
        this.db.run("DELETE FROM timer_cancel_on WHERE key = ?", [spec.key]);
        for (const token of new Set(spec.cancelOn ?? [])) {
          this.db.run("INSERT INTO timer_cancel_on (key, token) VALUES (?, ?)", [spec.key, token]);
        }
      };
      if (!existing) {
        this.db.run(
          `INSERT INTO timers (key, gen, rule, step, issue_id, identifier, armed_at, due_at, payload, state, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            spec.key,
            spec.rule,
            spec.step,
            spec.issueId ?? null,
            spec.identifier ?? null,
            now,
            spec.dueAt,
            payload,
            now,
          ],
        );
        setCancel();
        outcome = "new";
      } else if (existing.state === "pending" || existing.state === "firing") {
        gen = existing.gen;
        if (spec.replace && existing.state === "pending") {
          this.db.run(
            "UPDATE timers SET armed_at = ?, due_at = ?, payload = ?, rule = ?, step = ?, issue_id = ?, identifier = ?, updated_at = ? WHERE key = ?",
            [
              now,
              spec.dueAt,
              payload,
              spec.rule,
              spec.step,
              spec.issueId ?? null,
              spec.identifier ?? null,
              now,
              spec.key,
            ],
          );
          setCancel();
          outcome = "replaced";
        } else {
          outcome = "kept";
        }
      } else {
        gen = existing.gen + 1;
        this.db.run(
          `UPDATE timers SET gen = ?, rule = ?, step = ?, issue_id = ?, identifier = ?, armed_at = ?, due_at = ?,
             payload = ?, state = 'pending', attempts = 0, owner = NULL, lease_until = 0, last_error = NULL, updated_at = ?
           WHERE key = ?`,
          [
            gen,
            spec.rule,
            spec.step,
            spec.issueId ?? null,
            spec.identifier ?? null,
            now,
            spec.dueAt,
            payload,
            now,
            spec.key,
          ],
        );
        setCancel();
        outcome = "rearmed";
      }
      return { outcome, gen };
    });
    return txn.immediate();
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

  countTimers(state: TimerState): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM timers WHERE state = ?").get(state) as { n: number }
    ).n;
  }

  /** Huỷ timer `pending` theo khoá. `true` nếu có timer bị huỷ. */
  cancelTimer(key: string, reason: string, now: number): boolean {
    return (
      this.db.run(
        "UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ? WHERE key = ? AND state = 'pending'",
        [reason, now, key],
      ).changes > 0
    );
  }

  /** Huỷ mọi timer `pending` của issue có khai `token` trong `cancelOn`. Trả số timer đã huỷ. */
  cancelByToken(issueId: number, token: string, reason: string, now: number): number {
    return this.db.run(
      `UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ?
       WHERE issue_id = ? AND state = 'pending'
         AND key IN (SELECT key FROM timer_cancel_on WHERE token = ?)`,
      [reason, now, issueId, token],
    ).changes;
  }

  /** Huỷ MỌI timer `pending` của issue (issue bị xoá). */
  cancelAllForIssue(issueId: number, reason: string, now: number): number {
    return this.db.run(
      "UPDATE timers SET state = 'cancelled', last_error = ?, updated_at = ? WHERE issue_id = ? AND state = 'pending'",
      [reason, now, issueId],
    ).changes;
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

  /** Kết thúc timer đang chạy (`done`, hoặc `cancelled` khi điều kiện không còn). */
  finishTimer(
    key: string,
    gen: number,
    state: "done" | "cancelled",
    note: string | null,
    now: number,
    owner = this.instanceId,
  ): boolean {
    return (
      this.db.run(
        "UPDATE timers SET state = ?, last_error = ?, updated_at = ? WHERE key = ? AND gen = ? AND owner = ? AND state = 'firing'",
        [state, note, now, key, gen, owner],
      ).changes > 0
    );
  }

  /** Báo lỗi một lần chạy: `retryAt` đặt thì hẹn lại lúc đó, không thì đánh `failed`. */
  failTimer(
    key: string,
    gen: number,
    error: string,
    retryAt: number | null,
    now: number,
    owner = this.instanceId,
  ): boolean {
    return (
      this.db.run(
        `UPDATE timers SET state = ?, due_at = COALESCE(?, due_at), last_error = ?, updated_at = ?
         WHERE key = ? AND gen = ? AND owner = ? AND state = 'firing'`,
        [
          retryAt === null ? "failed" : "pending",
          retryAt,
          error.slice(0, 500),
          now,
          key,
          gen,
          owner,
        ],
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
