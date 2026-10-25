import { describe, expect, it } from "bun:test";
import type { ReporterOkResult, ReporterReplyResult } from "../backoffice";
import { createReporterInbound } from "./reporter-inbound";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup(
  over: {
    ok?: () => Promise<ReporterOkResult>;
    reply?: () => Promise<ReporterReplyResult>;
    noTransport?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const seen: { ok: unknown[]; reply: unknown[] } = { ok: [], reply: [] };
  const inbound = createReporterInbound({
    closure: {
      async recordReporterOk(_t, req) {
        seen.ok.push(req);
        return over.ok ? over.ok() : { outcome: "recorded", replyText: "đã ghi nhận" };
      },
      async recordReporterReply(_t, req) {
        seen.reply.push(req);
        return over.reply
          ? over.reply()
          : { handled: true, outcome: "recorded", replyText: "đã chuyển" };
      },
    },
    transport: over.noTransport
      ? undefined
      : {
          async tryCall(method: string, payload: Record<string, unknown>) {
            calls.push({ method, payload });
            return null;
          },
        },
    errorCopy: { ok: "lỗi ok", reply: "lỗi reply" },
  });
  const ctx = { tracker: {} as never, logger: silent };
  return { inbound, ctx, calls, seen };
}

const cbUpdate = (data: string) => ({
  callback_query: {
    id: "cbq1",
    data,
    from: { first_name: "An", username: "an_user" },
    message: { message_id: 77, chat: { id: -1000000000001 } },
  },
});

describe("createReporterInbound.telegramUpdate", () => {
  it("bấm Đã ổn: ghi nhận, dừng vòng quay, gỡ nút, nói lại", async () => {
    const { inbound, ctx, calls, seen } = setup();
    await inbound.telegramUpdate(ctx, cbUpdate("reporter_ok:123"));
    expect(seen.ok).toEqual([{ issueId: 123, chatId: "-1000000000001", userName: "An" }]);
    expect(calls.map((c) => c.method)).toEqual([
      "answerCallbackQuery",
      "editMessageReplyMarkup",
      "sendMessage",
    ]);
    expect(calls[2]!.payload).toMatchObject({ chat_id: -1000000000001, text: "đã ghi nhận" });
  });

  it("tiền tố cũ confirm_done: hiểu như nhau; payload hỏng thì chỉ dừng vòng quay", async () => {
    const a = setup();
    await a.inbound.telegramUpdate(a.ctx, cbUpdate("confirm_done:5"));
    expect(a.seen.ok).toHaveLength(1);
    const b = setup();
    await b.inbound.telegramUpdate(b.ctx, cbUpdate("reporter_ok:abc"));
    expect(b.seen.ok).toHaveLength(0);
    expect(b.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });

  it("không gỡ nút khi ticket đã hoàn tất/mở lại, và lỗi ghi vẫn trả lời người bấm", async () => {
    const a = setup({ ok: async () => ({ outcome: "done", replyText: "xong rồi" }) });
    await a.inbound.telegramUpdate(a.ctx, cbUpdate("reporter_ok:1"));
    expect(a.calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
    const b = setup({
      ok: async () => {
        throw new Error("itsaplan hỏng");
      },
    });
    await b.inbound.telegramUpdate(b.ctx, cbUpdate("reporter_ok:1"));
    expect(b.calls.at(-1)!.payload.text).toBe("lỗi ok");
  });

  it("trả lời tự do vào một tin: ghi và nói lại, kèm reply_to_message_id", async () => {
    const { inbound, ctx, calls, seen } = setup();
    await inbound.telegramUpdate(ctx, {
      message: {
        message_id: 90,
        text: " chưa ổn ạ ",
        chat: { id: -1000000000001 },
        from: { first_name: "An" },
        reply_to_message: { message_id: 77 },
      },
    });
    expect(seen.reply).toEqual([
      { chatId: "-1000000000001", messageId: "77", text: "chưa ổn ạ", userName: "An" },
    ]);
    expect(calls).toEqual([
      {
        method: "sendMessage",
        payload: { chat_id: -1000000000001, text: "đã chuyển", reply_to_message_id: 90 },
      },
    ]);
  });

  it("tin thường, lệnh, tin của bot, hoặc reply không khớp route: không nói gì", async () => {
    const { inbound, ctx, calls } = setup({ reply: async () => ({ handled: false }) });
    const base = { message_id: 1, chat: { id: 5 }, from: {}, reply_to_message: { message_id: 2 } };
    await inbound.telegramUpdate(ctx, { message: { ...base, text: "xin chào" } }); // không khớp route
    await inbound.telegramUpdate(ctx, { message: { ...base, text: "/new" } });
    await inbound.telegramUpdate(ctx, { message: { ...base, text: "hi", from: { is_bot: true } } });
    await inbound.telegramUpdate(ctx, { message: { message_id: 1, chat: { id: 5 }, text: "hi" } });
    await inbound.telegramUpdate(ctx, { edited_message: {} });
    await inbound.telegramUpdate(ctx, null);
    expect(calls).toEqual([]);
  });

  it("không có transport: vẫn ghi comment, không ném", async () => {
    const { inbound, ctx, seen } = setup({ noTransport: true });
    await inbound.telegramUpdate(ctx, cbUpdate("reporter_ok:9"));
    expect(seen.ok).toHaveLength(1);
  });
});

describe("createReporterInbound: hai đường /internal", () => {
  it("lỗi ghi trả câu lỗi thay vì ném", async () => {
    const { inbound, ctx } = setup({
      ok: async () => {
        throw new Error("x");
      },
      reply: async () => {
        throw new Error("y");
      },
    });
    expect(await inbound.reporterOk(ctx, { issueId: 1, chatId: "1", userName: "A" })).toEqual({
      outcome: "error",
      replyText: "lỗi ok",
    });
    expect(
      await inbound.reporterReply(ctx, { chatId: "1", messageId: "2", text: "t", userName: "A" }),
    ).toEqual({ handled: true, outcome: "error", replyText: "lỗi reply" });
  });
});
