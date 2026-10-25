import { describe, expect, it } from "bun:test";
import {
  docXacNhan,
  docBangWorker,
  layChatId,
  layReplyToId,
  boPhongBiKenh,
  xuLyXacNhan,
  laLenhSuCoMoi,
} from "./index.mjs";

describe("docXacNhan", () => {
  it("bắt callback_data reporter_ok:<id>, và confirm_done:<id> của nút cũ trước 24/09", () => {
    expect(docXacNhan("callback_data: reporter_ok:42")).toBe(42);
    expect(docXacNhan("callback_data:confirm_done:7")).toBe(7);
  });
  it("không bắt tin thường hay id lạ", () => {
    for (const t of [
      "đã ổn rồi em",
      "reporter_ok",
      "callback_data: reporter_ok:abc",
      "callback_data: đúng rồi",
      "",
    ]) {
      expect(docXacNhan(t)).toBeNull();
    }
  });
});

describe("layChatId", () => {
  // Session key THẬT của gateway (24/09): agent:<agent>:telegram:<account>:direct:<id>.
  it("lấy từ session key, cả chat riêng lẫn nhóm (giữ dấu âm của group id)", () => {
    expect(layChatId({ sessionKey: "agent:iris-agent:telegram:iris:direct:1000000004" })).toBe(
      "1000000004",
    );
    expect(
      layChatId({
        sessionKey: "agent:iris-agent:telegram:iris:group:-1000000000001",
        senderId: "1000000004",
      }),
    ).toBe("-1000000000001");
  });
  it("ưu tiên chatId khai sẵn; chỉ rơi về senderId khi không còn nguồn nào", () => {
    expect(layChatId({ chatId: "telegram:-100555666", senderId: "111222" })).toBe("-100555666");
    expect(layChatId({ senderId: "111222" })).toBe("111222");
    expect(layChatId({})).toBe("");
  });
});

describe("layReplyToId", () => {
  // Tin polling thật 28/09/2026: phong bì mang `reply_to_id` khi người báo reply
  // vào tin thông báo của bot (không bấm nút).
  const PHONG_BI = `vẫn chưa được ạ, lỗi y hệt lúc nãy
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:1000000001", "message_id": "11549", "reply_to_id": "11544", "sender_id": "1000000001", "sender": "Trần Thị B", "implicit_mention_kinds": ["reply_to_bot"], "has_reply_context": true }
\`\`\`
Sender (untrusted metadata): {"label": "Trần Thị B", "username": "SA_UserG"}`;

  it("đọc reply_to_id trong phong bì JSON kèm tin", () => {
    expect(layReplyToId(PHONG_BI)).toBe("11544");
  });
  it("ưu tiên trường có cấu trúc trên ctx/event khi có", () => {
    expect(layReplyToId(PHONG_BI, { replyToId: "999" })).toBe("999");
    expect(layReplyToId(PHONG_BI, {}, { reply_to_id: "888" })).toBe("888");
  });
  it("tin thường không reply, hay rỗng → null", () => {
    expect(layReplyToId("chào em")).toBeNull();
    expect(layReplyToId("")).toBeNull();
    expect(layReplyToId(undefined)).toBeNull();
  });
});

describe("boPhongBiKenh", () => {
  it("bỏ phong bì OpenClaw, giữ lời người báo", () => {
    const t = `vẫn chưa được ạ, lỗi y hệt lúc nãy
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:1000000001", "message_id": "11549", "reply_to_id": "11544" }
\`\`\`
`;
    expect(boPhongBiKenh(t)).toBe("vẫn chưa được ạ, lỗi y hệt lúc nãy");
  });
  it("tin thường không có phong bì → giữ nguyên", () => {
    expect(boPhongBiKenh("App lỗi đăng nhập từ sáng")).toBe("App lỗi đăng nhập từ sáng");
  });
});

