/**
 * SQLite-backed notify stores: `message_routes` (reply routing) and a
 * by-issue-id read over the library's `ticket_bindings` table.
 *
 * NGUỒN: intake `lib/storage/binding-repository.ts` — `saveMessageRoute` /
 * `getMessageRoute` (fd48c6e: chat-scoped lookup; an empty-chat row is used
 * only as a fallback when the asking chat holds that issue's binding) and
 * `getBindingByIssueId`.
 *
 * The write path's `ChannelBindingStore` (create/binding-store.ts) keys by chat
 * and holds no `channelType`; notify keys by issue id and needs `channelType`
 * to pick a `ChannelPort`, so the `ticket_bindings` table gains a nullable
 * `channel_type` column (default "telegram" when a row predates it).
 */
import type { Database } from "bun:sqlite";
import { assertNotLegacyFile, tableColumns } from "../create/binding-schema";
import { chatIdVariants } from "../draft/repository";
import type {
  MessageRoute,
  MessageRouteKind,
  MessageRouteStore,
  NotifyBinding,
  NotifyBindingReader,
  TicketLifecycleState,
  TicketStateRecord,
  TicketStateStore,
} from "../ports";

export const NOTIFY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS message_routes (
     message_id TEXT NOT NULL,
     channel_type TEXT NOT NULL,
     chat_id TEXT NOT NULL DEFAULT '',
     issue_id INTEGER NOT NULL,
     identifier TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT '',
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (message_id, channel_type, chat_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_routes_issue ON message_routes (issue_id)`,
  `CREATE TABLE IF NOT EXISTS ticket_states (
     issue_id INTEGER PRIMARY KEY,
     identifier TEXT NOT NULL,
     state TEXT NOT NULL,
     column_id INTEGER,
     prompt_message_id TEXT,
     reporter_ok_at INTEGER,
     updated_at INTEGER NOT NULL
   )`,
];

/** Apply the notify schema (shape matches core's `ApplySchema`). */
export function notifyApplySchema(db: Database, opts: { wal: boolean } = { wal: false }): void {
  // File legacy (TL1) do TL1 sở hữu: `ticket_states` của nó có `project_key` NOT NULL mà bảng core không điền, và
  // ALTER thêm cột là đổi schema của nó. Binding/route ở file legacy đi qua `legacyBindingApplySchema`.
  assertNotLegacyFile(db, "notifyApplySchema");
  if (opts.wal) {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
  }
  for (const stmt of NOTIFY_SCHEMA) db.run(stmt);
  // ticket_bindings may already exist (draft/schema.ts); add missing columns the
  // notify reader selects, so a bot that applied only the notify schema (not the
  // full intake schema) still reads cleanly on an older table.
  const cols = db.query(`PRAGMA table_info(ticket_bindings)`).all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "channel_type")) {
    db.run(`ALTER TABLE ticket_bindings ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'telegram'`);
  }
  if (cols.length > 0 && !cols.some((c) => c.name === "reporter_user_id")) {
    db.run(`ALTER TABLE ticket_bindings ADD COLUMN reporter_user_id TEXT`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_bindings_user ON ticket_bindings (reporter_user_id, updated_at DESC)`,
    );
  }
}

export class SqliteMessageRouteStore implements MessageRouteStore {
  constructor(private readonly db: Database) {}

