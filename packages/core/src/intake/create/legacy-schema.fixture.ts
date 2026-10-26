/**
 * FIXTURE: schema SQLite của Tiểu Linh 1 (legacy), SAO NGUYÊN VĂN mảng `SCHEMA` trong
 * `apps/tieulinh-legacy/lib/storage/schema.ts` (không import code legacy). `binding-legacy.test.ts` có test
 * "không trôi" so khối này với file nguồn khi file đó còn tồn tại; sửa legacy thì sao lại đây.
 *
 * Kèm hai thứ cho test hai chiều: các ALTER mà `applySchema` của TL1 chạy (cột `kind`, `column_id`, `department`;
 * `migrateMessageRoutes` không cần vì bảng mới đã có `chat_id`) và các câu SQL ghi/đọc binding của
 * `TicketBindingRepository` (sao nguyên văn câu lệnh) để đóng vai "TL1 ghi, core đọc" và "core ghi, TL1 đọc".
 */
import type { Database } from "bun:sqlite";

export const LEGACY_SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS chat_flags (
     chat_id TEXT NOT NULL,
     flag TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (chat_id, flag)
   )`,
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
  `CREATE TABLE IF NOT EXISTS kg_sync_ledger (
     identifier TEXT PRIMARY KEY,
     fingerprint TEXT NOT NULL,
     synced_at INTEGER NOT NULL
   )`,
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

/** Dựng một database y như `applySchema(db)` của TL1 trên file mới. */
export function applyLegacySchemaFixture(db: Database): void {
  for (const statement of LEGACY_SCHEMA_DDL) db.run(statement);
  // Như TL1: mỗi ALTER nằm trong try/catch ("Column already exists" khi bảng đã có cột).
  for (const alter of [
    "ALTER TABLE user_identities ADD COLUMN department TEXT;",
    "ALTER TABLE message_routes ADD COLUMN kind TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE ticket_states ADD COLUMN column_id INTEGER;",
  ]) {
    try {
      db.run(alter);
    } catch {
      // cột đã có
    }
  }
}

/** `sqlite_master` (bảng, index) dạng so sánh được: dùng để chứng minh schema không bị đổi. */
export function schemaSnapshot(db: Database): string[] {
  return (
    db
      .query(
        `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((r) => `${r.type}:${r.name}:${(r.sql ?? "").replace(/\s+/g, " ")}`);
}

// ── Mô phỏng TL1 (`TicketBindingRepository`): SQL sao nguyên văn, KHÔNG phải import ──────────────────────────────

export interface Tl1Binding {
  issueId: number;
  channelType: string;
  chatId: string;
  messageId: string;
  identifier: string;
  title?: string;
  reporterUsername?: string;
}

const tl1Username = (u?: string | null) => {
  const t = (u ?? "").trim().replace(/^@+/, "");
  return t.length > 0 ? t : null;
};

/** `TicketBindingRepository.saveBinding`. */
export function tl1SaveBinding(db: Database, b: Tl1Binding): void {
  db.prepare(`
      INSERT INTO ticket_bindings (issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(issue_id) DO UPDATE SET
        channel_type = excluded.channel_type,
        chat_id = excluded.chat_id,
        message_id = excluded.message_id,
        identifier = excluded.identifier,
        title = COALESCE(excluded.title, ticket_bindings.title),
        reporter_username = COALESCE(excluded.reporter_username, ticket_bindings.reporter_username),
        updated_at = CURRENT_TIMESTAMP
    `).run(
    b.issueId,
    b.channelType,
    b.chatId,
    b.messageId,
    b.identifier,
    b.title || null,
    tl1Username(b.reporterUsername),
  );
}

/** `bindIssueToChat`: cách TL1 tạo binding sau khi tạo ticket. */
export function tl1BindIssueToChat(
  db: Database,
  issue: { id: number; identifier: string; title?: string },
  chatId: string | number,
  reporterUsername?: string,
): void {
  tl1SaveBinding(db, {
    issueId: issue.id,
    channelType: "telegram",
    chatId: String(chatId),
    messageId: "0",
    identifier: issue.identifier,
    title: issue.title,
    reporterUsername,
  });
}