describe("laLenhSuCoMoi", () => {
  it('bắt "/new", không phân biệt hoa thường, có hoặc không kèm @botname', () => {
    for (const t of [
      "/new",
      "/NEW",
      "/New xin chào",
      "/new@ticket_intake_bot",
      "/new@ticket_intake_bot bị lỗi khác",
    ]) {
      expect(laLenhSuCoMoi(t)).toBe(true);
    }
  });
  it('không bắt tin thường, hay "/new" là một phần của từ khác', () => {
    for (const t of ["xin chào", "/newbie hỏi thử", "app báo lỗi mới", "", undefined]) {
      expect(laLenhSuCoMoi(t)).toBe(false);
    }
  });
  it("vẫn bắt được sau khi bỏ phong bì kênh", () => {
    const t = `/new bị lỗi khác rồi ạ
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:55555", "message_id": "1" }
\`\`\`
`;
    expect(laLenhSuCoMoi(t)).toBe(true);
  });
});

describe("docBangWorker", () => {
  it("mặc định chỉ Iris; env ghi đè được", () => {
    expect(docBangWorker({})).toEqual({ "iris-agent": "http://127.0.0.1:3103" });
    expect(
      docBangWorker({
        XAC_NHAN_XONG_WORKERS:
          "ticket-intake-agent=http://127.0.0.1:3102, iris-agent=http://127.0.0.1:3103",
      }),
    ).toEqual({
      "ticket-intake-agent": "http://127.0.0.1:3102",
      "iris-agent": "http://127.0.0.1:3103",
    });
  });
});

