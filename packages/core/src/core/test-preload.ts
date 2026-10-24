/**
 * File preload SẴN DÙNG — khai trong `bunfig.toml`:
 *   [test]
 *   preload = ["./node_modules/@vuihoc/bot-core/src/core/test-preload.ts"]
 *
 * Nó dọn đúng bộ biến mà Tiểu Linh/CM dùng (TELEGRAM_, ITSAPLAN_, ONYX_,
 * MEMGRAPH_, OPENAI_, …). Bot có bộ biến khác thì tự viết file preload riêng gọi
 * `scrubOutboundEnv()` với danh sách của mình — xem `test-preload-helper.ts`.
 */
import { scrubOutboundEnv } from "./test-preload-helper";

scrubOutboundEnv({
  outbound: [
    /^TELEGRAM_/,
    /^ADMIN_IDS$/,
    /^ALERT_CHAT_ID$/,
    /^TICKET_ADMIN/,
    /^ITSAPLAN_/,
    /^ONYX_/,
    /^WEBHOOK_URL$/,
    /^KG_MCP_API_KEY$/,
    /^CRM_/,
    /^CM_ITSAPLAN_API_KEY$/,
    /^CM_TELEGRAM_BOT_TOKEN$/,
  ],
  llm: [/^OPENAI_/],
  keepLlmWhen: () => process.env.RUN_LIVE_LLM === "1",
  deleteExact: ["MEMGRAPH_URI", "MEMGRAPH_USER", "MEMGRAPH_PASS"],
  redirect: [{ from: "MEMGRAPH_TEST_URI", to: "MEMGRAPH_URI" }],
});
