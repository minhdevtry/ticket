import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ItsaplanWebhookServer, type ItsaplanWebhookServerOptions } from "./webhook-server";

const servers: ItsaplanWebhookServer[] = [];

async function startServer(options: ItsaplanWebhookServerOptions = {}) {
  const server = new ItsaplanWebhookServer(options);
  const onEvent = mock(async () => {});
  const onTelegram = mock(async () => {});
  server.onEvent(onEvent);
  server.onTelegramUpdate(onTelegram);
  await server.start(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.port()}`;
  return { server, onEvent, onTelegram, base };
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

// Đúng thuật toán của Itsaplan (apps/worker/src/signature.ts): HMAC-SHA256 trên
// `${ts}.${body}`, header `X-Itsaplan-Signature: t=<ts>,v1=<hex>`.
function sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${digest}`;
}

function envelope(event: string, data: Record<string, unknown>, webhookTimestamp?: number): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    event,
    data,
    createdAt: "",
    webhookTimestamp,
  });
}

describe("ItsaplanWebhookServer — giới hạn body", () => {
  test("body quá giới hạn trả 413 và không gọi handler", async () => {
    const { base, onEvent, onTelegram } = await startServer({ maxBodyBytes: 1024 });
    const big = JSON.stringify({ pad: "x".repeat(4096) });

    const r1 = await fetch(`${base}/webhook`, { method: "POST", body: big });
    const r2 = await fetch(`${base}/telegram-webhook`, { method: "POST", body: big });

    expect(r1.status).toBe(413);
    expect(r2.status).toBe(413);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onTelegram).not.toHaveBeenCalled();
  });
});

