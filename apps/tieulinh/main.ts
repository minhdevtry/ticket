/**
 * Chạy Tiểu Linh 2 (hậu cần): `bun run apps/tieulinh/main.ts`.
 *
 * Env bắt buộc: `ITSAPLAN_BASE_URL`, `ITSAPLAN_AGENT_KEY`, `BOT_DATA_DIR`. Tuỳ chọn: `LLM_*`,
 * `TELEGRAM_BOT_TOKEN`, `TIEULINH_*`, `BOT_WEBHOOK_PORT`... Bảng đầy đủ: `docs/reference/config-env.md`.
 * Thiếu hoặc sai cấu hình thì dừng ngay với lỗi gom đủ.
 */
import { createBot, runBot } from "@vuihoc/bot-core/bot";
import { tieulinhBot } from "./bot";

const envFile = ".env";
const app = tieulinhBot(process.env, { envFile });
try {
  await runBot(createBot(app.bot, { env: process.env, envFile }));
} finally {
  app.close();
}
