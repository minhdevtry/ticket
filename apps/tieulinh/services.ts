/**
 * Dịch vụ bền của Tiểu Linh 2: một file SQLite riêng của ứng dụng (`<BOT_DATA_DIR>/tieulinh-app.sqlite`,
 * thư mục 0700, file 0600) chứa liên kết ticket-người báo, tuyến tin nhắn, trạng thái vòng đời,
 * khoá chống trùng và `app_kv`; cộng kênh gửi tin (Telegram khi có token, không thì nhật ký JSONL).
 *
 * Dấu "đã làm rồi" (đã chuyển comment, đã nhắc SLA) KHÔNG nằm đây mà ở `ctx.keys(...)` của bot kit
 * (bền trong kho của kit khi có `BOT_DATA_DIR`); `app_kv` chỉ còn giữ mốc `sla:since`.
 *
 * Tuỳ chọn `TIEULINH_BINDING_DB` trỏ riêng hai bảng `ticket_bindings` và `message_routes` sang một file dạng legacy
 * (file của Tiểu Linh 1, RFC 0002 mục 6.2) để TL1 hậu cần vẫn báo người báo cho ticket do lễ tân TL2 tạo. Chỉ hai bảng
 * đó đi theo; trạng thái vòng đời, `app_kv` và mọi thứ khác vẫn ở `tieulinh-app.sqlite`. Mặc định (không đặt) không đổi.
 *
 * File này tách khỏi kho của bộ kit (`<BOT_DATA_DIR>/<bot.id>.sqlite`: ledger run, cron, hẹn giờ) vì
 * binding và route là dữ liệu NGHIỆP VỤ mà lễ tân (sau này) cũng ghi vào.
 */
import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { TicketClosure } from "@vuihoc/bot-core/backoffice";
import { openPrivateDb } from "@vuihoc/bot-core/core";
import {
  type ChannelPort,
  type Clock,
  LogChannel,
  NotificationDispatcher,
  SqliteChannelBindingStore,
  SqliteMessageRouteStore,
  SqliteNotifyBindingReader,
  SqliteTicketStateStore,
  intakeApplySchema,
  notifyApplySchema,
  openLegacyBindingDb,
  systemClock,
} from "@vuihoc/bot-core/intake";
import {
  TelegramNotifyChannel,
  TelegramTransport,
  type TelegramTransportOptions,
} from "@vuihoc/bot-core/telegram";
import {
  REPORTER_OK_LABEL,
  reporterOkCallback,
  reporterOkCopy,
  reporterReplyCopy,
  stateCopy,
  vnTime,
} from "./copy";
import { type TieulinhConfig, assertTieulinhConfig } from "./env";

export const APP_DB_FILE = "tieulinh-app.sqlite";
export const CHANNEL_LOG_FILE = "tieulinh-channel.jsonl";

export const SLA_SINCE_KEY = "sla:since";

/** Tên và hạn của tập khoá chống trùng (`ctx.keys`): 90 ngày, như bản legacy. */
export const FORWARD_KEYS = "forwarded";
export const SLA_ALERTED_KEYS = "sla-alerted";
export const KEYS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Tuỳ chọn tiêm cho test: kênh dựng sẵn, đồng hồ. */
export interface ServiceOptions {
  clock?: Clock;
  /** Dùng kênh này thay cho lựa chọn theo env (test). */
  channel?: ChannelPort;
  /** Tuỳ chọn cho `TelegramTransport` (test: `fetch`/`baseUrl` giả). Chỉ dùng khi có token. */
  telegram?: Omit<TelegramTransportOptions, "botToken">;
}

