/**
 * Mở một kết nối SQLite lười, cache theo đường dẫn, (tuỳ chọn) áp schema.
 *
 * Trước đây mỗi repo tự viết lại đúng đoạn này (mkdir thư mục cha, mở DB, áp
 * schema) — và mở nhiều kết nối riêng tới cùng một file. Gom về đây thì các repo
 * dùng chung `dbPath` chia sẻ đúng một kết nối.
 *
 * NGUỒN: intake `lib/storage/lazy-db.ts`. KHÁC bản gốc một điểm có chủ đích:
 * bản intake import cứng `applySchema` từ `./schema` (schema riêng của intake).
 * Lõi không được biết schema của bot nào, nên `applySchema` trở thành THAM SỐ
 * tiêm vào — bot truyền hàm áp schema của mình; không truyền thì chỉ mở DB trần.
 *
 * ADR-0003: SQLite cục bộ là cache phụ, Itsaplan mới là nguồn sự thật. Vì vậy
 * mở DB LỖI (file hỏng, khoá, đĩa đầy, schema cũ không áp được) KHÔNG được làm
 * chết bot: ta log rồi hạ xuống một DB `:memory:` rỗng — bot chạy tiếp coi như
 * "chưa biết gì, hỏi lại", đúng điểm 3 của ADR. DB hạ cấp mang cờ qua
 * `isDegradedDb(db)` để chỗ nào cần biết thì biết; cache theo path vẫn giữ, nên
 * một lần hạ cấp không thử mở lại file hỏng mỗi lần gọi.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "./logger";
import { memoByKey } from "./memo";

/** Hàm áp schema do bot cung cấp. `wal` false khi DB in-memory. */
export type ApplySchema = (db: Database, opts: { wal: boolean }) => void;

export interface LazyDbOptions {
  /** Áp schema của bot ngay sau khi mở. Không truyền thì mở DB trần. */
  applySchema?: ApplySchema;
  /**
   * Việc cần làm khi mở/áp schema file thật lỗi:
   *  - `"degrade"` (mặc định, ADR-0003): log rồi hạ xuống `:memory:` rỗng — bot chạy
   *    tiếp coi như "chưa biết gì, hỏi lại";
   *  - `"throw"`: ném lỗi cho caller. Dùng khi caller tự có đường lùi (vd trả
   *    `undefined` và bỏ tính năng) và một DB trống giả sẽ che mất lỗi cấu hình.
   *    NGUỒN: Tiểu Linh (lookup ask-learning dựa vào ngoại lệ này).
   */
  onOpenError?: "degrade" | "throw";
}

/** Đánh dấu các kết nối đã bị hạ xuống `:memory:` vì không mở được file thật. */
const degraded = new WeakSet<Database>();

/**
 * DB này có phải bản hạ cấp (`:memory:`) do mở file thật thất bại không?
 * Dùng khi một điểm đọc muốn biết "cache có đáng tin cho lần ghi bền không".
 * Luồng đọc bình thường KHÔNG cần gọi — bảng rỗng tự nhiên dẫn tới nhánh hỏi lại.
 */
export function isDegradedDb(db: Database): boolean {
  return degraded.has(db);
}

/**
 * Chuẩn hoá đường dẫn file SQLite về TUYỆT ĐỐI, và cảnh báo khi nhận path tương
 * đối. Lý do (bug OP 16/10): worker đọc `INTAKE_DB_PATH=data/op.db` (tương đối)
 * nên file được resolve theo CWD của tiến trình — luồng tạo ticket chạy ở CWD
 * này, worker lại chạy ở CWD khác, thành ra hai bên ghi/đọc HAI file `op.db`
 * khác nhau: worker đọc một DB rỗng không có binding và nuốt mọi comment lặng
 * lẽ. Một path tuyệt đối thì mọi tiến trình trỏ cùng một file, dù CWD nào.
 *
 * `:memory:` và URI (`file:…`) được giữ nguyên. `base` mặc định `process.cwd()`.
 */
export function resolveDbPath(dbPath: string, base: string = process.cwd()): string {
  if (dbPath === ":memory:" || dbPath.includes("mode=memory") || dbPath.startsWith("file:")) {
    return dbPath;
  }
  if (path.isAbsolute(dbPath)) return dbPath;
  const abs = path.resolve(base, dbPath);
  getLogger().warn(
    `[lazy-db] DB path tương đối "${dbPath}" → resolve theo CWD thành "${abs}". ` +
      `CWD khác nhau giữa các tiến trình sẽ trỏ nhầm file (binding không khớp). ` +
      `Nên truyền đường dẫn TUYỆT ĐỐI.`,
  );
  return abs;
}

/**
 * Trả về một factory mở DB lười, cache theo `dbPath`. Mỗi `applySchema` khác
 * nhau là một factory riêng; trong một factory, cùng `dbPath` dùng chung một
 * kết nối. Mở/áp-schema lỗi thì hạ xuống `:memory:` (log, không ném).
 */
