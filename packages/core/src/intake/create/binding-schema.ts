/**
 * Hai dạng bảng `ticket_bindings` (và `message_routes`) mà kho binding của core phải sống chung (RFC 0002 mục 6.2):
 *
 *  - **core**: bảng do `intakeApplySchema` dựng, không có `channel_type` và `message_id` (cột `channel_type` chỉ
 *    được `notifyApplySchema` ALTER bù, có DEFAULT), có `reporter_user_id`.
 *  - **legacy**: bảng của Tiểu Linh 1 (`apps/tieulinh-legacy/lib/storage/schema.ts`): `channel_type` và `message_id`
 *    đều NOT NULL không DEFAULT, không có `reporter_user_id`.
 *
 * Nhận dạng bằng DÒ CỘT (`PRAGMA table_info`), không bằng cờ tin cậy suông: cột `message_id` có mặt thì là legacy.
 * Cờ `schema` của {@link SqliteChannelBindingStore} chỉ để người vận hành KHẲNG ĐỊNH điều mình tin và bị chặn to khi
 * lệch (ghi sai dạng vào file legacy là vi phạm NOT NULL ngay giữa production), chứ không thay cho việc dò. Chọn dò
 * thay vì cờ thuần vì file legacy do tiến trình khác (TL1) sở hữu và có thể đổi sau lưng cấu hình của ta.
 *
 * Quy tắc cứng: core KHÔNG BAO GIỜ đổi schema của file legacy. Mọi ALTER/CREATE INDEX của `intakeApplySchema` và
 * `notifyApplySchema` bị chặn ở file legacy ({@link assertNotLegacyFile}); file legacy chỉ được mở bằng
 * {@link openLegacyBindingDb}, hàm này chỉ TẠO bảng còn thiếu và không chạm bảng đã có.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

/** Dạng schema của bảng binding. */
export type BindingSchemaKind = "core" | "legacy";

/** Giá trị cờ `schema`: `"auto"` (mặc định) dò theo bảng đang có; còn lại là khẳng định, lệch thì ném lỗi. */
export type BindingSchemaOption = "auto" | BindingSchemaKind;

/** Kênh ghi vào cột `channel_type` của file legacy (như `bindIssueToChat`). */
export const LEGACY_CHANNEL_TYPE = "telegram";

/**
 * Giá trị giữ chỗ ghi vào cột `message_id` (NOT NULL) của file legacy: `bindIssueToChat` của TL1 ghi `"0"` vì lúc
 * tạo ticket chưa có tin nhắn nào gắn với binding. Không ai đọc cột này để định tuyến (tuyến tin nằm ở `message_routes`).
 */
export const LEGACY_MESSAGE_ID_PLACEHOLDER = "0";

/** Lỗi schema binding: dạng bảng không như kỳ vọng. Không bao giờ được tự sửa bằng ALTER. */
export class BindingSchemaError extends Error {
  override readonly name = "BindingSchemaError";
}

