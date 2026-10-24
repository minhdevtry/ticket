import { describe, expect, it } from "bun:test";
import { TelegramNotifyChannel } from "./notify-channel";
import { TelegramTransport } from "./transport";
import type { FetchLike } from "./transport";
import type { NotifyBinding } from "../intake/ports";

/**
 * TelegramNotifyChannel là lớp nối notify ↔ Telegram mà mọi bot trước đây tự
 * ghép tay. Test chứng minh: sendComment/sendStateChange gửi đúng chat (bóc
 * tiền tố "telegram:"), nút "Đã ổn" chỉ gắn khi resolved + có cấu hình, và
 * message_id trả về để dispatcher ghi route.
 */

function fakeTransport(): {
  transport: TelegramTransport;
  calls: Array<{ method: string; payload: any }>;
} {
  const calls: Array<{ method: string; payload: any }> = [];
  let nextId = 100;
  const fetch: FetchLike = async (url, init) => {
    const method = String(url).split("/").pop() ?? "";
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, payload });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: nextId++ } };
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
  };
  return { transport: new TelegramTransport({ botToken: "T", fetch }), calls };
}

const binding: NotifyBinding = {
  issueId: 1168,
  identifier: "OP-2",
  chatId: "telegram:555000014",
  channelType: "telegram",
};

describe("TelegramNotifyChannel (ChannelPort cho Telegram)", () => {
  it("sendComment gửi đúng chat (bóc 'telegram:'), trả message_id", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({ transport });
    const id = await ch.sendComment({ binding, authorName: "KTV", text: "Đã khởi động lại node." });
    expect(id).toBe(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("sendMessage");
    expect(calls[0]!.payload.chat_id).toBe("555000014"); // tiền tố telegram: đã bóc
    expect(calls[0]!.payload.text).toContain("Đã khởi động lại node.");
  });

  it("sendComment nối ảnh vào cuối dưới dạng markdown", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({ transport });
    await ch.sendComment({
      binding,
      authorName: "KTV",
      text: "Xem ảnh",
      images: ["https://x/a.png"],
    });
    expect(calls[0]!.payload.text).toContain("![](https://x/a.png)");
  });

  it("sendComment rỗng (không text, không ảnh) → không gửi, trả null", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({ transport });
    const id = await ch.sendComment({ binding, authorName: "KTV", text: "   " });
    expect(id).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("sendStateChange resolved + có cấu hình nút → gắn nút 'Đã ổn' với callback đúng", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({
      transport,
      reporterOkButton: { label: "👍 Đã ổn", callbackData: (id) => `reporter_ok:${id}` },
    });
    await ch.sendStateChange({
      binding,
      message: "Ticket đã xử lý xong.",
      state: "resolved",
      withReporterOkButton: true,
    });
    const markup = calls[0]!.payload.reply_markup;
    expect(markup.inline_keyboard[0][0].text).toBe("👍 Đã ổn");
    expect(markup.inline_keyboard[0][0].callback_data).toBe("reporter_ok:1168");
  });

  it("sendStateChange resolved nhưng CHƯA cấu hình nút → vẫn gửi, không nút", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({ transport });
    const id = await ch.sendStateChange({
      binding,
      message: "Đã xong.",
      state: "resolved",
      withReporterOkButton: true,
    });
    expect(id).toBe(100);
    expect(calls[0]!.payload.reply_markup).toBeUndefined();
  });

  it("sendStateChange không resolved → không nút dù withReporterOkButton (dispatcher chỉ bật khi resolved)", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({
      transport,
      reporterOkButton: { label: "OK", callbackData: (id) => `reporter_ok:${id}` },
    });
    await ch.sendStateChange({
      binding,
      message: "Đang xử lý.",
      state: "open",
      withReporterOkButton: false,
    });
    expect(calls[0]!.payload.reply_markup).toBeUndefined();
  });

  it("clearInteractiveButtons gọi editMessageReplyMarkup bàn phím rỗng", async () => {
    const { transport, calls } = fakeTransport();
    const ch = new TelegramNotifyChannel({ transport });
    await ch.clearInteractiveButtons(binding, "555");
    expect(calls[0]!.method).toBe("editMessageReplyMarkup");
    expect(calls[0]!.payload.message_id).toBe(555);
    expect(calls[0]!.payload.reply_markup.inline_keyboard).toEqual([]);
  });
});
