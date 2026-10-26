/**
 * SQLite-backed `ChannelBindingStore` (ticket 08) over the library-owned
 * `ticket_bindings` table (draft/schema.ts).
 *
 * NGUỒN: intake `lib/storage/binding-repository.ts` — `saveBinding`,
 * `getLatestBinding`, `normalizeUsername`, narrowed to the write path's needs.
 *
 * Ghi/đọc được CẢ HAI dạng bảng (RFC 0002 mục 6.2, xem `binding-schema.ts`): dạng core, và dạng legacy của Tiểu
 * Linh 1 (`channel_type` và `message_id` NOT NULL). Dạng legacy ghi `channel_type = 'telegram'` và `message_id = '0'`
 * giữ chỗ y như `bindIssueToChat`, nên TL1 đọc được binding do core ghi và ngược lại. File legacy không có
 * `reporter_user_id`: id người báo bị bỏ khi ghi, tra theo user id luôn rỗng ({@link supportsReporterUserId}).
 */
import type { Database } from "bun:sqlite";
import type { ChannelBindingStore } from "../ports";
import { chatIdVariants } from "../draft/repository";
import {
  LEGACY_CHANNEL_TYPE,
  LEGACY_MESSAGE_ID_PLACEHOLDER,
  type BindingSchemaKind,
  type BindingSchemaOption,
  detectBindingSchema,
  resolveBindingSchema,
} from "./binding-schema";