/** Tên cột của một bảng, rỗng khi bảng chưa tồn tại. */
export function tableColumns(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Dò dạng `ticket_bindings` của một database. `null` khi bảng chưa có.
 * Có `message_id` là legacy (phải có đủ `channel_type`, `chat_id`, `identifier`, nếu không là {@link BindingSchemaError}).
 */
export function detectBindingSchema(db: Database): BindingSchemaKind | null {
  const cols = tableColumns(db, "ticket_bindings");
  if (cols.length === 0) return null;
  if (!cols.includes("message_id")) return "core";
  for (const need of ["channel_type", "chat_id", "identifier", "issue_id"]) {
    if (!cols.includes(need)) {
      throw new BindingSchemaError(
        `ticket_bindings có message_id nhưng thiếu cột ${need}: không phải dạng legacy đã biết, từ chối ghi`,
      );
    }
  }
  return "legacy";
}

/**
 * Chốt dạng schema dùng để đọc/ghi. `requested` là `"auto"` thì theo bảng đang có (chưa có bảng: `"core"`, dạng
 * `intakeApplySchema` sẽ dựng). Khẳng định `"core"`/`"legacy"` mà bảng đang có dạng khác thì ném lỗi, vì ghi sai dạng
 * vào file legacy sẽ vi phạm NOT NULL còn ghi dạng legacy vào bảng core thì mất cột.
 */
export function resolveBindingSchema(
  db: Database,
  requested: BindingSchemaOption = "auto",
): BindingSchemaKind {
  const found = detectBindingSchema(db);
  if (requested === "auto") return found ?? "core";
  if (found === null) {
    throw new BindingSchemaError(
      requested === "legacy"
        ? "schema=legacy nhưng ticket_bindings chưa có: mở bằng openLegacyBindingDb (tạo bảng còn thiếu) trước"
        : "schema=core nhưng ticket_bindings chưa có: áp intakeApplySchema trước",
    );
  }
  if (found !== requested) {
    throw new BindingSchemaError(
      `schema=${requested} nhưng ticket_bindings đang ở dạng ${found}: kiểm lại đường dẫn file binding`,
    );
  }
  return found;
}

/**
 * File này có phải file của Tiểu Linh 1 không: `ticket_bindings` dạng legacy, hoặc có bảng đặc trưng của TL1
 * (`intake_sessions`, `chat_flags`, `pending_ticket_updates`, `kg_sync_queue`; không dùng `user_identities` vì module `identity` của core cũng tạo bảng đó). Dùng để chặn áp schema core lên file legacy, kể cả khi bảng binding chưa có
 * (trùng tên bảng `intake_documents` nhưng `state_json` khác hình dạng: không bao giờ dùng chung file tờ khai).
 */
export function isLegacyFile(db: Database): boolean {
  if (detectBindingSchema(db) === "legacy") return true;
  const marker = db
    .query(
      `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name IN ('intake_sessions', 'chat_flags', 'pending_ticket_updates', 'kg_sync_queue') LIMIT 1`,
    )
    .get() as { hit: number } | null;
  return marker !== null;
}

/**
 * Chặn áp schema core (`intakeApplySchema`, `notifyApplySchema`) lên file legacy. Hai thứ sẽ hỏng: ALTER thêm cột
 * vào bảng của TL1, và tờ khai TL2 (`IntakeDraft`) trộn với tờ khai TL1 (`IntakeDocument`) trong cùng `intake_documents`.
 */
export function assertNotLegacyFile(db: Database, who: string): void {
  if (isLegacyFile(db)) {
    throw new BindingSchemaError(
      `${who}: file SQLite này là file của Tiểu Linh 1 (schema legacy). Core không áp schema lên file đó; ` +
        `tờ khai TL2 phải ở file riêng, binding dùng openLegacyBindingDb`,
    );
  }
}

/**
 * DDL dạng legacy của hai bảng core cần dùng, theo từng bảng (kèm index của bảng đó). Sao nguyên văn từ
 * `apps/tieulinh-legacy/lib/storage/schema.ts` (đã có cột `kind` của `message_routes` mà TL1 thêm bằng ALTER); một
 * test giữ cho nó không trôi khỏi file đó. Chỉ dùng khi bảng CHƯA có.
 */
export const LEGACY_BINDING_TABLES = {
  ticket_bindings: [
    `CREATE TABLE IF NOT EXISTS ticket_bindings (
     issue_id INTEGER PRIMARY KEY,
     channel_type TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     identifier TEXT NOT NULL,
     title TEXT,
     reporter_username TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
    `CREATE INDEX IF NOT EXISTS idx_bindings_chat ON ticket_bindings (chat_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_bindings_reporter ON ticket_bindings (reporter_username, updated_at DESC)`,
  ],
  message_routes: [
    `CREATE TABLE IF NOT EXISTS message_routes (
     message_id TEXT NOT NULL,
     channel_type TEXT NOT NULL,
     chat_id TEXT NOT NULL DEFAULT '',
     issue_id INTEGER NOT NULL,
     identifier TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     kind TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (message_id, channel_type, chat_id)
   )`,
  ],
} as const;

/**
 * "Áp schema" cho file legacy, theo đúng quy tắc không-đổi-schema: chỉ TẠO bảng còn thiếu (cùng DDL với TL1, nên TL1
 * mở file sau đó vẫn chạy y nguyên), KHÔNG ALTER, KHÔNG thêm index vào bảng đã có, KHÔNG đặt PRAGMA. Bảng đã có thì
 * chỉ được kiểm: `ticket_bindings` phải là dạng legacy; `message_routes` phải đã có `chat_id` và `kind` (file TL1 cũ
 * chưa qua migration của TL1 bị từ chối thay vì để core tự migrate).
 *
 * @throws {@link BindingSchemaError} khi bảng đã có không đúng dạng legacy.
 */
export function legacyBindingApplySchema(db: Database): void {
  const kind = detectBindingSchema(db);
  if (kind === "core") {
    throw new BindingSchemaError(
      "ticket_bindings đang ở dạng core, không phải file legacy: không áp schema legacy lên đó",
    );
  }
  const routeCols = tableColumns(db, "message_routes");
  if (routeCols.length > 0) {
    for (const need of ["chat_id", "kind"]) {
      if (!routeCols.includes(need)) {
        throw new BindingSchemaError(
          `message_routes của file legacy thiếu cột ${need}: để TL1 chạy migration của nó trước; core không migrate file legacy`,
        );
      }
    }
  }
  if (kind === null) for (const s of LEGACY_BINDING_TABLES.ticket_bindings) db.run(s);
  if (routeCols.length === 0) for (const s of LEGACY_BINDING_TABLES.message_routes) db.run(s);
}

/**
 * Mở một file SQLite theo dạng legacy để ghi/đọc binding và tuyến tin chung với TL1. Khác `openPrivateDb`: KHÔNG
 * chmod file đã có (file thuộc TL1, có thể chia quyền theo nhóm), KHÔNG đặt chế độ journal (TL1 đã đặt WAL, đó là
 * thuộc tính của file), chỉ `busy_timeout` 5 giây vì hai tiến trình cùng ghi. File chưa có thì tạo mới (dạng legacy,
 * file 0600, thư mục cha 0700 nếu cũng mới). Lỗi mở/kiểm dạng được NÉM ra: binding không dựng lại được nên không
 * hạ xuống `:memory:`.
 *
 * @throws {@link BindingSchemaError} khi file không ở dạng legacy.
 */
export function openLegacyBindingDb(dbPath: string): Database {
  const file = path.resolve(dbPath);
  const dir = path.dirname(file);
  const dirExisted = fs.existsSync(dir);
  const fileExisted = fs.existsSync(file);
  if (!dirExisted) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(file, { create: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    legacyBindingApplySchema(db);
    if (!fileExisted) fs.chmodSync(file, 0o600);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
