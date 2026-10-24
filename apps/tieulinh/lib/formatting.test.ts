import { describe, expect, test } from "bun:test";
import {
  cleanMediaTags,
  formatIctTimestamp,
  stripBotMentions,
  isCommentRecentlyForwarded,
} from "./formatting";

describe("cleanMediaTags", () => {
  test("removes telegram media attachment tags", () => {
    const raw = "Phòng học lỗi 502 [media attached: /tmp/image.png (image/png)] cần hỗ trợ gấp";
    expect(cleanMediaTags(raw)).toBe("Phòng học lỗi 502  cần hỗ trợ gấp");
  });

  test("removes angle-bracket media markers", () => {
    const raw = "Ảnh chụp <media:photo id=123> báo lỗi";
    expect(cleanMediaTags(raw)).toBe("Ảnh chụp  báo lỗi");
  });

  test("handles empty or null/undefined inputs safely", () => {
    expect(cleanMediaTags("")).toBe("");
    expect(cleanMediaTags(null)).toBe("");
    expect(cleanMediaTags(undefined)).toBe("");
  });
});

describe("formatIctTimestamp", () => {
  test("formats date in ICT (UTC+7)", () => {
    // 2026-03-14 02:30 UTC -> 2026-03-14 09:30 ICT
    const utcDate = new Date("2026-03-14T02:30:00Z");
    expect(formatIctTimestamp(utcDate)).toBe("2026-03-14 09:30");
  });

  test("rolls over day correctly when crossing UTC midnight", () => {
    // 2026-03-14 20:00 UTC -> 2026-03-15 03:00 ICT
    const utcDate = new Date("2026-03-14T20:00:00Z");
    expect(formatIctTimestamp(utcDate)).toBe("2026-03-15 03:00");
  });

  test("uses current date by default without throwing", () => {
    const res = formatIctTimestamp();
    expect(res).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("stripBotMentions", () => {
  test("lọc bỏ @bot-iris-intake và @iris ở đầu câu", () => {
    expect(stripBotMentions("@bot-iris-intake hi")).toBe("hi");
    expect(stripBotMentions("@iris hi")).toBe("hi");
    expect(stripBotMentions("@iris: Anh kiểm tra giúp")).toBe("Anh kiểm tra giúp");
    expect(stripBotMentions("@iris - chào em")).toBe("chào em");
  });

  test("lọc bỏ mention bot ở giữa hoặc cuối câu", () => {
    expect(stripBotMentions("Chào bạn @iris cần hỗ trợ")).toBe("Chào bạn cần hỗ trợ");
    expect(stripBotMentions("Nhờ em xem giúp @tieulinh")).toBe("Nhờ em xem giúp");
  });

  test("trả về chuỗi rỗng nếu comment chỉ gồm mention", () => {
    expect(stripBotMentions("@bot-iris-intake")).toBe("");
    expect(stripBotMentions("@iris")).toBe("");
    expect(stripBotMentions("")).toBe("");
  });
});

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