describe("xuLyXacNhan", () => {
  const ctx = {
    trigger: "user",
    agentId: "iris-agent",
    senderId: "111",
    sessionKey: "agent:iris-agent:telegram:iris:direct:55555",
  };
  const worker = (body, status = 200) => {
    const f = async (url, init) => {
      f.last = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify(body), { status });
    };
    return f;
  };
  const opts = (fetch, daThay = new Map()) => ({ fetch, workers: docBangWorker({}), daThay });

  it("gọi /internal/reporter-ok kèm chatId của cuộc trò chuyện, trả nguyên câu worker trả lời", async () => {
    const f = worker({
      outcome: "recorded",
      replyText: "Dạ em đã ghi nhận, chuyên viên sẽ kiểm tra lại và đóng ticket ạ.",
    });
    const r = await xuLyXacNhan({ cleanedBody: "callback_data: reporter_ok:42" }, ctx, opts(f));
    expect(r.handled).toBe(true);
    expect(r.reply.text).toContain("chuyên viên sẽ kiểm tra lại");
    expect(f.last.url).toBe("http://127.0.0.1:3103/internal/reporter-ok");
    expect(f.last.body).toMatchObject({ issueId: 42, chatId: "55555" });
  });

  it("không bao giờ nói ticket đã đóng (ADR-0006)", async () => {
    const r = await xuLyXacNhan(
      { cleanedBody: "callback_data: confirm_done:42" },
      ctx,
      opts(worker({ outcome: "recorded", replyText: "Dạ em đã ghi nhận" })),
    );
    expect(r.reply.text).not.toMatch(/đóng lại|Hoàn tất và đóng/);
  });

  it("worker không phản hồi → vẫn handled, báo bấm lại (không để LLM tự chế)", async () => {
    const hong = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await xuLyXacNhan({ cleanedBody: "callback_data: reporter_ok:42" }, ctx, opts(hong));
    expect(r.handled).toBe(true);
    expect(r.reply.text).toMatch(/chưa ghi nhận được/i);
  });

  it("bấm lặp trong 15s → im lặng, không gọi worker lần 2", async () => {
    const daThay = new Map();
    let goi = 0;
    const f = async () => {
      goi++;
      return new Response('{"outcome":"recorded","replyText":"ok"}');
    };
    await xuLyXacNhan({ cleanedBody: "callback_data: reporter_ok:42" }, ctx, opts(f, daThay));
    const lan2 = await xuLyXacNhan(
      { cleanedBody: "callback_data: reporter_ok:42" },
      ctx,
      opts(f, daThay),
    );
    expect(goi).toBe(1);
    expect(lan2).toEqual({ handled: true, reason: "xac-nhan-xong:trung" });
  });

  it("agent không có worker, tin thường, hay nhịp tim/cron → không đụng (trả undefined)", async () => {
    const o = opts(worker({ outcome: "recorded", replyText: "ok" }));
    expect(
      await xuLyXacNhan(
        { cleanedBody: "callback_data: reporter_ok:42" },
        { ...ctx, agentId: "sales" },
        o,
      ),
    ).toBeUndefined();
    expect(await xuLyXacNhan({ cleanedBody: "xin chào" }, ctx, o)).toBeUndefined();
    expect(
      await xuLyXacNhan(
        { cleanedBody: "callback_data: reporter_ok:42" },
        { ...ctx, trigger: "cron" },
        o,
      ),
    ).toBeUndefined();
    expect(
      await xuLyXacNhan(
        { cleanedBody: "callback_data: reporter_ok:42" },
        { ...ctx, trigger: "heartbeat" },
        o,
      ),
    ).toBeUndefined();
  });

  it("trigger khác 'user' (vd gửi qua openclaw agent) vẫn được bắt — bug PO-88", async () => {
    for (const trigger of [undefined, "cli", "api"]) {
      const r = await xuLyXacNhan(
        { cleanedBody: "callback_data: reporter_ok:42" },
        { ...ctx, trigger },
        opts(worker({ outcome: "done", replyText: "đã hoàn tất rồi" })),
      );
      expect(r?.handled).toBe(true);
    }
  });

  // 28/09/2026: người báo reply tự do (không bấm nút) vào tin thông báo — mất
  // ở polling mode vì không có update.message.reply_to_message (webhook mode
  // mới có). Phong bì OpenClaw mang `reply_to_id`.
  describe("phản hồi tự do (reply vào tin thông báo)", () => {
    const PHAN_HOI = `vẫn chưa được ạ, lỗi y hệt lúc nãy
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:55555", "message_id": "11549", "reply_to_id": "11544", "sender_id": "111" }
\`\`\`
`;

    it("route khớp → gọi /internal/reporter-reply, trả lời worker, short-circuit agent", async () => {
      const f = worker({
        handled: true,
        replyText: "Dạ em đã chuyển phản hồi của anh/chị vào TECH-961 cho đội Kỹ thuật ạ.",
      });
      const r = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(f));
      expect(r.handled).toBe(true);
      expect(r.reply.text).toContain("TECH-961");
      expect(f.last.url).toBe("http://127.0.0.1:3103/internal/reporter-reply");
      expect(f.last.body).toMatchObject({ replyToMessageId: "11544", chatId: "55555" });
      expect(f.last.body.text).toContain("vẫn chưa được ạ");
      expect(f.last.body.text).not.toContain("reply_to_id");
    });

    it("route không khớp (handled:false) → để tin đi tiếp vào agent", async () => {
      const r = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(worker({ handled: false })));
      expect(r).toBeUndefined();
    });

    it("worker hỏng → im lặng, để tin đi tiếp vào agent (không tự chế câu trả lời)", async () => {
      const hong = async () => {
        throw new Error("ECONNREFUSED");
      };
      const r = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(hong));
      expect(r).toBeUndefined();
    });

    it("reply lặp trong 15s → im lặng, không gọi worker lần 2", async () => {
      const daThay = new Map();
      let goi = 0;
      const f = async () => {
        goi++;
        return new Response('{"handled":true,"replyText":"ok"}');
      };
      await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(f, daThay));
      const lan2 = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(f, daThay));
      expect(goi).toBe(1);
      expect(lan2).toEqual({ handled: true, reason: "xac-nhan-xong:trung" });
    });

    it("tin thường (không phải reply, không phải nút) → không đụng", async () => {
      const o = opts(worker({ handled: true, replyText: "ok" }));
      expect(await xuLyXacNhan({ cleanedBody: "xin chào" }, ctx, o)).toBeUndefined();
      expect(o.fetch.last).toBeUndefined();
    });

    it("nhịp tim/cron hay agent chưa có worker → không đụng", async () => {
      const o = opts(worker({ handled: true, replyText: "ok" }));
      expect(
        await xuLyXacNhan({ cleanedBody: PHAN_HOI }, { ...ctx, trigger: "cron" }, o),
      ).toBeUndefined();
      expect(
        await xuLyXacNhan({ cleanedBody: PHAN_HOI }, { ...ctx, agentId: "sales" }, o),
      ).toBeUndefined();
    });
  });
});