describe("ItsaplanWebhookServer — chữ ký Itsaplan", () => {
  const secret = "whsec_test";

  test("có cấu hình secret: thiếu chữ ký → 401", async () => {
    const { base, onEvent } = await startServer({ itsaplanSecrets: [secret] });
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      body: envelope("issue.updated", { id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("chữ ký sai hoặc quá hạn → 401; đúng → 200 và gọi handler", async () => {
    const { base, onEvent } = await startServer({ itsaplanSecrets: [secret] });
    const body = envelope("issue.updated", { id: 1 }, 111);

    const wrong = await fetch(`${base}/webhook`, {
      method: "POST",
      body,
      headers: { "X-Itsaplan-Signature": sign("khac", body) },
    });
    const stale = await fetch(`${base}/webhook`, {
      method: "POST",
      body,
      headers: { "X-Itsaplan-Signature": sign(secret, body, Math.floor(Date.now() / 1000) - 3600) },
    });
    const ok = await fetch(`${base}/webhook?x=1`, {
      method: "POST",
      body,
      headers: { "X-Itsaplan-Signature": sign(secret, body) },
    });

    expect(wrong.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(ok.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test("không cấu hình secret: giữ hành vi cũ (nhận không cần chữ ký)", async () => {
    const { base, onEvent } = await startServer();
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      body: envelope("issue.updated", { id: 1 }),
    });
    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe("ItsaplanWebhookServer — secret Telegram", () => {
  test("có TELEGRAM secret: thiếu/sai header → 401, đúng → 200", async () => {
    const { base, onTelegram } = await startServer({ telegramSecret: "tg-secret" });
    const body = JSON.stringify({ update_id: 1 });

    const missing = await fetch(`${base}/telegram-webhook`, { method: "POST", body });
    const wrong = await fetch(`${base}/telegram-webhook`, {
      method: "POST",
      body,
      headers: { "X-Telegram-Bot-Api-Secret-Token": "sai" },
    });
    const ok = await fetch(`${base}/telegram-webhook`, {
      method: "POST",
      body,
      headers: { "X-Telegram-Bot-Api-Secret-Token": "tg-secret" },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(ok.status).toBe(200);
    expect(onTelegram).toHaveBeenCalledTimes(1);
  });
});

describe("ItsaplanWebhookServer — chống trùng", () => {
  // Chỉ theo webhookTimestamp thì hai sự kiện khác nhau cùng mili-giây (hai issue
  // đổi trạng thái trong một lần kéo thả) bị coi là trùng và rơi mất một cái.
  test("cùng webhookTimestamp nhưng khác issue/sự kiện vẫn xử lý; trùng hẳn thì bỏ", async () => {
    const { base, onEvent } = await startServer();
    const post = (body: string) => fetch(`${base}/webhook`, { method: "POST", body });

    await post(envelope("issue.state_changed", { id: 1 }, 5000));
    await post(envelope("issue.state_changed", { id: 2 }, 5000));
    await post(envelope("comment.created", { issueId: 1, id: 90 }, 5000));
    const dup = await post(envelope("issue.state_changed", { id: 1 }, 5000));

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(await dup.json()).toMatchObject({ duplicate: true });
  });
});

describe("ItsaplanWebhookServer — /internal/reporter-ok (plugin OpenClaw xac-nhan-xong gọi)", () => {
  // Bot chạy qua OpenClaw polling: cú bấm "👍 Đã ổn" rơi vào luồng tin dạng text.
  // Plugin bắt cú bấm rồi gọi endpoint này; chỉ ghi ý kiến, không đóng ticket (ADR-0006).
  test("chuyển issueId + chatId + tên người bấm cho handler, trả câu trả lời của handler", async () => {
    const { server, base } = await startServer();
    const onOk = mock(async (_req: { issueId: number; chatId: string; userName: string }) => ({
      outcome: "recorded" as const,
      replyText: "Dạ em đã ghi nhận",
    }));
    server.onReporterOk(onOk);

    const res = await fetch(`${base}/internal/reporter-ok`, {
      method: "POST",
      body: JSON.stringify({ issueId: 42, chatId: 5551234, userName: "Chị A" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "recorded", replyText: "Dạ em đã ghi nhận" });
    expect(onOk).toHaveBeenCalledWith({ issueId: 42, chatId: "5551234", userName: "Chị A" });
  });

  test("đường cũ /internal/confirm-done (plugin bản trước) vẫn nhận", async () => {
    const { server, base } = await startServer();
    server.onReporterOk(async () => ({ outcome: "done" as const, replyText: "đã hoàn tất rồi" }));
    const res = await fetch(`${base}/internal/confirm-done`, {
      method: "POST",
      body: JSON.stringify({ issueId: 7 }),
    });
    expect(((await res.json()) as any).outcome).toBe("done");
  });

  test("issueId không hợp lệ → 400; chưa gắn handler → 404", async () => {
    const { server, base } = await startServer();
    const noHandler = await fetch(`${base}/internal/reporter-ok`, {
      method: "POST",
      body: '{"issueId":1}',
    });
    expect(noHandler.status).toBe(404);
    server.onReporterOk(async () => ({ outcome: "recorded" as const, replyText: "" }));
    const bad = await fetch(`${base}/internal/reporter-ok`, {
      method: "POST",
      body: '{"issueId":"abc"}',
    });
    expect(bad.status).toBe(400);
  });
});

describe("ItsaplanWebhookServer — /internal/reporter-reply (plugin OpenClaw xac-nhan-xong gọi)", () => {
  // Bot chạy qua OpenClaw polling: reply tự do vào tin thông báo cũng rơi vào
  // luồng tin dạng text (không có update.message.reply_to_message như webhook
  // mode). Plugin bắt reply_to_id trong phong bì rồi gọi endpoint này.
  test("chuyển chatId + replyToMessageId + text + senderName cho handler, trả nguyên kết quả", async () => {
    const { server, base } = await startServer();
    const onReply = mock(
      async (_req: { chatId: string; messageId: string; text: string; userName: string }) => ({
        handled: true as const,
        replyText: "Dạ em đã chuyển phản hồi của anh/chị vào TECH-961 cho đội Kỹ thuật ạ.",
      }),
    );
    server.onReporterReply(onReply);

    const res = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      body: JSON.stringify({
        chatId: 5551234,
        replyToMessageId: 900,
        text: "vẫn chưa được ạ",
        senderName: "Chị A",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      handled: true,
      replyText: "Dạ em đã chuyển phản hồi của anh/chị vào TECH-961 cho đội Kỹ thuật ạ.",
    });
    expect(onReply).toHaveBeenCalledWith({
      chatId: "5551234",
      messageId: "900",
      text: "vẫn chưa được ạ",
      userName: "Chị A",
    });
  });

  test("route không khớp → handler trả handled:false, giữ nguyên", async () => {
    const { server, base } = await startServer();
    server.onReporterReply(async () => ({ handled: false }));
    const res = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      body: JSON.stringify({ chatId: 1, replyToMessageId: 2, text: "chưa ổn ạ" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: false });
  });

  test("thiếu senderName → mặc định 'Người báo'", async () => {
    const { server, base } = await startServer();
    const onReply = mock(async () => ({ handled: false as const }));
    server.onReporterReply(onReply);
    await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      body: JSON.stringify({ chatId: 1, replyToMessageId: 2, text: "chưa ổn ạ" }),
    });
    expect(onReply).toHaveBeenCalledWith({
      chatId: "1",
      messageId: "2",
      text: "chưa ổn ạ",
      userName: "Người báo",
    });
  });

  test("thiếu chatId/replyToMessageId/text → 400; chưa gắn handler → 404", async () => {
    const { server, base } = await startServer();
    const noHandler = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      body: '{"chatId":1,"replyToMessageId":2,"text":"a"}',
    });
    expect(noHandler.status).toBe(404);
    server.onReporterReply(async () => ({ handled: false }));
    const bad = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      body: '{"chatId":1,"replyToMessageId":2}',
    });
    expect(bad.status).toBe(400);
  });

  test("handler lỗi → 200 kèm handled:true và câu xin lỗi (không để lộ lỗi ra plugin)", async () => {
    const { server, base } = await startServer();
    server.onReporterReply(async () => {
      throw new Error("Itsaplan 502");
    });
    const res = await fetch(`${base}/internal/reporter-reply`, {
      method: "POST",
      body: JSON.stringify({ chatId: 1, replyToMessageId: 2, text: "chưa ổn ạ" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ handled: true });
  });
});

describe('ItsaplanWebhookServer — /internal/force-new (plugin OpenClaw xac-nhan-xong gọi khi bắt "/new")', () => {
  // "/new" bị OpenClaw nuốt trước khi tới agent (ADR-0008) — plugin bắt ở
  // before_dispatch rồi gọi endpoint này (chỉ localhost) để đặt cờ ép sự cố mới.
  test("chuyển chatId cho handler, trả {ok:true}", async () => {
    const { server, base } = await startServer();
    const onForceNew = mock(async (_req: { chatId: string }) => {});
    server.onForceNew(onForceNew);

    const res = await fetch(`${base}/internal/force-new`, {
      method: "POST",
      body: JSON.stringify({ chatId: 5551234 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(onForceNew).toHaveBeenCalledWith({ chatId: "5551234" });
  });

  test("thiếu chatId → 400; chưa gắn handler → 404", async () => {
    const { server, base } = await startServer();
    const noHandler = await fetch(`${base}/internal/force-new`, { method: "POST", body: "{}" });
    expect(noHandler.status).toBe(404);
    server.onForceNew(async () => {});
    const bad = await fetch(`${base}/internal/force-new`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  test("handler lỗi → vẫn 200 kèm ok:false, không để lộ lỗi ra plugin", async () => {
    const { server, base } = await startServer();
    server.onForceNew(async () => {
      throw new Error("DB hỏng");
    });
    const res = await fetch(`${base}/internal/force-new`, {
      method: "POST",
      body: JSON.stringify({ chatId: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });
});
