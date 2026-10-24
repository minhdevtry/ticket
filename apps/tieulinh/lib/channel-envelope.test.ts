import { describe, expect, test } from "bun:test";
import { isInternalCallbackToken, stripChannelEnvelope } from "./channel-envelope";

// Tiểu Linh giữ đúng hành vi intake cũ của stripChannelEnvelope (thư viện mặc
// định khác: giữ khối phong bì chiếm trọn tin, giữ chữ sau khối, bỏ ``` dán).
const SOLE = `{
  "chat_id": "telegram:1000000001",
  "sender_id": "1000000001",
  "message_id": "7"
}`;

describe("stripChannelEnvelope (wrapper Tiểu Linh)", () => {
  test("TECH-922: tin chỉ gồm khối JSON phong bì → rỗng, chat_id/sender_id không lọt vào mô tả", () => {
    const out = stripChannelEnvelope(SOLE);
    expect(out).toBe("");
    expect(out).not.toMatch(/chat_id|sender_id/);
  });

  test("khối ```json phong bì sau header vẫn bị bỏ, lời người báo giữ", () => {
    const t = `Conversation info (untrusted metadata):\n\`\`\`json\n${SOLE}\n\`\`\`\nzalo bị lag`;
    expect(stripChannelEnvelope(t)).toBe("zalo bị lag");
  });

  test("chữ ngay sau `}` cuối của khối bị bỏ cùng dòng (như cũ)", () => {
    expect(stripChannelEnvelope('{ "chat_id": "telegram:1" } lỗi 502\nxin hỗ trợ')).toBe(
      "xin hỗ trợ",
    );
  });

  test("khối ``` do người dùng dán (không header) được giữ nguyên, kể cả có khoá phong bì", () => {
    const t = 'lỗi này\n```json\n{ "chat_id": "telegram:1" }\n```\nhết';
    expect(stripChannelEnvelope(t)).toContain("```json");
  });

  test("callback_data: noop bị loại; nhãn nút chữ được giữ (TECH-1148)", () => {
    expect(stripChannelEnvelope("callback_data: noop")).toBe("");
    expect(stripChannelEnvelope("callback_data: Sự cố mới")).toBe("Sự cố mới");
    expect(isInternalCallbackToken("noop")).toBe(true);
  });
});