describe("xuLyTruocDispatch (hook before_dispatch — có replyToId thật của OpenClaw)", () => {
  const { xuLyTruocDispatch } = require("./index.mjs");
  const fakeFetch = (body) => {
    const f = async (url, opts) => {
      f.last = { url, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => body };
    };
    return f;
  };
  it("reply vào tin thông báo của Tiểu Linh → gọi worker 3102, trả {handled,text}", async () => {
    const f = fakeFetch({ handled: true, replyText: "Dạ em đã chuyển phản hồi vào TECH-961 ạ." });
    const r = await xuLyTruocDispatch(
      { body: "vẫn chưa được ạ", replyToId: "11544", senderId: "1000000001" },
      {
        sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000001",
        conversationId: "1000000001",
      },
      { fetch: f, workers: { "ticket-intake-agent": "http://127.0.0.1:3102" }, daThay: new Map() },
    );
    expect(r).toEqual({ handled: true, text: "Dạ em đã chuyển phản hồi vào TECH-961 ạ." });
    expect(f.last.url).toBe("http://127.0.0.1:3102/internal/reporter-reply");
    expect(f.last.body.replyToMessageId).toBe(11544);
    expect(f.last.body.chatId).toBe("1000000001");
  });
  it("không có replyToId → không đụng", async () => {
    const r = await xuLyTruocDispatch(
      { body: "xin chào" },
      { sessionKey: "agent:ticket-intake-agent:x" },
      { fetch: fakeFetch({}), workers: {}, daThay: new Map() },
    );
    expect(r).toBeUndefined();
  });
  it("worker báo không phải tin route đã biết → để tin đi tiếp", async () => {
    const r = await xuLyTruocDispatch(
      { body: "ừ", replyToId: "99" },
      { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1234567" },
      {
        fetch: fakeFetch({ handled: false }),
        workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
        daThay: new Map(),
      },
    );
    expect(r).toBeUndefined();
  });

  // ADR-0008: "/new" là lệnh reset phiên của OpenClaw, bị nuốt trước khi tới
  // agent. Plugin phải báo worker đặt cờ RỒI để tin đi tiếp — không "handled".
  describe('bắt "/new" (ADR-0008) trước khi OpenClaw nuốt mất', () => {
    it("gọi /internal/force-new kèm chatId, rồi trả undefined để tin đi tiếp", async () => {
      const f = fakeFetch({ ok: true });
      const r = await xuLyTruocDispatch(
        { body: "/new bị lỗi khác rồi ạ", senderId: "1000000001" },
        {
          sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000001",
          conversationId: "1000000001",
        },
        {
          fetch: f,
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      expect(r).toBeUndefined();
      expect(f.last.url).toBe("http://127.0.0.1:3102/internal/force-new");
      expect(f.last.body).toEqual({ chatId: "1000000001" });
    });

    it("nhận diện /new@botname, không phân biệt hoa thường", async () => {
      const f = fakeFetch({ ok: true });
      const r = await xuLyTruocDispatch(
        { body: "/NEW@ticket_intake_bot", senderId: "1" },
        { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" },
        {
          fetch: f,
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      expect(r).toBeUndefined();
      expect(f.last.url).toBe("http://127.0.0.1:3102/internal/force-new");
    });

    it("worker hỏng → im lặng, vẫn để tin đi tiếp (không chặn)", async () => {
      const hong = async () => {
        throw new Error("ECONNREFUSED");
      };
      const r = await xuLyTruocDispatch(
        { body: "/new", senderId: "1" },
        { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" },
        {
          fetch: hong,
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      expect(r).toBeUndefined();
    });

    it("agent chưa có worker → không gọi mạng, vẫn để tin đi tiếp", async () => {
      const f = fakeFetch({ ok: true });
      const r = await xuLyTruocDispatch(
        { body: "/new", senderId: "1" },
        { sessionKey: "agent:sales-agent:telegram:ticket:direct:1" },
        {
          fetch: f,
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      expect(r).toBeUndefined();
      expect(f.last).toBeUndefined();
    });

    it("tin thường (không phải /new) thì không đụng tới force-new", async () => {
      const f = fakeFetch({ ok: true });
      const r = await xuLyTruocDispatch(
        { body: "app báo lỗi từ sáng", senderId: "1" },
        { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" },
        {
          fetch: f,
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      expect(r).toBeUndefined();
      expect(f.last).toBeUndefined();
    });
  });
});
