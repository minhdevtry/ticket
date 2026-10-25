/**
 * Đường VÀO của người báo: nút "Đã ổn" và trả lời tự do, đi qua server webhook thật của bot
 * (`/internal/reporter-ok`, `/internal/reporter-reply` chỉ loopback; `/telegram-webhook` có secret).
 * Trước đây nút được gắn mà không có đường nào nhận lần bấm.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHAT, type Harness, RESOLVED, DONE, harness, stateChanged, until } from "./testkit";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.stop());

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Ticket đã bind vào CHAT, vừa sang Resolved (có tin thông báo + route). */
async function resolvedTicket(env: Record<string, string> = {}, appOptions = {}) {
  const issue = h.fake.addIssue({ title: "Không vào được app", columnId: 3 });
  const { app, bot } = h.boot({ env, appOptions, webhook: true });
  app.services().bindingStore.saveBinding({
    issueId: issue.id,
    chatId: CHAT,
    identifier: issue.identifier,
    title: issue.title,
  });
  await bot.start();
  h.fake.issues[0]!.columnId = RESOLVED.id;
  await bot.handleEvent(stateChanged(issue, RESOLVED));
  return { issue, app, bot, port: bot.addresses().webhook!.port };
}

const noWrites = () => expect(h.fake.count(/^(PATCH|PUT|DELETE) /)).toBe(0);