function appSchema(db: Database, opts: { wal: boolean }): void {
  intakeApplySchema(db, opts);
  notifyApplySchema(db, opts);
  db.run("CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

export class TieulinhServices {
  readonly db: Database;
  /**
   * Kho của binding và tuyến tin: chính `db` (mặc định) hoặc file dạng legacy khi đặt `TIEULINH_BINDING_DB`.
   * File legacy do TL1 sở hữu nên chỉ được đọc/ghi hai bảng đó, không bao giờ áp schema core lên đó.
   */
  readonly bindingDb: Database;
  readonly clock: Clock;
  readonly channel: ChannelPort;
  readonly bindingStore: SqliteChannelBindingStore;
  readonly bindings: SqliteNotifyBindingReader;
  readonly routes: SqliteMessageRouteStore;
  readonly closure: TicketClosure;
  readonly dispatcher: NotificationDispatcher;
  /** Có khi chạy bằng Telegram (có token và không bị tiêm kênh khác): để bot nói lại với người báo. */
  readonly transport: TelegramTransport | undefined;

  constructor(
    readonly config: TieulinhConfig,
    options: ServiceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    const dir = resolve(config.BOT_DATA_DIR);
    this.db = openPrivateDb(join(dir, APP_DB_FILE), appSchema);
    assertTieulinhConfig(config);
    try {
      this.bindingDb = config.TIEULINH_BINDING_DB
        ? openLegacyBindingDb(config.TIEULINH_BINDING_DB)
        : this.db;
    } catch (err) {
      this.db.close(); // file binding sai dạng/không mở được: dừng to, không để lộ nửa chừng
      throw err;
    }
    this.bindingStore = new SqliteChannelBindingStore(
      this.bindingDb,
      config.TIEULINH_BINDING_DB ? { schema: "legacy" } : undefined,
    );
    this.bindings = new SqliteNotifyBindingReader(this.bindingDb);
    this.routes = new SqliteMessageRouteStore(this.bindingDb);
    this.transport =
      !options.channel && config.TELEGRAM_BOT_TOKEN
        ? new TelegramTransport({ botToken: config.TELEGRAM_BOT_TOKEN, ...options.telegram })
        : undefined;
    this.channel =
      options.channel ??
      (this.transport
        ? new TelegramNotifyChannel({
            transport: this.transport,
            reporterOkButton: { label: REPORTER_OK_LABEL, callbackData: reporterOkCallback },
            alertChatId: config.TIEULINH_ONCALL_CHAT_ID,
          })
        : new LogChannel({ file: join(dir, CHANNEL_LOG_FILE), clock: this.clock }));
    // Mốc bắt đầu theo dõi SLA: ghi đúng một lần, ticket tạo trước mốc này không bao giờ bị nhắc.
    if (this.kvGet(SLA_SINCE_KEY) === null) this.kvSet(SLA_SINCE_KEY, String(this.clock.now()));
    this.closure = new TicketClosure({
      states: new SqliteTicketStateStore(this.db),
      bindings: this.bindings,
      routes: this.routes,
      channel: this.channel,
      copy: stateCopy,
      okCopy: reporterOkCopy,
      replyCopy: reporterReplyCopy,
      clock: this.clock,
      formatTime: vnTime,
    });
    this.dispatcher = new NotificationDispatcher({
      bindings: this.bindings,
      routes: this.routes,
      channel: this.channel,
      copy: stateCopy,
      projectKey: config.TIEULINH_PROJECT,
      agentHandles: [config.TIEULINH_AGENT],
      webUrl: config.ITSAPLAN_WEB_URL,
      commentForwardPolicy: config.TIEULINH_COMMENT_FORWARD,
    });
  }

  kvGet(key: string): string | null {
    const row = this.db.query("SELECT value FROM app_kv WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row ? row.value : null;
  }

  kvSet(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO app_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * Chế độ sandbox (`TIEULINH_SANDBOX_CHAT`): ticket chưa có liên kết người báo (TECH2 được tạo
   * thẳng trên itsaplan, lễ tân chưa chạy) được gắn vào chat thử, để kênh nhật ký có gì mà xem.
   * Không đặt biến này thì ticket không liên kết bị bỏ qua (đúng hành vi cũ). Trả `true` nếu sau
   * lời gọi ticket có liên kết.
   */
  ensureBinding(issue: { id: number; identifier: string; title?: string }): boolean {
    if (this.bindings.getBindingByIssueId(issue.id)) return true;
    const chat = this.config.TIEULINH_SANDBOX_CHAT;
    if (!chat) return false;
    this.bindingStore.saveBinding({
      issueId: issue.id,
      chatId: chat,
      identifier: issue.identifier,
      title: issue.title,
    });
    return true;
  }

  close(): void {
    for (const db of new Set([this.db, this.bindingDb])) {
      try {
        db.close();
      } catch {
        // đã đóng
      }
    }
  }
}