/** `TicketBindingRepository.getBindingByIssueId`. */
export function tl1GetBindingByIssueId(db: Database, issueId: number): Tl1Binding | null {
  const row = db
    .prepare(`
      SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
      FROM ticket_bindings
      WHERE issue_id = ?
    `)
    .get(issueId) as any;
  if (!row) return null;
  return {
    issueId: row.issue_id,
    channelType: row.channel_type,
    chatId: row.chat_id,
    messageId: row.message_id,
    identifier: row.identifier,
    title: row.title ?? undefined,
    reporterUsername: row.reporter_username ?? undefined,
  };
}

/** `TicketBindingRepository.getLatestBinding` (chat, rồi username, lọc theo tiền tố dự án). */
export function tl1GetLatestBinding(
  db: Database,
  chatId?: string,
  reporterUsername?: string,
  projectKey?: string,
): Tl1Binding | null {
  let row: any;
  const prefix = projectKey ? `${projectKey.trim().toUpperCase()}-` : "";
  const byProject = prefix ? "AND substr(UPPER(identifier), 1, ?) = ?" : "";
  const projectArgs = prefix ? [prefix.length, prefix] : [];
  if (chatId) {
    row = db
      .prepare(`
        SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
        FROM ticket_bindings
        WHERE chat_id = ? ${byProject}
        ORDER BY updated_at DESC, issue_id DESC
        LIMIT 1
      `)
      .get(chatId, ...projectArgs);
  }
  if (!row && reporterUsername) {
    const norm = tl1Username(reporterUsername);
    if (norm) {
      row = db
        .prepare(`
          SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
          FROM ticket_bindings
          WHERE UPPER(reporter_username) = UPPER(?) ${byProject}
          ORDER BY updated_at DESC, issue_id DESC
          LIMIT 1
        `)
        .get(norm, ...projectArgs);
    }
  }
  if (!row) return null;
  return {
    issueId: row.issue_id,
    channelType: row.channel_type,
    chatId: row.chat_id,
    messageId: row.message_id,
    identifier: row.identifier,
    title: row.title ?? undefined,
    reporterUsername: row.reporter_username ?? undefined,
  };
}

/** `TicketBindingRepository.saveMessageRoute`. */
export function tl1SaveMessageRoute(
  db: Database,
  messageId: string | number,
  channelType: string,
  issueId: number,
  identifier: string,
  chatId?: string | number | null,
  kind = "",
): void {
  db.prepare(`
      INSERT OR REPLACE INTO message_routes (message_id, channel_type, chat_id, issue_id, identifier, kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
    String(messageId),
    channelType,
    chatId == null ? "" : String(chatId),
    issueId,
    identifier,
    kind,
  );
}

/** Phần khớp chính xác của `TicketBindingRepository.getMessageRoute` (có dự phòng theo binding). */
export function tl1GetMessageRoute(
  db: Database,
  messageId: string | number,
  channelType: string,
  chatId?: string | number | null,
): { messageId: string; chatId: string; issueId: number; identifier: string } | null {
  const chat = chatId == null ? "" : String(chatId);
  let row = db
    .prepare(`
        SELECT message_id, channel_type, chat_id, issue_id, identifier, created_at
        FROM message_routes
        WHERE message_id = ? AND channel_type = ? AND chat_id = ?
      `)
    .get(String(messageId), channelType, chat) as any;
  if (!row && chat) {
    row = db
      .prepare(`
          SELECT r.message_id, r.channel_type, r.chat_id, r.issue_id, r.identifier, r.created_at
          FROM message_routes r
          JOIN ticket_bindings b ON b.issue_id = r.issue_id
          WHERE r.message_id = ? AND r.channel_type = ? AND r.chat_id = '' AND b.chat_id = ?
        `)
      .get(String(messageId), channelType, chat) as any;
  }
  if (!row) return null;
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    issueId: row.issue_id,
    identifier: row.identifier,
  };
}
