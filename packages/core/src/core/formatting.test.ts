import { describe, expect, it, test } from "bun:test";
import {
  BOT_COMMENT_MARKER,
  isBotComment,
  markBotComment,
  getBotCommentMarker,
  setBotCommentMarker,
  cleanMediaTags,
  extractMediaAttachments,
  stripCommentHtml,
  formatIctTimestamp,
  formatIctDate,
  foldForComparison,
  looseIncludes,
  stripBotMentions,
  KNOWN_BOT_HANDLES,
} from "./formatting";

// ── marker chống echo-loop (merged intake + CM) ──────────────────────────────
describe("markBotComment / isBotComment", () => {
  it("gắn marker và nhận diện lại chính xác; gọi hai lần không nhân đôi marker", () => {
    const raw = "Chào thầy/cô, CM đã tiếp nhận yêu cầu.";
    const marked = markBotComment(raw);
    expect(marked).toContain(BOT_COMMENT_MARKER);
    expect(isBotComment(marked)).toBe(true);

    const markedAgain = markBotComment(marked);
    expect(markedAgain).toBe(marked);

    expect(isBotComment(raw)).toBe(false);
    expect(isBotComment(null)).toBe(false);
  });

  it("nhận ra cả marker cũ của intake và CM (comment đã ghi trước đây)", () => {
    expect(isBotComment("nội dung\n\n<!-- intake-bot -->")).toBe(true);
    expect(isBotComment("nội dung\n\n<!-- cm-bot -->")).toBe(true);
  });

  it("dấu ghi mặc định là dấu của intake — worker đang chạy chỉ nhận dấu này", () => {
    expect(BOT_COMMENT_MARKER).toBe("<!-- intake-bot -->");
    expect(getBotCommentMarker()).toBe("<!-- intake-bot -->");
    expect(markBotComment("x")).toBe("x\n\n<!-- intake-bot -->");
  });

  it("bot khác đặt dấu của mình (CM ghi cm-bot); dấu sai dạng bị từ chối", () => {
    try {
      setBotCommentMarker("<!-- cm-bot -->");
      expect(markBotComment("y")).toBe("y\n\n<!-- cm-bot -->");
      expect(isBotComment("z\n\n<!-- intake-bot -->")).toBe(true);
      expect(() => setBotCommentMarker("cm-bot")).toThrow();
    } finally {
      setBotCommentMarker(BOT_COMMENT_MARKER);
    }
  });
});

// ── cleanMediaTags / extractMediaAttachments ─────────────────────────────────
describe("cleanMediaTags", () => {
  test("bỏ thẻ media Telegram", () => {
    const raw = "Phòng học lỗi 502 [media attached: /tmp/image.png (image/png)] cần hỗ trợ gấp";
    expect(cleanMediaTags(raw)).toBe("Phòng học lỗi 502  cần hỗ trợ gấp");
  });

  test("bỏ thẻ dạng góc nhọn <media:...>", () => {
    const raw = "Ảnh chụp <media:photo id=123> báo lỗi";
    expect(cleanMediaTags(raw)).toBe("Ảnh chụp  báo lỗi");
  });

  test("rỗng / null / undefined an toàn", () => {
    expect(cleanMediaTags("")).toBe("");
    expect(cleanMediaTags(null)).toBe("");
    expect(cleanMediaTags(undefined)).toBe("");
  });

  test("(CM) trích đường dẫn media", () => {
    const text = "Em gửi ảnh chụp màn hình [media attached: /tmp/shot.png] nhờ CM xem";
    // Bản gộp lấy hành vi intake (chuẩn): KHÔNG gộp khoảng trắng đôi do bỏ thẻ
    // để lại — khác CM gốc (CM `cleanMediaTags` có `\s{2,}→ ' '`). Ghi ở provenance.
    expect(cleanMediaTags(text)).toBe("Em gửi ảnh chụp màn hình  nhờ CM xem");
    expect(extractMediaAttachments(text)).toEqual(["/tmp/shot.png"]);
  });
});

// ── stripCommentHtml (intake) ────────────────────────────────────────────────
describe("stripCommentHtml (intake)", () => {
  it("bỏ <video>…</video> và giữ chữ trong <mark>/<span>", () => {
    expect(stripCommentHtml('<video src="x.mp4">clip</video>sau')).toBe("sau");
    expect(stripCommentHtml('<mark class="hl">quan trọng</mark>')).toBe("quan trọng");
    expect(stripCommentHtml('<span style="color:red">đỏ</span>')).toBe("đỏ");
  });
  it("rỗng/null an toàn", () => {
    expect(stripCommentHtml(null)).toBe("");
    expect(stripCommentHtml("")).toBe("");
  });
});

