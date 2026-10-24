import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeToolFailure } from "@vuihoc/bot-core/core";
import "./tool-error";
import { configureAlerts } from "./telegram/alert";

describe("tool-error adapter (nối hook báo admin của Tiểu Linh)", () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<Record<string, unknown>>;

  beforeEach(() => {
    calls = [];
    configureAlerts({ botToken: "test-token", chatId: "42" });
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    configureAlerts(null);
  });

  test("tool lỗi thì kết quả vẫn có cờ loi VÀ quản trị viên được báo qua alertAdmin", async () => {
    const failure = describeToolFailure("create_issue", new Error("Itsaplan 503"));
    expect(failure.loi).toBe(true);
    expect(failure.thong_bao_cho_nguoi_dung).toContain("Itsaplan 503");
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].chat_id).toBe("42");
    expect(String(calls[0].text)).toContain("create_issue");
    expect(String(calls[0].text)).toContain(failure.ma_loi);
  });
});
