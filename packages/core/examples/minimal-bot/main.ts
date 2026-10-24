import { createBot, runBot } from "@vuihoc/bot-core/bot";
import bot from "./bot";

// Env truyền tường minh; `.env` chỉ đọc khi có `envFile`. Thiếu biến thì dừng với lỗi gom đủ.
await runBot(createBot(bot, { env: process.env, envFile: ".env" }));
