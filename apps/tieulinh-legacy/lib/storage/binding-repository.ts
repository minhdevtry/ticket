import type { Database } from "bun:sqlite";
import { openLazyDb } from "./lazy-db";
import { memoByPath } from "@vuihoc/bot-core/core";

export interface TicketBinding {
  issueId: number;
  channelType: string;
  chatId: string;
  messageId: string;
  identifier: string;
  title?: string;
  reporterUsername?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Loại tin bot chuyển tới người báo: comment kỹ thuật / báo trạng thái ("" = dòng cũ, không rõ). */
export type MessageRouteKind = "comment" | "state" | "";

export interface MessageRoute {
  messageId: string;
  channelType: string;
  /** '' với dòng cũ ghi trước khi có cột chat_id. */
  chatId: string;
  issueId: number;
  identifier: string;
  createdAt?: string;
}

/**
 * Usernames reach us both as `@name` and `name` depending on which handler
 * captured them. Storing one form keeps the username lookup in
 * `getLatestBinding` from silently missing.
 */
export function normalizeUsername(username?: string | null): string | null {
  const trimmed = (username ?? "").trim().replace(/^@+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export const getSharedBindingRepo = memoByPath<TicketBindingRepository>(
  (dbPath) => new TicketBindingRepository(openLazyDb(dbPath)),
);

export class TicketBindingRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  saveBinding(binding: TicketBinding): void {
    const stmt = this.db.prepare(`
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
    `);
    stmt.run(
      binding.issueId,
      binding.channelType,
      binding.chatId,
      binding.messageId,
      binding.identifier,
      binding.title || null,
      normalizeUsername(binding.reporterUsername),
    );
  }

  getBindingByIssueId(issueId: number): TicketBinding | null {
    const stmt = this.db.prepare(`
      SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
      FROM ticket_bindings
      WHERE issue_id = ?
    `);
    const row = stmt.get(issueId) as any;
    if (!row) return null;

    return {
      issueId: row.issue_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      messageId: row.message_id,
      identifier: row.identifier,
      title: row.title ?? undefined,
      reporterUsername: row.reporter_username ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getBindingByIdentifier(identifier: string): TicketBinding | null {
    const stmt = this.db.prepare(`
      SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
      FROM ticket_bindings
      WHERE identifier = ?
    `);
    const row = stmt.get(identifier) as any;
    if (!row) return null;

    return {
      issueId: row.issue_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      messageId: row.message_id,
      identifier: row.identifier,
      title: row.title ?? undefined,
      reporterUsername: row.reporter_username ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * `chatId` bắt buộc về mặt nghiệp vụ: message_id của Telegram chỉ duy nhất
   * trong một chat. Bỏ trống chỉ để tương thích nơi gọi cũ — dòng như vậy
   * được coi là "không rõ chat" (xem getMessageRoute).
   */
  saveMessageRoute(
    messageId: string | number,
    channelType: string,
    issueId: number,
    identifier: string,
    chatId?: string | number | null,
    kind: MessageRouteKind = "",
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO message_routes (message_id, channel_type, chat_id, issue_id, identifier, kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      String(messageId),
      channelType,
      chatId == null ? "" : String(chatId),
      issueId,
      identifier,
      kind,
    );
  }

  /**
   * Tra route theo (message_id, kênh, chat). Không truyền `chatId` thì chỉ khớp
   * dòng không rõ chat.
   *
   * Dòng cũ không rõ chat (chat_id = '') chỉ được dùng làm dự phòng khi không
   * mơ hồ: ticket đó phải có binding nằm đúng chat đang hỏi. Nếu không, trả
   * `null` — thà không nhận reply còn hơn ghi comment vào ticket của chat khác.
   */
  getMessageRoute(
    messageId: string | number,
    channelType: string,
    chatId?: string | number | null,
  ): MessageRoute | null {
    const chat = chatId == null ? "" : String(chatId);
    const exact = this.db
      .prepare(`
        SELECT message_id, channel_type, chat_id, issue_id, identifier, created_at
        FROM message_routes
        WHERE message_id = ? AND channel_type = ? AND chat_id = ?
      `)
      .get(String(messageId), channelType, chat) as any;

    let row = exact;
    if (!row && chat) {
      row = this.db
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
      channelType: row.channel_type,
      chatId: row.chat_id,
      issueId: row.issue_id,
      identifier: row.identifier,
      createdAt: row.created_at,
    };
  }

  /**
   * Tin gần nhất bot chuyển từ ticket (comment kỹ thuật…) tới chat này, không cũ hơn
   * `sinceMs` — để biết người báo có đang được kỹ thuật hỏi dở một ticket không.
   * `chat_id` có thể mang tiền tố "telegram:" hoặc không, nên nhận nhiều dạng.
   */
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
      .prepare(`
        SELECT message_id, channel_type, chat_id, issue_id, identifier, created_at
        FROM message_routes
        WHERE channel_type = ? AND chat_id IN (${ids.map(() => "?").join(",")}) AND created_at >= ? AND kind = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `)
      .get(channelType, ...ids, since, kind) as any;
    if (!row) return null;
    return {
      messageId: row.message_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      issueId: row.issue_id,
      identifier: row.identifier,
      createdAt: row.created_at,
    };
  }

  /** Lưu bản bổ sung chờ xác nhận của chat (ghi đè bản cũ). */
  savePendingUpdate(chatId: string | number, identifier: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_ticket_updates (chat_id, identifier, payload, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(
        String(chatId).replace(/^telegram:/i, ""),
        identifier.toUpperCase(),
        JSON.stringify(payload),
      );
  }

  getPendingUpdate<T = any>(
    chatId: string | number,
  ): { identifier: string; payload: T; createdAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT identifier, payload, created_at FROM pending_ticket_updates WHERE chat_id = ?`,
      )
      .get(String(chatId).replace(/^telegram:/i, "")) as any;
    return row
      ? {
          identifier: row.identifier,
          payload: JSON.parse(row.payload) as T,
          createdAt: row.created_at,
        }
      : null;
  }

  clearPendingUpdate(chatId: string | number): void {
    this.db
      .prepare(`DELETE FROM pending_ticket_updates WHERE chat_id = ?`)
      .run(String(chatId).replace(/^telegram:/i, ""));
  }

  /** Đặt cờ ngắn hạn cho chat (ghi đè mốc thời gian nếu đã có). */
  setChatFlag(chatId: string | number, flag: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chat_flags (chat_id, flag, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(String(chatId), flag);
  }

  /**
   * Lấy và xoá cờ của chat (nhận nhiều dạng chat_id). Trả true nếu cờ có và không cũ
   * hơn `sinceMs`; cờ cũ cũng bị xoá.
   */
  consumeChatFlag(chatIds: string[], flag: string, sinceMs: number): boolean {
    const ids = [...new Set(chatIds.filter(Boolean))];
    if (ids.length === 0) return false;
    const marks = ids.map(() => "?").join(",");
    const since = new Date(sinceMs).toISOString().replace("T", " ").slice(0, 19);
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM chat_flags WHERE flag = ? AND chat_id IN (${marks}) AND created_at >= ? LIMIT 1`,
      )
      .get(flag, ...ids, since) as any;
    this.db
      .prepare(`DELETE FROM chat_flags WHERE flag = ? AND chat_id IN (${marks})`)
      .run(flag, ...ids);
    return Boolean(row?.hit);
  }

  getAllBindings(): TicketBinding[] {
    const stmt = this.db.prepare(`
      SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
      FROM ticket_bindings
      ORDER BY updated_at DESC, issue_id DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      issueId: row.issue_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      messageId: row.message_id,
      identifier: row.identifier,
      title: row.title ?? undefined,
      reporterUsername: row.reporter_username ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Các ticket của một chat (mới nhất trước) — để hỏi người báo có nhiều ticket đang mở "bổ sung vào cái nào". */
  listBindingsForChat(chatIds: string[], projectKey: string, limit = 8): TicketBinding[] {
    if (chatIds.length === 0) return [];
    const prefix = `${projectKey.trim().toUpperCase()}-`;
    const marks = chatIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
         FROM ticket_bindings
         WHERE chat_id IN (${marks}) AND substr(UPPER(identifier), 1, ?) = ?
         ORDER BY created_at DESC, issue_id DESC
         LIMIT ?`,
      )
      .all(...chatIds, prefix.length, prefix, limit) as any[];
    return rows.map((row) => ({
      issueId: row.issue_id,
      channelType: row.channel_type,
      chatId: row.chat_id,
      messageId: row.message_id,
      identifier: row.identifier,
      title: row.title ?? undefined,
      reporterUsername: row.reporter_username ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * `projectKey` giới hạn theo tiền tố mã (`PO-…`): IRIS và Tiểu Linh dùng chung DB
   * và chung chat_id, không lọc thì bot này lấy nhầm ticket của bot kia.
   */
  getLatestBinding(
    chatId?: string,
    reporterUsername?: string,
    projectKey?: string,
  ): TicketBinding | null {
    let row: any;
    const prefix = projectKey ? `${projectKey.trim().toUpperCase()}-` : "";
    const byProject = prefix ? "AND substr(UPPER(identifier), 1, ?) = ?" : "";
    const projectArgs = prefix ? [prefix.length, prefix] : [];

    if (chatId) {
      const stmt = this.db.prepare(`
        SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
        FROM ticket_bindings
        WHERE chat_id = ? ${byProject}
        ORDER BY updated_at DESC, issue_id DESC
        LIMIT 1
      `);
      row = stmt.get(chatId, ...projectArgs);
    }

    if (!row && reporterUsername) {
      const norm = normalizeUsername(reporterUsername);
      if (norm) {
        const stmt = this.db.prepare(`
          SELECT issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, created_at, updated_at
          FROM ticket_bindings
          WHERE UPPER(reporter_username) = UPPER(?) ${byProject}
          ORDER BY updated_at DESC, issue_id DESC
          LIMIT 1
        `);
        row = stmt.get(norm, ...projectArgs);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