describe("đường /internal (plugin cùng máy gọi)", () => {
  test("bấm Đã ổn: ghi MỘT comment, bấm lại không ghi thêm, ticket vẫn Resolved", async () => {
    const { issue, port } = await resolvedTicket();
    const body = { issueId: issue.id, chatId: CHAT, userName: "Anh Minh" };

    const first = (await (await post(port, "/internal/reporter-ok", body)).json()) as any;
    expect(first.outcome).toBe("recorded");
    expect(first.replyText).toContain("ghi nhận");
    const again = (await (await post(port, "/internal/reporter-ok", body)).json()) as any;
    expect(again.outcome).toBe("already_recorded");

    const ok = h.fake.comments.filter((c) => c.body.includes("phản hồi: đã ổn"));
    expect(ok).toHaveLength(1);
    expect(ok[0]!.body).toContain("Anh Minh");
    expect(h.fake.issues[0]!.columnId).toBe(RESOLVED.id);
    noWrites();
  });

  test("nút của chat lạ bị từ chối, không ghi gì", async () => {
    const { issue, port } = await resolvedTicket();
    const res = (await (
      await post(port, "/internal/reporter-ok", { issueId: issue.id, chatId: "-1000000000009" })
    ).json()) as any;
    expect(res.outcome).toBe("not_bound");
    expect(h.fake.comments).toHaveLength(0);
  });

  test("trả lời tự do vào tin thông báo: thành MỘT comment (đã escape), không đổi cột; giao lại không ghi đôi", async () => {
    const { issue, port } = await resolvedTicket();
    const stateMsg = h.channelLog().find((r) => r.kind === "state")!;
    const body = {
      chatId: CHAT,
      replyToMessageId: stateMsg.messageId,
      text: "chưa ổn ạ, vẫn lỗi <script>",
      senderName: "An",
    };
    const res = (await (await post(port, "/internal/reporter-reply", body)).json()) as any;
    expect(res).toMatchObject({ handled: true, outcome: "recorded" });
    expect(res.replyText).toContain(issue.identifier);
    await post(port, "/internal/reporter-reply", body);

    const mine = h.fake.comments.filter((c) => c.issueId === issue.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain("**An** phản hồi: chưa ổn ạ, vẫn lỗi &lt;script&gt;");
    expect(h.fake.issues[0]!.columnId).toBe(RESOLVED.id);
    noWrites();
  });

  test("trả lời vào tin không phải tin thông báo: handled false, không comment", async () => {
    const { port } = await resolvedTicket();
    const res = (await (
      await post(port, "/internal/reporter-reply", {
        chatId: CHAT,
        replyToMessageId: "999999",
        text: "xin chào",
      })
    ).json()) as any;
    expect(res.handled).toBe(false);
    expect(h.fake.comments).toHaveLength(0);
  });

  test("ticket đã hoàn tất: trả lời bị từ chối và hướng dẫn tạo ticket mới", async () => {
    const { issue, bot, port } = await resolvedTicket();
    const stateMsg = h.channelLog().find((r) => r.kind === "state")!;
    h.fake.issues[0]!.columnId = DONE.id;
    await bot.handleEvent(stateChanged(issue, DONE));
    const res = (await (
      await post(port, "/internal/reporter-reply", {
        chatId: CHAT,
        replyToMessageId: stateMsg.messageId,
        text: "vẫn lỗi",
      })
    ).json()) as any;
    expect(res).toMatchObject({ handled: true, outcome: "closed" });
    expect(res.replyText).toContain("tạo ticket mới");
    expect(h.fake.comments).toHaveLength(0);
  });
});

describe("chế độ Telegram webhook (callback_query + reply)", () => {
  const SECRET = "tg-secret-for-tests";
  const TG = {
    TELEGRAM_BOT_TOKEN: "123456:fake-token",
    TIEULINH_ONCALL_CHAT_ID: "-1000000000009",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
  };
  const calls: Array<{ method: string; payload: any }> = [];
  let nextId = 100;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, payload: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }), {
      headers: { "content-type": "application/json" },
    });
  }) as never;
  beforeEach(() => {
    calls.length = 0;
    nextId = 100;
  });
  const tgOptions = { telegram: { fetch: fakeFetch, maxRetries: 0 } };
  const hook = (port: number, update: unknown, secret: string | null = SECRET) =>
    post(
      port,
      "/telegram-webhook",
      update,
      secret ? { "x-telegram-bot-api-secret-token": secret } : {},
    );

  test("tin Resolved có nút; người báo bấm nút: ghi comment, bot trả lời và gỡ nút, không đổi cột", async () => {
    const { issue, port } = await resolvedTicket(TG, tgOptions);
    const sentState = calls.find((c) => c.method === "sendMessage")!;
    expect(JSON.stringify(sentState.payload.reply_markup)).toContain(`reporter_ok:${issue.id}`);

    const res = await hook(port, {
      update_id: 1,
      callback_query: {
        id: "cbq-1",
        data: `reporter_ok:${issue.id}`,
        from: { first_name: "Anh Minh" },
        message: { message_id: 100, chat: { id: Number(CHAT) } },
      },
    });
    expect(res.status).toBe(200);
    await until(() => h.fake.comments.length === 1);
    await until(() => calls.some((c) => c.method === "answerCallbackQuery"));
    expect(h.fake.comments[0]!.body).toContain("Anh Minh");
    expect(h.fake.issues[0]!.columnId).toBe(RESOLVED.id);
    noWrites();
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("editMessageReplyMarkup");
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(2); // tin Resolved + lời xác nhận
  });

  test("người báo trả lời tự do vào tin thông báo: thành comment, bot nói lại vào đúng tin", async () => {
    const { issue, port } = await resolvedTicket(TG, tgOptions);
    const notified = calls.find((c) => c.method === "sendMessage")!;
    expect(notified).toBeTruthy();
    await hook(port, {
      update_id: 2,
      message: {
        message_id: 555,
        text: "chưa ổn ạ",
        chat: { id: Number(CHAT) },
        from: { first_name: "An" },
        reply_to_message: { message_id: 100 },
      },
    });
    await until(() => h.fake.comments.length === 1);
    expect(h.fake.comments[0]!.body).toContain("**An** phản hồi: chưa ổn ạ");
    expect(h.fake.comments[0]!.issueId).toBe(issue.id);
    await until(() => calls.filter((c) => c.method === "sendMessage").length === 2);
    const ack = calls.filter((c) => c.method === "sendMessage")[1]!;
    expect(ack.payload).toMatchObject({ chat_id: Number(CHAT), reply_to_message_id: 555 });
    noWrites();
  });

  test("sai hoặc thiếu secret_token: 401, không ghi gì", async () => {
    const { issue, port } = await resolvedTicket(TG, tgOptions);
    const update = {
      update_id: 3,
      callback_query: { id: "x", data: `reporter_ok:${issue.id}`, message: { chat: { id: 1 } } },
    };
    expect((await hook(port, update, "sai")).status).toBe(401);
    expect((await hook(port, update, null)).status).toBe(401);
    expect(h.fake.comments).toHaveLength(0);
  });
});
