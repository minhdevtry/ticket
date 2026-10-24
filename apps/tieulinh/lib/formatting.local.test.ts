import { describe, expect, test } from "bun:test";
import { isCommentRecentlyForwarded } from "./formatting.local";

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
