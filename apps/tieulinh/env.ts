/**
 * Env riêng của Tiểu Linh 2 (hậu cần). Biến của bộ kit (`ITSAPLAN_*`, `LLM_*`, `BOT_*`) do
 * `createBot` đọc; ở đây chỉ khai biến của ứng dụng. `BOT_DATA_DIR` khai lại thành BẮT BUỘC: kho
 * liên kết người báo, dấu "đã nhắc" và nhật ký kênh phải sống qua restart.
 *
 * Bảng tra: `docs/reference/config-env.md` (mục "Tiểu Linh mới").
 */
import { type ConfigIssue, ConfigError, defineEnv, secret } from "@vuihoc/bot-core/core";
import { z } from "zod";

export const tieulinhEnv = defineEnv({
  BOT_DATA_DIR: z.string().min(1),
  TIEULINH_TEAM: z.string().min(1).default("tech"),
  TIEULINH_PROJECT: z.string().min(1).default("TECH2"),
  /**
   * Username của agent trên itsaplan (không có @): tên được gỡ khỏi comment @mention và comment do
   * chính agent viết bị coi là tiếng vọng. Phải khớp user của `ITSAPLAN_AGENT_KEY`.
   */
  TIEULINH_AGENT: z
    .string()
    .min(1)
    .transform((v) => v.replace(/^@+/, "").trim())
    .pipe(z.string().min(1))
    .default("tieulinh2"),
  /** Gốc link web của itsaplan, để đặt link ticket vào thông báo (không đặt thì không có link). */
  ITSAPLAN_WEB_URL: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: secret(z.string().min(1).optional()),
  TIEULINH_ONCALL_CHAT_ID: z.string().min(1).optional(),
  TIEULINH_COMMENT_FORWARD: z.enum(["all", "mention"]).default("all"),
  TIEULINH_DUPLICATE_MERGE: z.stringbool().default(false),
  TIEULINH_SANDBOX_CHAT: z.string().min(1).optional(),
  /**
   * Đường dẫn file SQLite dạng legacy (của Tiểu Linh 1) để dùng chung binding và tuyến tin với TL1 trong lúc canary
   * (RFC 0002 mục 6.2). Không đặt: binding nằm trong `tieulinh-app.sqlite` như mọi khi.
   */
  TIEULINH_BINDING_DB: z.string().min(1).optional(),
  TIEULINH_SLA_CRON: z.string().min(1).default("*/5 * * * *"),
  /** Công tắc chính sách soát thông tin trước khi tạo ticket (F4). */
  TECH_INFO_REVIEW: z.enum(["off", "checklist", "llm"]).default("checklist"),
  /** Đường dẫn file SQLite chứa dữ liệu tự học cho reviewer dạng checklist (F3). */
  ASK_LEARN_DB: z.string().min(1).optional(),
});

/**
 * Kiểm tra chéo giữa các biến (schema từng biến không làm được): có token Telegram thì PHẢI có chat
 * trực ca, nếu không cảnh báo SLA chỉ nằm trong log mà bị tính là đã gửi.
 */
export function assertTieulinhConfig(config: TieulinhConfig): void {
  const issues: ConfigIssue[] = [];
  if (config.TELEGRAM_BOT_TOKEN && !config.TIEULINH_ONCALL_CHAT_ID) {
    issues.push({
      name: "TIEULINH_ONCALL_CHAT_ID",
      kind: "missing",
      message: "bắt buộc khi đặt TELEGRAM_BOT_TOKEN (chat nhận cảnh báo SLA trực ca)",
    });
  }
  if (issues.length > 0) throw new ConfigError(issues, "tieulinh");
}

export type TieulinhConfig = {
  [K in keyof typeof tieulinhEnv.shape]: z.output<(typeof tieulinhEnv.shape)[K]>;
};
