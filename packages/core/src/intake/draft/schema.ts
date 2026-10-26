/**
 * SQLite schema owned by the intake library (ticket 08).
 *
 * The library owns this schema, not a bot: the write engine's draft store and
 * chat binding store need these two tables, and they are applied through core's
 * lazy-db `applySchema` hook (`makeOpenLazyDb({ applySchema: intakeApplySchema })`).
 * Core never knows a bot's schema — it just calls the hook we pass it.
 *
 * NGUỒN: intake `lib/storage/schema.ts` — the `intake_documents` table
 * (revisioned draft aggregate, PRIMARY KEY (doc_id, revision)) and
 * `ticket_bindings`, reduced to the columns the write path uses. The bot-shaped
 * tables (chat_flags, message_routes, user_identities, kg/onyx queues…) stay in
 * the bot; they are not part of this engine.
 */
import type { Database } from "bun:sqlite";
import { assertNotLegacyFile } from "../create/binding-schema";

export const INTAKE_SCHEMA = [
  // Revisioned draft aggregate. (doc_id, revision) is the atomic key: a
  // confirm-click claims the right to create by INSERT OR IGNORE on the next
  // revision — two concurrent clicks race on this unique key, one wins.
  `CREATE TABLE IF NOT EXISTS intake_documents (
     doc_id TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'collecting',
     state_json TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (doc_id, revision)
   )`,
  // Chat↔ticket binding so a worker can report back to the reporter.
  // `reporter_user_id` = khóa định danh người báo theo user id của kênh (bền
  // hơn username/tên). Nullable để DB cũ không cần migration (CREATE IF NOT
  // EXISTS bỏ qua bảng đã tồn tại; `intakeApplySchema` chạy ALTER bù cột khi
  // thiếu — xem bên dưới).
  `CREATE TABLE IF NOT EXISTS ticket_bindings (
     issue_id INTEGER PRIMARY KEY,
     chat_id TEXT NOT NULL,
     identifier TEXT NOT NULL,
     title TEXT,
     reporter_username TEXT,
     reporter_user_id TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS idx_intake_docs_chat ON intake_documents (chat_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intake_docs_status ON intake_documents (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_chat ON ticket_bindings (chat_id, updated_at DESC)`,
];
// Index trên cột `reporter_user_id` KHÔNG để trong mảng trên: với DB cũ (bảng
// ticket_bindings tồn tại nhưng chưa có cột), `CREATE TABLE IF NOT EXISTS` bỏ
// qua nên cột chưa có, và một CREATE INDEX ở đây sẽ lỗi "no such column". Index
// được tạo trong `intakeApplySchema` SAU khi cột chắc chắn tồn tại (bảng mới có
// sẵn cột; bảng cũ vừa được ALTER bù).
const BINDINGS_USER_INDEX = `CREATE INDEX IF NOT EXISTS idx_bindings_user ON ticket_bindings (reporter_user_id, updated_at DESC)`;

/**
 * Apply the intake schema. Shape matches core's `ApplySchema` type
 * `(db, { wal }) => void`, so it is passed straight into `makeOpenLazyDb`.
 * WAL only means something on disk, never for `:memory:`.
 */
export function intakeApplySchema(db: Database, opts: { wal: boolean } = { wal: false }): void {
  // Không bao giờ áp lên file của Tiểu Linh 1: ALTER bảng của TL1 và tờ khai hai hình dạng chung `intake_documents`.
  assertNotLegacyFile(db, "intakeApplySchema");
  if (opts.wal) {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
  }
  for (const statement of INTAKE_SCHEMA) db.run(statement);
  // DB cũ đã có `ticket_bindings` thiếu `reporter_user_id` (CREATE IF NOT EXISTS
  // không thêm cột cho bảng sẵn có): bù cột để bot cũ nâng lib không cần migration
  // tay. Nullable, nên dữ liệu cũ nguyên vẹn và hành vi không đổi khi bỏ trống.
  const cols = db.query(`PRAGMA table_info(ticket_bindings)`).all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "reporter_user_id")) {
    db.run(`ALTER TABLE ticket_bindings ADD COLUMN reporter_user_id TEXT`);
  }
  // Cột chắc chắn có (bảng mới có sẵn / bảng cũ vừa ALTER) → tạo index an toàn.
  db.run(BINDINGS_USER_INDEX);
}
