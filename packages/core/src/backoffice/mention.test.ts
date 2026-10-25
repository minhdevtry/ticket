import { describe, expect, it } from "bun:test";
import { frameMentionPrompt } from "../testing/fake-itsaplan";
import { parseMentionPrompt } from "./mention";

describe("parseMentionPrompt", () => {
  it("lấy comment sau dấu, replyToId và gỡ @mention của bot", () => {
    const prompt = frameMentionPrompt({
      identifier: "TECH-7",
      title: "Lỗi A",
      issueId: 107,
      commentId: 4242,
      comment: "@tieulinh2 xem giúp mình ticket này nhé",
    });
    const parsed = parseMentionPrompt(prompt, ["tieulinh2"]);
    expect(parsed.framed).toBe(true);
    expect(parsed.replyToId).toBe(4242);
    expect(parsed.text).toBe("xem giúp mình ticket này nhé");
    expect(parsed.raw).toBe("@tieulinh2 xem giúp mình ticket này nhé");
    expect(parsed.threadContext).toBeNull();
  });

  it("đọc các comment cha trong luồng", () => {
    const prompt = frameMentionPrompt({
      identifier: "TECH-7",
      title: "Lỗi A",
      issueId: 107,
      commentId: 9,
      comment: "ok, làm đi",
      threadContext: "An: có ai xem chưa?\n\nBình: mình đang xem",
    });
    const parsed = parseMentionPrompt(prompt);
    expect(parsed.threadContext).toBe("An: có ai xem chưa?\n\nBình: mình đang xem");
    expect(parsed.text).toBe("ok, làm đi");
  });

  it("không có khung thì coi cả prompt là nội dung, không ném", () => {
    const parsed = parseMentionPrompt("<mark>@bot_x</mark> kiểm tra giúp");
    expect(parsed.framed).toBe(false);
    expect(parsed.replyToId).toBeNull();
    expect(parsed.text).toContain("kiểm tra giúp");
    expect(parsed.text).not.toContain("<mark>");
  });
});
