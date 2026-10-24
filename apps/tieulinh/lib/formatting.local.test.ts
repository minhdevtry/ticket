import { describe, expect, test } from "bun:test";
import { isCommentRecentlyForwarded, stripBotMentions } from "./formatting.local";

describe("isCommentRecentlyForwarded", () => {
  test("phát hiện trùng lặp trong khoảng thời gian TTL", () => {
    const issueId = 999123;
    const text = "Chào bạn, đã tiếp nhận";
    expect(isCommentRecentlyForwarded(issueId, text, 5000)).toBe(false);
    // Lần thứ hai gọi ngay lập tức phải trả về true (đã chuyển tiếp)
    expect(isCommentRecentlyForwarded(issueId, text, 5000)).toBe(true);
    // Nội dung khác không bị coi là trùng
    expect(isCommentRecentlyForwarded(issueId, "Nội dung khác", 5000)).toBe(false);
  });
});

describe("stripBotMentions (wrapper Tiểu Linh — danh sách cũ, không luật _bot)", () => {
  test("vẫn lọc handle của Tiểu Linh / Iris / vhticket_bot ở mọi vị trí", () => {
    expect(stripBotMentions("@iris: Anh kiểm tra giúp")).toBe("Anh kiểm tra giúp");
    expect(stripBotMentions("Nhờ em xem giúp @tieulinh")).toBe("Nhờ em xem giúp");
    expect(stripBotMentions("@vhticket_bot xem")).toBe("xem");
  });

  test("KHÔNG lọc @cmsupport (handle bot CM) và KHÔNG xoá mọi @<tên>_bot lạ", () => {
    expect(stripBotMentions("@cmsupport xem giúp")).toBe("@cmsupport xem giúp");
    expect(stripBotMentions("Nhờ @vh_teacher_sp_bot xem")).toBe("Nhờ @vh_teacher_sp_bot xem");
  });

  test("handle bổ sung truyền vào vẫn được lọc", () => {
    expect(stripBotMentions("@agentx ok", ["agentx"])).toBe("ok");
  });
});
