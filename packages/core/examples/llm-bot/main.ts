import { createBot, runBot } from "@vuihoc/bot-core/bot";
import bot from "./bot";

// Env truyền tường minh; thiếu hoặc cấu hình LLM dở dang (chỉ đặt một phần LLM_*) thì dừng với lỗi gom đủ.
await runBot(createBot(bot, { env: process.env, envFile: ".env" }));
