import { describe, expect, it } from "bun:test";
import plugin, {
  layAccountId,
  choPhepNutTrenTinCoMa,
  xuLyDebounceCallback,
  laCallbackNoiBo,
} from "./index.mjs";

describe("layAccountId (khoá nút phải dùng đúng token bot)", () => {
  // before_agent_reply không có accountId → trước đây rơi xuống token .env của bot
  // khác → khoá nút hỏng "Unauthorized" (28/09).
  it("lấy tài khoản từ sessionKey agent:<agent>:telegram:<account>:…", () => {
    expect(layAccountId({ sessionKey: "agent:iris-agent:telegram:iris:direct:1000000001" })).toBe(
      "iris",
    );
    expect(
      layAccountId({}, { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" }),
    ).toBe("ticket");
  });
  it("accountId có sẵn thì ưu tiên, không đoán được thì null", () => {
    expect(
      layAccountId({ accountId: "ticket", sessionKey: "agent:x:telegram:iris:direct:1" }),
    ).toBe("ticket");
    expect(layAccountId({ sessionKey: "agent:iris-agent:sim-xnx" })).toBeNull();
  });
});

describe("choPhepNutTrenTinCoMa (hàng rào tin đã xong việc)", () => {
  const nut = (...labels) => [labels.map((l) => ({ text: l, callback_data: l }))];
  it("tin 'đã tạo TECH-975' không được đính nút xác nhận cũ", () => {
    expect(
      choPhepNutTrenTinCoMa("Em đã tạo thành công ticket TECH-975", nut("✅ Đúng rồi, tạo ticket")),
    ).toBe(false);
  });
  it("câu xác nhận ghi vào ticket có nút nhắc đúng mã → giữ nút (ADR-0008)", () => {
    expect(
      choPhepNutTrenTinCoMa(
        "Dạ anh/chị xác nhận giúp em: bổ sung vào TECH-795 nội dung sau nhé?",
        nut("✅ Bổ sung vào TECH-795", "Huỷ"),
      ),
    ).toBe(true);
    expect(
      choPhepNutTrenTinCoMa("Dạ bổ sung vào TECH-795?", nut("✅ Bổ sung vào TECH-796", "Huỷ")),
    ).toBe(false);
  });
  it("tin không có mã, hoặc nút 'Tiếp tục sự cố đang chờ' → giữ nút", () => {
    expect(choPhepNutTrenTinCoMa("Anh/chị chọn bộ phận nhé", nut("CSKH"))).toBe(true);
    expect(
      choPhepNutTrenTinCoMa(
        "Đã tạo TECH-975. Còn sự cố «X» đang chờ",
        nut("Tiếp tục sự cố đang chờ"),
      ),
    ).toBe(true);
    expect(
      choPhepNutTrenTinCoMa(
        "Dạ tin này có thông tin khác với ticket TECH-994 vừa tạo ạ. Đây là SỰ CỐ MỚI hay bổ sung?",
        nut("Sự cố mới", "Bổ sung sự cố đang chờ"),
      ),
    ).toBe(true);
  });
});

describe("xuLyDebounceCallback (chống bão nút bấm Telegram khi nghẽn)", () => {
  it("chặn callback_data giống hệt nhau liên tiếp từ cùng một sender", () => {
    const daThay = new Map();
    // Lần 1: cho qua
    expect(xuLyDebounceCallback("callback_data: Quản lý lớp", "session-1", "user-1", daThay)).toBe(
      false,
    );
    // Lần 2 (ngay sau đó): chặn
    expect(xuLyDebounceCallback("callback_data: Quản lý lớp", "session-1", "user-1", daThay)).toBe(
      true,
    );
    // Nút khác: cho qua
    expect(xuLyDebounceCallback("callback_data: đúng rồi", "session-1", "user-1", daThay)).toBe(
      false,
    );
  });

  it("không bao giờ chặn tin nhắn văn bản thông thường", () => {
    const daThay = new Map();
    expect(xuLyDebounceCallback("Tôi ở bộ phận quản lý lớp", "session-1", "user-1", daThay)).toBe(
      false,
    );
    expect(xuLyDebounceCallback("Tôi ở bộ phận quản lý lớp", "session-1", "user-1", daThay)).toBe(
      false,
    );
  });
});

describe("laCallbackNoiBo (nhận diện payload nút nội bộ: noop, none, ignore)", () => {
  it("bắt đúng các dạng callback_data nội bộ: noop, none, ignore (không phân biệt hoa thường)", () => {
    expect(laCallbackNoiBo("callback_data: noop")).toBe(true);
    expect(laCallbackNoiBo("callback_data: NOOP")).toBe(true);
    expect(laCallbackNoiBo("callback_data:   noop  ")).toBe(true);
    expect(laCallbackNoiBo("noop")).toBe(true);
    expect(laCallbackNoiBo("NOOP")).toBe(true);
    expect(laCallbackNoiBo("callback_data: none")).toBe(true);
    expect(laCallbackNoiBo("callback_data: ignore")).toBe(true);
  });

  it("không chặn callback_data nghiệp vụ của người dùng", () => {
    expect(laCallbackNoiBo("callback_data: Quản lý lớp")).toBe(false);
    expect(laCallbackNoiBo("callback_data: đúng rồi")).toBe(false);
    expect(laCallbackNoiBo("callback_data: Sự cố mới")).toBe(false);
    expect(laCallbackNoiBo("callback_data: reporter_ok:100")).toBe(false);
  });

  it("không chặn tin nhắn văn bản thông thường chứa từ noop trong câu", () => {
    expect(laCallbackNoiBo("Hàm noop trong code đang bị lỗi không chạy")).toBe(false);
    expect(laCallbackNoiBo("Báo lỗi hệ thống")).toBe(false);
  });
});

describe("plugin iris-tuong-tac chặn noop ở before_dispatch và before_agent_reply", () => {
  it("before_dispatch nuốt sạch callback_data: noop và trả handled: true", async () => {
    const hooks = {};
    const api = {
      on(name, fn) {
        hooks[name] = fn;
      },
    };
    plugin.register(api);

    let answeredQueryId = null;
    const fakeFetch = async (url, opts) => {
      if (url.includes("answerCallbackQuery")) {
        const body = JSON.parse(opts.body);
        answeredQueryId = body.callback_query_id;
      }
      return { json: async () => ({ ok: true }) };
    };

    const res = await hooks["before_dispatch"](
      { body: "callback_data: noop", callbackQueryId: "cb_12345" },
      { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000007" },
      { fetch: fakeFetch },
    );

    expect(res).toEqual({ handled: true });
  });

  it("before_agent_reply nuốt sạch nếu tin noop lọt vào", async () => {
    const hooks = {};
    const api = {
      on(name, fn) {
        hooks[name] = fn;
      },
    };
    plugin.register(api);

    const res = await hooks["before_agent_reply"](
      { cleanedBody: "callback_data: noop" },
      { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000007" },
    );

    expect(res).toEqual({ handled: true });
  });
});