/** Usernames arrive as `@name` or `name`; store one form so lookups don't miss. */
export function normalizeUsername(username?: string | null): string | null {
  const trimmed = (username ?? "").trim().replace(/^@+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * User id của kênh về một dạng chuẩn: bỏ tiền tố "telegram:" (binding/chat đôi
 * khi mang tiền tố), cắt khoảng trắng. Rỗng → null để không ghi "" làm khóa.
 * Chỉ chuẩn hóa chuỗi, KHÔNG ép kiểu số: id Telegram vừa với số nhưng id kênh
 * khác có thể là chuỗi.
 */
export function normalizeUserId(userId?: string | null): string | null {
  const trimmed = (userId ?? "").trim().replace(/^telegram:/i, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Tuỳ chọn của {@link SqliteChannelBindingStore}. */
export interface SqliteChannelBindingStoreOptions {
  /**
   * `"auto"` (mặc định): dò theo bảng `ticket_bindings` đang có (xem {@link detectBindingSchema}). `"core"` hoặc
   * `"legacy"`: khẳng định dạng của file; bảng có dạng khác thì ném `BindingSchemaError` thay vì ghi sai.
   */
  schema?: BindingSchemaOption;
}

export class SqliteChannelBindingStore implements ChannelBindingStore {
  private resolved: BindingSchemaKind | undefined;

  constructor(
    private readonly db: Database,
    private readonly options: SqliteChannelBindingStoreOptions = {},
  ) {
    // Bảng đã có thì dò và kiểm ngay (sai là ném ở đây, không đợi đến lần ghi đầu tiên giữa production).
    // Chưa có bảng (chưa áp schema): để lần dùng đầu dò lại.
    if (detectBindingSchema(db) !== null) this.resolved = resolveBindingSchema(db, options.schema);
    else if (options.schema === "legacy") resolveBindingSchema(db, options.schema);
  }

  /** Dạng schema của bảng binding mà store này đang đọc/ghi. */
  get schema(): BindingSchemaKind {
    this.resolved ??= resolveBindingSchema(this.db, this.options.schema);
    return this.resolved;
  }

  /**
   * Tra theo user id có hoạt động không. Dạng legacy không có cột `reporter_user_id` (và core không được thêm cột vào
   * file legacy) nên `false`: `getLatestBindingByUserId` luôn trả null, `rebindReporterUserId` trả 0.
   */
  get supportsReporterUserId(): boolean {
    return this.schema === "core";
  }

  saveBinding(binding: {
    issueId: number;
    chatId: string;
    identifier: string;
    title?: string;
    reporterUserId?: string;
    reporterUsername?: string;
  }): void {
    if (this.schema === "legacy") {
      // Y như `TicketBindingRepository.saveBinding` + `bindIssueToChat` của TL1; `reporterUserId` không có chỗ lưu.
      this.db
        .prepare(
          `INSERT INTO ticket_bindings (issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(issue_id) DO UPDATE SET
             channel_type = excluded.channel_type,
             chat_id = excluded.chat_id,
             message_id = excluded.message_id,
             identifier = excluded.identifier,
             title = COALESCE(excluded.title, ticket_bindings.title),
             reporter_username = COALESCE(excluded.reporter_username, ticket_bindings.reporter_username),
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(
          binding.issueId,
          LEGACY_CHANNEL_TYPE,
          binding.chatId,
          LEGACY_MESSAGE_ID_PLACEHOLDER,
          binding.identifier,
          binding.title || null,
          normalizeUsername(binding.reporterUsername),
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ticket_bindings (issue_id, chat_id, identifier, title, reporter_username, reporter_user_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(issue_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           identifier = excluded.identifier,
           title = COALESCE(excluded.title, ticket_bindings.title),
           reporter_username = COALESCE(excluded.reporter_username, ticket_bindings.reporter_username),
           reporter_user_id = COALESCE(excluded.reporter_user_id, ticket_bindings.reporter_user_id),
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(
        binding.issueId,
        binding.chatId,
        binding.identifier,
        binding.title ?? null,
        normalizeUsername(binding.reporterUsername),
        normalizeUserId(binding.reporterUserId),
      );
  }

  getLatestBinding(
    chatId: string,
    identifierPrefix?: string,
  ): { issueId: number; identifier: string; title?: string } | null {
    const keys = chatIdVariants(chatId);
    const prefix = identifierPrefix ? `${identifierPrefix.trim().toUpperCase()}-` : "";
    const byProject = prefix ? "AND substr(UPPER(identifier), 1, ?) = ?" : "";
    const args: Array<string | number> = [...keys];
    if (prefix) args.push(prefix.length, prefix);
    const row = this.db
      .prepare(
        `SELECT issue_id, identifier, title FROM ticket_bindings
         WHERE chat_id IN (${keys.map(() => "?").join(", ")}) ${byProject}
         ORDER BY updated_at DESC, issue_id DESC
         LIMIT 1`,
      )
      .get(...args) as { issue_id: number; identifier: string; title: string | null } | null;
    return row
      ? { issueId: row.issue_id, identifier: row.identifier, title: row.title ?? undefined }
      : null;
  }

  /**
   * Lịch sử binding của chat (mới nhất trước, tối đa `limit` kết quả), phục vụ tìm
   * các ticket đang mở khác trong chat (B8).
   */
  listBindingsForChat(
    chatId: string,
    limit = 8,
    identifierPrefix?: string,
  ): Array<{ issueId: number; identifier: string; title?: string }> {
    const keys = chatIdVariants(chatId);
    const prefix = identifierPrefix ? `${identifierPrefix.trim().toUpperCase()}-` : "";
    const byProject = prefix ? "AND substr(UPPER(identifier), 1, ?) = ?" : "";
    const args: Array<string | number> = [...keys];
    if (prefix) args.push(prefix.length, prefix);
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT issue_id, identifier, title FROM ticket_bindings
         WHERE chat_id IN (${keys.map(() => "?").join(", ")}) ${byProject}
         ORDER BY updated_at DESC, issue_id DESC
         LIMIT ?`,
      )
      .all(...args) as Array<{ issue_id: number; identifier: string; title: string | null }>;
    return rows.map((r) => ({
      issueId: r.issue_id,
      identifier: r.identifier,
      title: r.title ?? undefined,
    }));
  }

  /**
   * Ticket mới nhất của một NGƯỜI BÁO theo user id (khóa định danh bền, độc lập
   * chat). Trả null khi id rỗng hoặc chưa có binding nào mang id đó — binding cũ
   * (trước khi lib lưu id) có `reporter_user_id` NULL nên không khớp, đúng ý:
   * chỉ tra được theo id khi id đã được ghi.
   */
  getLatestBindingByUserId(
    reporterUserId: string,
    identifierPrefix?: string,
  ): { issueId: number; identifier: string; title?: string } | null {
    const id = normalizeUserId(reporterUserId);
    if (!id || !this.supportsReporterUserId) return null;
    const prefix = identifierPrefix ? `${identifierPrefix.trim().toUpperCase()}-` : "";
    const byProject = prefix ? "AND substr(UPPER(identifier), 1, ?) = ?" : "";
    const args: Array<string | number> = [id];
    if (prefix) args.push(prefix.length, prefix);
    const row = this.db
      .prepare(
        `SELECT issue_id, identifier, title FROM ticket_bindings
         WHERE reporter_user_id = ? ${byProject}
         ORDER BY updated_at DESC, issue_id DESC
         LIMIT 1`,
      )
      .get(...args) as { issue_id: number; identifier: string; title: string | null } | null;
    return row
      ? { issueId: row.issue_id, identifier: row.identifier, title: row.title ?? undefined }
      : null;
  }

  /**
   * Đổi tài khoản (A1): chuyển mọi binding gắn `oldUserId` sang `newUserId`.
   * Chỉ chạy khi cả hai id hợp lệ và khác nhau. Trả số dòng đã chuyển. Giữ
   * nguyên chat_id (tin mới sẽ cập nhật chat), chỉ đổi khóa định danh người.
   */
  rebindReporterUserId(oldUserId: string, newUserId: string): number {
    const from = normalizeUserId(oldUserId);
    const to = normalizeUserId(newUserId);
    if (!from || !to || from === to || !this.supportsReporterUserId) return 0;
    return this.db
      .prepare(
        `UPDATE ticket_bindings SET reporter_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE reporter_user_id = ?`,
      )
      .run(to, from).changes;
  }
}