  saveMessageRoute(route: {
    messageId: string;
    channelType: string;
    chatId: string;
    issueId: number;
    identifier: string;
    kind: MessageRouteKind;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO message_routes (message_id, channel_type, chat_id, issue_id, identifier, kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        route.messageId,
        route.channelType,
        route.chatId ?? "",
        route.issueId,
        route.identifier,
        route.kind ?? "",
      );
  }

  /**
   * Tra route theo (message_id, kênh, chat). Dòng không rõ chat (chat_id = '')
   * chỉ làm dự phòng khi ticket đó có binding nằm đúng chat đang hỏi — nếu
   * không, `null`: thà không nhận reply còn hơn ghi vào ticket chat khác. (fd48c6e)
   */
  getMessageRoute(messageId: string, channelType: string, chatId: string): MessageRoute | null {
    const chat = chatId ?? "";
    const exact = this.db
      .prepare(
        `SELECT message_id, channel_type, chat_id, issue_id, identifier
         FROM message_routes WHERE message_id = ? AND channel_type = ? AND chat_id = ?`,
      )
      .get(messageId, channelType, chat) as any;
    let row = exact;
    if (!row && chat) {
      row = this.db
        .prepare(
          `SELECT r.message_id, r.channel_type, r.chat_id, r.issue_id, r.identifier
           FROM message_routes r
           JOIN ticket_bindings b ON b.issue_id = r.issue_id
           WHERE r.message_id = ? AND r.channel_type = ? AND r.chat_id = '' AND b.chat_id = ?`,
        )
        .get(messageId, channelType, chat) as any;
    }
    if (!row) return null;
    return {
      messageId: row.message_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      issueId: row.issue_id,
      identifier: row.identifier,
    };
  }

  /** Tra route gửi tin gần nhất tới chat trong cửa sổ thời gian. */
  getLatestMessageRouteForChat(
    channelType: string,
    chatIds: string[],
    sinceMs: number,
    kind: MessageRouteKind = "comment",
  ): MessageRoute | null {
    const ids = [...new Set(chatIds.filter(Boolean))];
    if (ids.length === 0) return null;
    const since = new Date(sinceMs).toISOString().replace("T", " ").slice(0, 19);
    const row = this.db
      .prepare(
        `SELECT message_id, channel_type, chat_id, issue_id, identifier, created_at, kind
         FROM message_routes
         WHERE channel_type = ? AND chat_id IN (${ids.map(() => "?").join(",")}) AND created_at >= ? AND kind = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(channelType, ...ids, since, kind) as {
      message_id: string;
      channel_type: string;
      chat_id: string;
      issue_id: number;
      identifier: string;
      created_at?: string;
      kind?: MessageRouteKind;
    } | null;
    if (!row) return null;
    return {
      messageId: row.message_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      issueId: row.issue_id,
      identifier: row.identifier,
      kind: row.kind,
      createdAt: row.created_at,
    };
  }
}

export class SqliteNotifyBindingReader implements NotifyBindingReader {
  /** Có cột `reporter_user_id` không (file legacy của TL1 không có). Dò một lần khi bảng đã tồn tại. */
  private userIdColumn: boolean | undefined;

  constructor(private readonly db: Database) {}

  private hasUserIdColumn(): boolean {
    if (this.userIdColumn !== undefined) return this.userIdColumn;
    const cols = tableColumns(this.db, "ticket_bindings");
    if (cols.length === 0) return true; // chưa có bảng: để câu SELECT báo lỗi như cũ, không nhớ kết quả
    this.userIdColumn = cols.includes("reporter_user_id");
    return this.userIdColumn;
  }

  getBindingByIssueId(issueId: number): NotifyBinding | null {
    const userIdSelect = this.hasUserIdColumn() ? "reporter_user_id" : "NULL AS reporter_user_id";
    const row = this.db
      .prepare(
        `SELECT issue_id, chat_id, identifier, title, reporter_username, ${userIdSelect},
                COALESCE(channel_type, 'telegram') AS channel_type
         FROM ticket_bindings WHERE issue_id = ?`,
      )
      .get(issueId) as {
      issue_id: number;
      chat_id: string;
      identifier: string;
      title: string | null;
      reporter_username: string | null;
      reporter_user_id: string | null;
      channel_type: string;
    } | null;
    if (!row) return null;
    return {
      issueId: row.issue_id,
      chatId: row.chat_id,
      identifier: row.identifier,
      channelType: row.channel_type,
      title: row.title ?? undefined,
      reporterUsername: row.reporter_username ?? undefined,
      reporterUserId: row.reporter_user_id ?? undefined,
    };
  }
}

/** `ticket_states` trên SQLite: hiện thực {@link TicketStateStore}. */
export class SqliteTicketStateStore implements TicketStateStore {
  constructor(private readonly db: Database) {}

  get(issueId: number): TicketStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT issue_id, identifier, state, column_id, prompt_message_id, reporter_ok_at, updated_at
         FROM ticket_states WHERE issue_id = ?`,
      )
      .get(issueId) as {
      issue_id: number;
      identifier: string;
      state: string;
      column_id: number | null;
      prompt_message_id: string | null;
      reporter_ok_at: number | null;
      updated_at: number;
    } | null;
    if (!row) return null;
    return {
      issueId: row.issue_id,
      identifier: row.identifier,
      state: row.state as TicketLifecycleState,
      columnId: row.column_id,
      promptMessageId: row.prompt_message_id,
      reporterOkAt: row.reporter_ok_at,
      updatedAt: row.updated_at,
    };
  }

  enter(input: {
    issueId: number;
    identifier: string;
    state: TicketLifecycleState;
    columnId: number | null;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ticket_states (issue_id, identifier, state, column_id, prompt_message_id, reporter_ok_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           identifier = excluded.identifier, state = excluded.state, column_id = excluded.column_id,
           prompt_message_id = NULL, reporter_ok_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(input.issueId, input.identifier, input.state, input.columnId, input.now);
  }

  setPrompt(issueId: number, messageId: string): void {
    this.db
      .prepare(`UPDATE ticket_states SET prompt_message_id = ? WHERE issue_id = ?`)
      .run(messageId, issueId);
  }

  markReporterOk(issueId: number, now: number): void {
    this.db
      .prepare(`UPDATE ticket_states SET reporter_ok_at = ?, updated_at = ? WHERE issue_id = ?`)
      .run(now, now, issueId);
  }
}

/** Re-exported for callers wiring chat-id variants into route lookups. */
export { chatIdVariants };
