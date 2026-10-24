import { describe, expect, it } from "bun:test";
import { stripChannelEnvelope, isInternalCallbackToken } from "./channel-envelope";

// Nguyên văn phần "Mô tả" của TECH-924 (26/09): model chuyển cả phong bì OpenClaw vào intake_step.
const TECH_924 = `hỗ trợ giúp mình zalo app của mình bị lag ạ
Conversation info (untrusted metadata):
{
  "chat_id": "telegram:1000000003",
  "sender": "Đỗ Thị L",
  "explicitly_mentioned_bot": false
}

Sender (untrusted metadata):
{
  "label": "Đỗ Thị L (1000000003)",
  "username": "SA_UserH"
}

Conversation context (untrusted, chronological, selected for current message):
#10917 Sat 2026-09-26 09:26:16 GMT+7 Đỗ Thị L: /start
#session:5ff5e433 Sat 2026-09-26 09:26:20 GMT+7 OpenClaw: Dạ em Tiểu Linh nghe ạ chị ơi!

callback_data: Sale
Conversation info (untrusted metadata):
\`\`\`json
{
  "chat_id": "telegram:1000000003",
  "timestamp": "Sat 2026-09-26 09:29:26 GMT+7"
}
\`\`\`
`;

// Nguyên văn phần "Mô tả" của TECH-946 (27/09): 2 dạng phong bì mới —
// (1) header có tiền tố mốc giờ "[…]" trước JSON trần, (2) phong bì bị làm phẳng
// chung dòng với callback_data. Raw text KHÔNG có tiền tố quote "> ".
const TECH_946 = `0900000001 tk có 2 lần tên con nên không lên được đơn, hỗ trợ giúp mình
Conversation info (untrusted metadata): chat_id: telegram:1000000002, message_id: 5700000000000000001, sender_id: 1000000002, sender: Trần Thị B, timestamp: Sun 2026-09-27 09:20:27 GMT+7, inbound_event_kind: user_request, explicitly_mentioned_bot: false. Sender: Trần Thị B (1000000002), username: SA_UserG. Conversation context: 0900000001 tk có 2 lần tên con nên không lên được đơn, hỗ trợ giúp mình. callback_data: Sale
[Sun 2026-09-27 09:20 GMT+7] Conversation info (untrusted metadata):
{
  "chat_id": "telegram:1000000002",
  "message_id": "5700000000000000002",
  "sender_id": "1000000002",
  "sender": "Trần Thị B",
  "timestamp": "Sun 2026-09-27 09:20:27 GMT+7",
  "inbound_event_kind": "user_request",
  "explicitly_mentioned_bot": false
}

callback_data: Sale
[Sun 2026-09-27 09:20 GMT+7] Conversation info (untrusted metadata):
{
  "chat_id": "telegram:1000000002",
  "message_id": "5700000000000000002",
  "sender_id": "1000000002",
  "sender": "Trần Thị B",
  "timestamp": "Sun 2026-09-27 09:20:27 GMT+7",
  "inbound_event_kind": "user_request",
  "explicitly_mentioned_bot": false
}
`;