export function makeOpenLazyDb(options: LazyDbOptions = {}): (dbPath: string) => Database {
  return memoByKey<string, Database>(
    (dbPath) => dbPath,
    (dbPath) => {
      // Mở DB `:memory:` rỗng đã áp schema — dùng cho cả nhánh hạ cấp.
      const openMemory = (): Database => {
        const mem = new Database(":memory:", { create: true });
        try {
          options.applySchema?.(mem, { wal: false });
        } catch {
          // schema không áp được ngay cả trên bộ nhớ: trả DB trần, còn hơn ném.
        }
        degraded.add(mem);
        return mem;
      };

      if (dbPath === ":memory:") {
        const mem = new Database(":memory:", { create: true });
        options.applySchema?.(mem, { wal: false }); // in-memory do bot chủ động: lỗi schema cứ ném
        return mem;
      }

      try {
        fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
        const db = new Database(dbPath, { create: true });
        options.applySchema?.(db, { wal: true });
        return db;
      } catch (err) {
        if (options.onOpenError === "throw") throw err;
        // ADR-0003 điểm 3: file hỏng/khoá/đĩa đầy không được làm chết bot.
        getLogger().warn?.(
          `lazy-db: không mở được "${dbPath}" (${err instanceof Error ? err.message : String(err)}); ` +
            `hạ xuống SQLite :memory: — coi như cache rỗng, bot sẽ hỏi lại.`,
        );
        return openMemory();
      }
    },
  );
}

/**
 * Mở (tạo nếu chưa có) một file SQLite dữ liệu của bot với quyền RIÊNG TƯ: thư mục cha mode 0700
 * khi mới tạo, file cùng `-wal`/`-shm` mode 0600, WAL và `busy_timeout` 5 giây. `applySchema` áp
 * ngay sau khi mở. Khác `makeOpenLazyDb`: lỗi mở NÉM ra thay vì hạ xuống `:memory:` — dùng khi mất
 * file nghĩa là mất thứ không dựng lại được (liên kết người báo, dấu "đã báo"), nên phải dừng to.
 * Không cache: người gọi giữ và đóng kết nối. `:memory:` được giữ nguyên (cho test).
 */
export function openPrivateDb(dbPath: string, applySchema?: ApplySchema): Database {
  if (dbPath === ":memory:") {
    const mem = new Database(":memory:", { create: true });
    applySchema?.(mem, { wal: false });
    return mem;
  }
  const file = path.resolve(dbPath);
  const dir = path.dirname(file);
  const createdDir = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (createdDir) fs.chmodSync(dir, 0o700);
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
  const db = new Database(file, { create: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    applySchema?.(db, { wal: true });
    db.run("PRAGMA journal_mode = WAL");
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Factory mặc định (không áp schema) — dùng ngay khi bot tự chạy migration ở
 * nơi khác. Bot cần áp schema lúc mở thì dựng factory riêng bằng
 * `makeOpenLazyDb({ applySchema })`.
 */
export const openLazyDb = makeOpenLazyDb();

export interface BindingDbReport {
  /** Đường dẫn tuyệt đối thực sự được mở (sau resolveDbPath). */
  resolvedPath: string;
  /** Số dòng trong `ticket_bindings`, hoặc null khi bảng chưa tồn tại. */
  bindingCount: number | null;
  /** True khi mở được file thật; false khi phải hạ xuống :memory: (file hỏng/thiếu). */
  opened: boolean;
}

/**
 * Chẩn đoán CHỈ-ĐỌC file SQLite binding mà worker đang dùng, để bắt tận gốc lỗi
 * OP 16/10 (worker trỏ nhầm DB rỗng nên nuốt mọi comment). Resolve path ra tuyệt
 * đối (cảnh báo nếu tương đối), mở chỉ-đọc, ĐẾM `ticket_bindings`, và log rõ
 * file + số binding. Một worker vừa khởi động mà binding = 0 (hoặc bảng chưa có)
 * gần như chắc là đang trỏ nhầm DB — cảnh báo để soi được ngay thay vì "webhook
 * 200 mà chat im". Không ném: chẩn đoán lỗi không được làm chết worker.
 */
export function inspectBindingDb(dbPath: string, base?: string): BindingDbReport {
  const resolvedPath = resolveDbPath(dbPath, base);
  const isMemory =
    resolvedPath === ":memory:" ||
    resolvedPath.includes("mode=memory") ||
    resolvedPath.startsWith("file:");
  if (isMemory) {
    return { resolvedPath, bindingCount: null, opened: false };
  }
  try {
    const db = new Database(resolvedPath, { readonly: true });
    try {
      const hasTable = db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='ticket_bindings'`)
        .get() as { name: string } | null;
      if (!hasTable) {
        getLogger().warn(
          `[worker] DB binding "${resolvedPath}" CHƯA có bảng ticket_bindings — worker có đang trỏ đúng file DB không? ` +
            `(lỗi hay gặp: path tương đối + CWD khác nên mở nhầm một DB rỗng).`,
        );
        return { resolvedPath, bindingCount: null, opened: true };
      }
      const row = db.query(`SELECT COUNT(*) AS n FROM ticket_bindings`).get() as { n: number };
      const n = Number(row?.n ?? 0);
      if (n === 0) {
        getLogger().warn(
          `[worker] DB binding "${resolvedPath}": ticket_bindings RỖNG (0 dòng). Nếu đã có ticket mà vẫn rỗng, ` +
            `worker gần như chắc đang trỏ NHẦM file DB (path tương đối/CWD khác) — comment sẽ bị nuốt lặng lẽ.`,
        );
      } else {
        getLogger().info(`[worker] DB binding "${resolvedPath}": ${n} binding.`);
      }
      return { resolvedPath, bindingCount: n, opened: true };
    } finally {
      db.close();
    }
  } catch (err) {
    getLogger().warn(
      `[worker] Không mở được DB binding "${resolvedPath}" để chẩn đoán (${err instanceof Error ? err.message : String(err)}).`,
    );
    return { resolvedPath, bindingCount: null, opened: false };
  }
}
