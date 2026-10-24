/**
 * Bảng SQLite của một bot.
 *
 * Chỉ có bảng và cách áp bảng, không import gì ngoài kiểu của bun:sqlite.
 * MCP server và worker dùng chung file này nên schema không thể lệch nhau.
 */
import type { Database } from "bun:sqlite";

export const SCHEMA = [
  // Cờ ngắn hạn theo chat do plugin/worker đặt, pipeline đọc rồi xoá (ADR-0008: "/new"
  // bị OpenClaw nuốt trước khi tới agent → plugin đặt cờ "force_new").
  `CREATE TABLE IF NOT EXISTS chat_flags (
     chat_id TEXT NOT NULL,
     flag TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (chat_id, flag)
   )`,
  // Bản bổ sung/đính chính IRIS đã soạn, chờ người gửi bấm xác nhận mới ghi vào yêu cầu (một bản mỗi chat).
  `CREATE TABLE IF NOT EXISTS pending_ticket_updates (
     chat_id TEXT PRIMARY KEY,
     identifier TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
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
  // message_id của Telegram chỉ duy nhất trong một chat, nên khoá phải có
  // chat_id. `DEFAULT ''` để worker bản cũ (không biết cột này) vẫn ghi được
  // trong lúc chuyển giao — xem migrateMessageRoutes.
  `CREATE TABLE IF NOT EXISTS message_routes (
     message_id TEXT NOT NULL,
     channel_type TEXT NOT NULL,
     chat_id TEXT NOT NULL DEFAULT '',
     issue_id INTEGER NOT NULL,
     identifier TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (message_id, channel_type, chat_id)
   )`,
  `CREATE TABLE IF NOT EXISTS intake_sessions (
     session_id TEXT PRIMARY KEY,
     state_json TEXT NOT NULL,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS user_identities (
     telegram_user_id TEXT PRIMARY KEY,
     name_code TEXT NOT NULL UNIQUE,
     full_name TEXT,
     username TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     approved_by TEXT,
     pending_report TEXT,
     department TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS approved_prefixes (
     prefix TEXT PRIMARY KEY,
     approved_by TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  // Chỉ còn là nguồn migrate một lần sang ticket_states (luồng tự đóng cũ đã bỏ, ADR-0006).
  `CREATE TABLE IF NOT EXISTS resolved_tickets (
     issue_id INTEGER PRIMARY KEY,
     identifier TEXT NOT NULL,
     project_key TEXT NOT NULL,
     channel_type TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     prompt_message_id TEXT,
     resolved_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending_confirmation'
   )`,
  `CREATE TABLE IF NOT EXISTS sla_trackers (
     issue_id INTEGER PRIMARY KEY,
     identifier TEXT NOT NULL,
     priority TEXT NOT NULL,
     project_key TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     sla_hours REAL NOT NULL,
     alerted_at INTEGER,
     status TEXT NOT NULL DEFAULT 'open'
   )`,
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
  // Hàng đợi thử lại nạp Knowledge Graph (worker/kg-sync-runner.ts): sync hỏng
  // không còn mất hẳn. project_key vì hai worker dùng chung file DB.
  `CREATE TABLE IF NOT EXISTS kg_sync_queue (
     identifier TEXT PRIMARY KEY,
     issue_id INTEGER NOT NULL,
     project_key TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Cùng cấu trúc kg_sync_queue, cho sink Onyx — trước đây Onyx lỗi là mất việc.
  `CREATE TABLE IF NOT EXISTS onyx_ingest_queue (
     identifier TEXT PRIMARY KEY,
     issue_id INTEGER NOT NULL,
     project_key TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Sổ "đã nạp ticket với nội dung nào" — chặn LLM bóc lại khi một ticket Done
  // được nạp lại (vd mở lại rồi đóng lại mà nội dung không đổi).
  `CREATE TABLE IF NOT EXISTS kg_sync_ledger (
     identifier TEXT PRIMARY KEY,
     fingerprint TEXT NOT NULL,
     synced_at INTEGER NOT NULL
   )`,
  // Trạng thái cuối cùng đã thấy của mỗi ticket (worker/ticket-closure.ts).
  // Chính nó là chốt chống trùng: sự kiện lặp mà trạng thái không đổi thì bỏ
  // qua; chuyển SANG done mới phát "hoàn tất" — đúng một lần mỗi lần đóng.
  `CREATE TABLE IF NOT EXISTS ticket_states (
     issue_id INTEGER PRIMARY KEY,
     identifier TEXT NOT NULL,
     project_key TEXT NOT NULL,
     state TEXT NOT NULL,
     prompt_message_id TEXT,
     reporter_ok_at INTEGER,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_chat ON ticket_bindings (chat_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_reporter ON ticket_bindings (reporter_username, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_resolved_tickets_status ON resolved_tickets (status, resolved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sla_trackers_status ON sla_trackers (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_intake_docs_chat ON intake_documents (chat_id, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intake_docs_status ON intake_documents (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_kg_sync_queue_due ON kg_sync_queue (project_key, next_attempt_at)`,
];

/** WAL chỉ có nghĩa với database nằm trên đĩa, không dùng cho `:memory:`. */
export function applySchema(db: Database, options: { wal?: boolean } = {}): void {
  if (options.wal) {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
  }
  for (const statement of SCHEMA) db.run(statement);
  try {
    db.run("ALTER TABLE user_identities ADD COLUMN department TEXT;");
  } catch {
    // Column already exists
  }
  migrateMessageRoutes(db);
  // Loại tin bot chuyển: "comment" (kỹ thuật trao đổi) / "state" (báo đổi trạng thái).
  // Chỉ "comment" mới là câu hỏi kỹ thuật đang chờ người báo trả lời (ADR-0008).
  try {
    db.run("ALTER TABLE message_routes ADD COLUMN kind TEXT NOT NULL DEFAULT '';");
  } catch {
    // Column already exists
  }
  // Cột cuối cùng đã báo: dự án có lời báo riêng cho từng cột (PO) cần báo cả khi đổi giữa hai cột cùng nhóm "mở".
  try {
    db.run("ALTER TABLE ticket_states ADD COLUMN column_id INTEGER;");
  } catch {
    // Column already exists
  }
  migrateLegacyResolved(db);
}

/**
 * Ticket đang chờ ở `resolved_tickets` (luồng tự đóng cũ, bỏ 24/09 — ADR-0006)
 * chuyển sang `ticket_states` để nút cũ vẫn được gỡ khi người xử lý đóng ticket.
 * INSERT OR IGNORE: chạy lại bao nhiêu lần cũng được, không đè trạng thái mới.
 */
function migrateLegacyResolved(db: Database): void {
  db.run(`
    INSERT OR IGNORE INTO ticket_states (issue_id, identifier, project_key, state, prompt_message_id, updated_at)
    SELECT issue_id, identifier, project_key, 'resolved', prompt_message_id, resolved_at
    FROM resolved_tickets WHERE status = 'pending_confirmation'
  `);
}

/**
 * DB cũ khoá message_routes theo (message_id, channel_type) — thiếu chat_id nên
 * reply ở chat B có thể trỏ nhầm sang ticket của chat A (hai bot chung DB).
 *
 * SQLite không đổi được PRIMARY KEY tại chỗ, nên dựng lại bảng trong một
 * transaction IMMEDIATE (worker khác đang chạy chỉ phải chờ, không đọc được
 * trạng thái nửa vời). Không bỏ dòng nào: chat_id được điền từ binding của
 * ticket (tin nhắn route luôn gửi tới chat của binding); không suy ra được thì
 * để '' — getMessageRoute chỉ dùng dòng đó làm dự phòng khi không mơ hồ.
 * Đã có cột chat_id thì không làm gì — chạy lại bao nhiêu lần cũng được.
 */
function migrateMessageRoutes(db: Database): void {
  const cols = db.query(`PRAGMA table_info(message_routes)`).all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === "chat_id")) return;

  db.transaction(() => {
    // Kiểm tra lại trong transaction: process khác có thể vừa migrate xong.
    const again = db.query(`PRAGMA table_info(message_routes)`).all() as Array<{ name: string }>;
    if (again.some((c) => c.name === "chat_id")) return;
    db.run(`CREATE TABLE message_routes_new (
       message_id TEXT NOT NULL,
       channel_type TEXT NOT NULL,
       chat_id TEXT NOT NULL DEFAULT '',
       issue_id INTEGER NOT NULL,
       identifier TEXT NOT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (message_id, channel_type, chat_id)
     )`);
    db.run(`INSERT INTO message_routes_new (message_id, channel_type, chat_id, issue_id, identifier, created_at)
       SELECT r.message_id, r.channel_type,
              COALESCE((SELECT b.chat_id FROM ticket_bindings b WHERE b.issue_id = r.issue_id), ''),
              r.issue_id, r.identifier, r.created_at
       FROM message_routes r`);
    db.run(`DROP TABLE message_routes`);
    db.run(`ALTER TABLE message_routes_new RENAME TO message_routes`);
  }).immediate();
}
