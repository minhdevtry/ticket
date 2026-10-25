/**
 * Env riêng của Tiểu Linh 2 (hậu cần). Biến của bộ kit (`ITSAPLAN_*`, `LLM_*`, `BOT_*`) do
 * `createBot` đọc; ở đây chỉ khai biến của ứng dụng. `BOT_DATA_DIR` khai lại thành BẮT BUỘC: kho
 * liên kết người báo, dấu "đã nhắc" và nhật ký kênh phải sống qua restart.
 *
 * Bảng tra: `docs/reference/config-env.md` (mục "Tiểu Linh mới").
 */
import { defineEnv, secret } from "@vuihoc/bot-core/core";
import { z } from "zod";

/** Username của agent trên itsaplan (không có @). */
export const AGENT_USERNAME = "tieulinh2";

export const tieulinhEnv = defineEnv({
  BOT_DATA_DIR: z.string().min(1),
  TIEULINH_TEAM: z.string().min(1).default("tech"),
  TIEULINH_PROJECT: z.string().min(1).default("TECH2"),
  TELEGRAM_BOT_TOKEN: secret(z.string().min(1).optional()),
  TIEULINH_ONCALL_CHAT_ID: z.string().min(1).optional(),
  TIEULINH_COMMENT_FORWARD: z.enum(["all", "mention"]).default("all"),
  TIEULINH_DUPLICATE_MERGE: z.stringbool().default(false),
  TIEULINH_SANDBOX_CHAT: z.string().min(1).optional(),
  TIEULINH_SLA_CRON: z.string().min(1).default("*/5 * * * *"),
});

export type TieulinhConfig = {
  [K in keyof typeof tieulinhEnv.shape]: z.output<(typeof tieulinhEnv.shape)[K]>;
};
