import { describe, expect, it } from "bun:test";
import { scrubOutboundEnv } from "./test-preload-helper";

/**
 * intake `test-preload.ts` không có test (nó LÀ chốt an toàn, chạy trước test
 * khác). Lõi tách nó thành hàm `scrubOutboundEnv` nên hàm cần test: xoá đúng
 * biến gọi ra ngoài, giữ/bỏ LLM theo điều kiện, chuyển hướng MEMGRAPH_TEST_URI.
 * Mọi test chạy trên một map env RIÊNG, không đụng `process.env`.
 */
describe("scrubOutboundEnv", () => {
  it("xoá biến khớp tiền tố chuỗi và RegExp, giữ biến khác; trả danh sách tên", () => {
    const env: Record<string, string | undefined> = {
      TELEGRAM_BOT_TOKEN: "x",
      ITSAPLAN_API_KEY: "y",
      ADMIN_IDS: "1",
      SAFE_VAR: "keep",
    };
    const removed = scrubOutboundEnv({
      outbound: ["TELEGRAM_", /^ITSAPLAN_/, /^ADMIN_IDS$/],
      env,
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.ITSAPLAN_API_KEY).toBeUndefined();
    expect(env.ADMIN_IDS).toBeUndefined();
    expect(env.SAFE_VAR).toBe("keep");
    expect(removed.sort()).toEqual(["ADMIN_IDS", "ITSAPLAN_API_KEY", "TELEGRAM_BOT_TOKEN"]);
  });

  it("xoá LLM khi keepLlmWhen=false, giữ khi true", () => {
    const strip: Record<string, string | undefined> = { OPENAI_API_KEY: "x" };
    scrubOutboundEnv({ outbound: [], llm: [/^OPENAI_/], keepLlmWhen: () => false, env: strip });
    expect(strip.OPENAI_API_KEY).toBeUndefined();

    const keep: Record<string, string | undefined> = { OPENAI_API_KEY: "x" };
    scrubOutboundEnv({ outbound: [], llm: [/^OPENAI_/], keepLlmWhen: () => true, env: keep });
    expect(keep.OPENAI_API_KEY).toBe("x");
  });

  it("deleteExact xoá không điều kiện; redirect gán _TEST_URI → URI sau khi đã xoá", () => {
    const env: Record<string, string | undefined> = {
      MEMGRAPH_URI: "bolt://prod",
      MEMGRAPH_TEST_URI: "bolt://test",
    };
    scrubOutboundEnv({
      outbound: [],
      deleteExact: ["MEMGRAPH_URI", "MEMGRAPH_USER", "MEMGRAPH_PASS"],
      redirect: [{ from: "MEMGRAPH_TEST_URI", to: "MEMGRAPH_URI" }],
      env,
    });
    expect(env.MEMGRAPH_URI).toBe("bolt://test");
    expect(env.MEMGRAPH_TEST_URI).toBeUndefined();
  });

  it("không có MEMGRAPH_TEST_URI → MEMGRAPH_URI vẫn bị xoá, không được gán lại", () => {
    const env: Record<string, string | undefined> = { MEMGRAPH_URI: "bolt://prod" };
    scrubOutboundEnv({
      outbound: [],
      deleteExact: ["MEMGRAPH_URI"],
      redirect: [{ from: "MEMGRAPH_TEST_URI", to: "MEMGRAPH_URI" }],
      env,
    });
    expect(env.MEMGRAPH_URI).toBeUndefined();
  });
});
