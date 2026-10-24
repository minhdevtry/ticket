/**
 * Chạy trước mọi file test (bunfig.toml → [test].preload).
 *
 * Bun tự nạp `apps/tieulinh/.env` cả khi `bun test` — tức test chạy với token bot
 * Telegram, ADMIN_IDS, key Itsaplan/Onyx/LLM THẬT. Test mô phỏng lỗi gọi
 * `alertAdmin` là nhắn thật cho admin; test nào lỡ dựng client từ env là gọi
 * dịch vụ thật (24/09: đổi OPENAI_MODEL sang model sống thì test chậm/timeout
 * lung tung). Xoá sạch các biến gửi ra ngoài.
 *
 * Memgraph: KHÔNG BAO GIỜ dùng MEMGRAPH_URI của .env — 25/09 một lượt `bun test`
 * trên server đã ghi 19 node TEST-KG-* vào KG TECH thật. Test graph chỉ chạy khi
 * đặt MEMGRAPH_TEST_URI trỏ vào một Memgraph thử riêng, ví dụ
 *   docker run -d --rm --name memgraph-test -p 17687:7687 memgraph/memgraph-platform
 *   MEMGRAPH_TEST_URI=bolt://localhost:17687 bun test lib/kg
 *
 * Test LLM thật (RUN_LIVE_LLM=1) giữ biến OPENAI_* để chạy được.
 */
const OUTBOUND =
  /^(TELEGRAM_|ADMIN_IDS$|ALERT_CHAT_ID$|TICKET_ADMIN|ITSAPLAN_|ONYX_|WEBHOOK_URL$|KG_MCP_API_KEY$)/;
const LLM = /^OPENAI_/;

for (const key of Object.keys(process.env)) {
  if (OUTBOUND.test(key) || (LLM.test(key) && process.env.RUN_LIVE_LLM !== "1"))
    delete process.env[key];
}

delete process.env.MEMGRAPH_URI;
delete process.env.MEMGRAPH_USER;
delete process.env.MEMGRAPH_PASS;
if (process.env.MEMGRAPH_TEST_URI) process.env.MEMGRAPH_URI = process.env.MEMGRAPH_TEST_URI;