describe("stripChannelEnvelope", () => {
  it("bỏ khối Conversation info / Sender / Conversation context (JSON trần hoặc trong ```json), giữ lời người báo; callback_data đứng riêng dòng chỉ giữ nhãn nút (người dùng bấm)", () => {
    expect(stripChannelEnvelope(TECH_924).split("\n")[0]).toBe("hỗ trợ giúp mình zalo app của mình bị lag ạ");
    expect(stripChannelEnvelope(TECH_924)).not.toMatch(/callback_data|chat_id|username/);
  });

  it("TECH-922: khối JSON chen giữa, lời người báo trước và sau đều giữ", () => {
    const text = `Mã học sinh: 900105 Học sinh này đang có 2 con trùng tên nên không lên đơn được
Conversation info (untrusted metadata):
{
  "chat_id": "telegram:1000000008",
  "username": "SA_UserI"
}

Quản lý lớp`;
    expect(stripChannelEnvelope(text)).toBe("Mã học sinh: 900105 Học sinh này đang có 2 con trùng tên nên không lên đơn được\n\nQuản lý lớp");
  });

  it("tin thường không có phong bì → giữ nguyên", () => {
    const text = "App Duo lỗi đăng nhập, sender báo {lỗi} từ sáng";
    expect(stripChannelEnvelope(text)).toBe(text);
  });

  it("TECH-946: header có tiền tố mốc giờ [..] + phong bì bị làm phẳng chung dòng + callback_data rời dòng → lời người báo + nhãn nút", () => {
    const out = stripChannelEnvelope(TECH_946);
    expect(out.startsWith("0900000001 tk có 2 lần tên con nên không lên được đơn, hỗ trợ giúp mình")).toBe(true);
    expect(out).not.toMatch(/callback_data|chat_id|username|untrusted/);
  });

  it("TECH-946 nhưng mỗi dòng có tiền tố quote \"> \" → vẫn nhận diện và bỏ y hệt", () => {
    const quoted = TECH_946.split("\n")
      .map((line) => (line.length ? `> ${line}` : ">"))
      .join("\n");
    expect(stripChannelEnvelope(quoted)).toBe(stripChannelEnvelope(TECH_946));
  });

  it("chữ 'untrusted' xuất hiện bình thường trong lời người báo → giữ nguyên, không đụng vào", () => {
    const text =
      'Khách feedback là hệ thống "untrusted" quá, sợ lộ thông tin (untrusted) nhưng vẫn dùng bình thường';
    expect(stripChannelEnvelope(text)).toBe(text);
  });
  it("TECH-928: header cách block ```json bằng dòng trống, rồi lịch sử #session → bỏ hết", () => {
    const t = [
      "Đơn hàng không có sản phẩm KHTN nhưng LMS mở Duo KHTN 6.",
      "Conversation info (untrusted metadata):",
      "",
      "```json",
      '{ "chat_id": "telegram:1", "message_id": "2" }',
      "```",
      "",
      "Sender (untrusted metadata):",
      "",
      "```json",
      '{ "username": "X" }',
      "```",
      "",
      "Chat history since last reply (untrusted, for context):",
      "",
      "#session:4ba2570c Sat 2026-09-26 09:34:59 GMT+7 OpenClaw: Em tóm tắt lại sự cố nhé",
      "#10935 Sat 2026-09-26 09:35:03 GMT+7 Tiểu Linh VUIHOC: Em tóm tắt lại sự cố nhé",
    ].join("\n");
    expect(stripChannelEnvelope(t)).toBe("Đơn hàng không có sản phẩm KHTN nhưng LMS mở Duo KHTN 6.");
  });
  it("TECH-930/946: JSON phong bì một dòng hoặc dòng kết thúc \\ (markdown), dòng Sender phẳng → bỏ", () => {
    const t = [
      "Không lên được đơn cho HS 123",
      '{"chat_id":"telegram:1","message_id":"2","sender_id":"1","sender":"A"}',
      "Sender: A (1), username: SA_A",
      "{\\",
      '"chat_id": "telegram:1",\\',
      '"username": "SA_A"\\',
      "}",
      "Cần hỗ trợ gấp",
    ].join("\n");
    expect(stripChannelEnvelope(t)).toBe("Không lên được đơn cho HS 123\nCần hỗ trợ gấp");
  });

  it("JSON bình thường của người báo (không có khoá kênh) → giữ", () => {
    const t = 'Lỗi API trả về {"code": 500, "msg": "timeout"}';
    expect(stripChannelEnvelope(t)).toBe(t);
  });
  it("lịch sử chat OpenClaw (#số / #session: + ngày giờ) và header 'Conversation context:' cụt → bỏ", () => {
    const t = [
      "HS còn buổi học nhưng vào làm bài tập thì báo lỗi",
      "",
      "Conversation context:",
      "#11061 Sat 2026-09-26 11:48:00 GMT+7 UserA01 SA_: /start",
      "#session:1bab4924 Sat 2026-09-26 11:48:05 GMT+7 OpenClaw: Dạ em nghe ạ",
    ].join("\n");
    expect(stripChannelEnvelope(t)).toBe("HS còn buổi học nhưng vào làm bài tập thì báo lỗi");
  });

  it("dòng bắt đầu bằng # bình thường (vd #123 mã đơn) → giữ", () => {
    const t = "Đơn #123 không mở được khoá";
    expect(stripChannelEnvelope(t)).toBe(t);
  });
  it("bấm nút khi model gửi kèm phong bì → còn lại đúng nhãn nút (28/09: 'Sự cố mới' bị xoá thành rỗng)", () => {
    const t = '[Mon 2026-09-28 03:40 GMT+7] Conversation info (untrusted metadata):\n```json\n{ "chat_id": "telegram:1", "message_id": "2" }\n```\n\ncallback_data: Sự cố mới';
    expect(stripChannelEnvelope(t)).toBe("Sự cố mới");
  });

  it("payload nút dạng mã máy (reporter_ok:481) bị bỏ, không thành lời người báo (TECH-940)", () => {
    const out = stripChannelEnvelope("callback_data: reporter_ok:481\nTicket tech 722 đã ổn rồi nhé");
    expect(out).toBe("Ticket tech 722 đã ổn rồi nhé");
    expect(stripChannelEnvelope("callback_data: Sự cố mới")).toBe("Sự cố mới");
  });

  it("TECH-1148: payload nút nội bộ (noop, none, ignore) bị loại bỏ hoàn toàn, không lọt vào nội dung người báo", () => {
    expect(isInternalCallbackToken("noop")).toBe(true);
    expect(isInternalCallbackToken("NOOP")).toBe(true);
    expect(isInternalCallbackToken("none")).toBe(true);
    expect(isInternalCallbackToken("ignore")).toBe(true);
    expect(isInternalCallbackToken("Sự cố mới")).toBe(false);

    // Đứng một mình -> thành chuỗi rỗng
    expect(stripChannelEnvelope("callback_data: noop")).toBe("");
    expect(stripChannelEnvelope("callback_data: NOOP")).toBe("");
    expect(stripChannelEnvelope("callback_data:   noop  ")).toBe("");
    expect(stripChannelEnvelope("callback_data: none")).toBe("");
    expect(stripChannelEnvelope("callback_data: ignore")).toBe("");

    // Kèm tin nhắn thật -> giữ tin nhắn thật, bỏ dòng callback_data: noop
    const text = "App Duo báo lỗi 502\ncallback_data: noop";
    expect(stripChannelEnvelope(text)).toBe("App Duo báo lỗi 502");
  });
});