// ── timestamps ───────────────────────────────────────────────────────────────
describe("formatIctTimestamp / formatIctDate", () => {
  test("định dạng theo ICT (UTC+7)", () => {
    const utcDate = new Date("2026-03-14T02:30:00Z"); // 09:30 ICT
    expect(formatIctTimestamp(utcDate)).toBe("2026-03-14 09:30");
  });

  test("sang ngày mới khi vượt nửa đêm UTC", () => {
    const utcDate = new Date("2026-03-14T20:00:00Z"); // 2026-03-15 03:00 ICT
    expect(formatIctTimestamp(utcDate)).toBe("2026-03-15 03:00");
  });

  test("mặc định lấy giờ hiện tại, không ném lỗi", () => {
    const res = formatIctTimestamp();
    expect(res).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test("(CM) formatIctDate dạng YYYY-MM-DD", () => {
    const utcDate = new Date("2026-10-01T02:00:00.000Z"); // 09:00 ICT
    expect(formatIctTimestamp(utcDate)).toBe("2026-10-01 09:00");
    expect(formatIctDate(utcDate)).toBe("2026-10-01");
  });
});

// ── foldForComparison / looseIncludes (CM) ───────────────────────────────────
describe("foldForComparison / looseIncludes (CM)", () => {
  it("bỏ dấu, hạ chữ, gộp khoảng trắng, map đ→d", () => {
    expect(foldForComparison("Toán Đại số")).toBe("toan dai so");
    expect(foldForComparison("TOAN.  2026")).toBe("toan. 2026");
  });
  it("looseIncludes bỏ qua dấu khi khớp", () => {
    expect(looseIncludes("Học liệu chưa chính xác", "hoc lieu chua chinh xac")).toBe(true);
    expect(looseIncludes("abc", "xyz")).toBe(false);
  });
});

// ── stripBotMentions (merged intake + CM) ────────────────────────────────────
describe("stripBotMentions (intake cases)", () => {
  test("lọc @bot-iris-intake và @iris ở đầu câu", () => {
    expect(stripBotMentions("@bot-iris-intake hi")).toBe("hi");
    expect(stripBotMentions("@iris hi")).toBe("hi");
    expect(stripBotMentions("@iris: Anh kiểm tra giúp")).toBe("Anh kiểm tra giúp");
    expect(stripBotMentions("@iris - chào em")).toBe("chào em");
  });

  test("lọc mention bot ở giữa hoặc cuối câu", () => {
    expect(stripBotMentions("Chào bạn @iris cần hỗ trợ")).toBe("Chào bạn cần hỗ trợ");
    expect(stripBotMentions("Nhờ em xem giúp @tieulinh")).toBe("Nhờ em xem giúp");
  });

  test("chuỗi chỉ gồm mention → rỗng", () => {
    expect(stripBotMentions("@bot-iris-intake")).toBe("");
    expect(stripBotMentions("@iris")).toBe("");
    expect(stripBotMentions("")).toBe("");
  });
});

describe("stripBotMentions (CM cases)", () => {
  test("lọc @cmsupport và @<tên>_bot", () => {
    expect(stripBotMentions("@cmsupport @vhticket_bot Thầy cô xem giúp em đề kiểm tra")).toBe(
      "Thầy cô xem giúp em đề kiểm tra",
    );
    expect(stripBotMentions("Nhờ @vh_teacher_sp_bot xem")).toBe("Nhờ xem");
  });
});

describe("stripBotMentions — options (cho bot cần hành vi intake cũ)", () => {
  test("knownHandles thay danh sách mặc định: không lọc @cmsupport nếu không có trong danh sách", () => {
    const handles = KNOWN_BOT_HANDLES.filter((h) => h !== "cmsupport");
    expect(stripBotMentions("@cmsupport xem giúp", [], { knownHandles: handles })).toBe(
      "@cmsupport xem giúp",
    );
    expect(stripBotMentions("@iris xem giúp", [], { knownHandles: handles })).toBe("xem giúp");
  });

  test("stripBotSuffixHandles:false giữ @<tên>_bot lạ, chỉ lọc handle trong danh sách", () => {
    expect(
      stripBotMentions("Nhờ @vh_teacher_sp_bot xem", [], { stripBotSuffixHandles: false }),
    ).toBe("Nhờ @vh_teacher_sp_bot xem");
    // handle có _bot trong danh sách (vhticket_bot) vẫn bị lọc.
    expect(stripBotMentions("@vhticket_bot xem", [], { stripBotSuffixHandles: false })).toBe("xem");
  });
});
