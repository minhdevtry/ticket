/**
 * Test render tracker ↔ Telegram — mỗi lỗi hiển thị đã gặp trong lịch sử là một
 * hàng bảng, trích commit đã vá nó; cả hai chiều; cộng test property-ish rằng
 * output không bao giờ chứa entity marker lẻ cho tên ngẫu nhiên có `_*[]\``.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PARSE_MODE,
  escapeMarkdown,
  isEntityParseError,
  renderLabeledValue,
  renderTelegramToTracker,
  renderTicketLink,
  renderTrackerToTelegram,
  toPlainText,
} from "./index";

// ── Chiều tracker → Telegram ────────────────────────────────────────────────

interface TrackerCase {
  commit: string;
  name: string;
  input: string;
  expectText: string;
  expectImages?: string[];
  expectVideos?: string[];
}

const trackerCases: TrackerCase[] = [
  {
    commit: "5bf501e",
    name: "highlight HTML Tiptap <mark>/<span> bị gỡ, giữ chữ bên trong",
    input: 'Lỗi ở <mark class="hl">màn hình QC</mark> và <span style="color:red">điểm số</span>.',
    expectText: escapeMarkdown("Lỗi ở màn hình QC và điểm số."),
  },
  {
    commit: "5bf501e",
    name: "thẻ <video> bị gỡ khỏi text, src bóc sang videos",
    input: 'Xem clip: <video src="https://cdn/x.mp4" controls></video> nhé',
    expectText: escapeMarkdown("Xem clip:  nhé"),
    expectVideos: ["https://cdn/x.mp4"],
  },
  {
    commit: "40f7062",
    name: "tên có '_' được escape, không làm hỏng Markdown",
    input: "PO_UserC đã xử lý, cc @PRO_UserB",
    expectText: "PO\\_UserC đã xử lý, cc @PRO\\_UserB",
  },
  {
    commit: "40f7062",
    name: "tên có '*' và '[' được escape",
    input: "Nhờ *Minh* xem mục [chi tiết]",
    expectText: "Nhờ \\*Minh\\* xem mục \\[chi tiết\\]",
  },
  {
    commit: "5bf501e",
    name: "markdown ảnh bóc sang images, xoá khỏi text",
    input: "Ảnh minh hoạ:\n![screenshot](https://cdn/a.png)\nnhư trên.",
    expectText: escapeMarkdown("Ảnh minh hoạ:\n\nnhư trên."),
    expectImages: ["https://cdn/a.png"],
  },
  {
    commit: "d45e400",
    name: "mention bot bị gỡ khỏi comment đẩy về người báo",
    input: "@tieulinh đã nhận, @vhticket_bot chuyển CM",
    expectText: "đã nhận, chuyển CM",
  },
];

describe("renderTrackerToTelegram — bảng lỗi hiển thị theo commit", () => {
  for (const c of trackerCases) {
    it(`[${c.commit}] ${c.name}`, () => {
      const r = renderTrackerToTelegram(c.input);
      expect(r.text).toBe(c.expectText);
      if (c.expectImages) expect(r.images).toEqual(c.expectImages);
      if (c.expectVideos) expect(r.videos).toEqual(c.expectVideos);
    });
  }

  it("plain mode không escape ký tự entity", () => {
    const r = renderTrackerToTelegram("PO_UserC", { parseMode: "plain" });
    expect(r.text).toBe("PO_UserC");
  });

  it("keepImageMarkdown giữ cú pháp ảnh trong text", () => {
    const r = renderTrackerToTelegram("![a](u)", { parseMode: "plain", keepImageMarkdown: true });
    expect(r.text).toContain("![a](u)");
    expect(r.images).toEqual(["u"]);
  });
});

// ── Chiều Telegram → tracker ────────────────────────────────────────────────

interface TgCase {
  commit: string;
  name: string;
  input: string;
  expect: string;
}

const tgCases: TgCase[] = [
  {
    commit: "7323bc7",
    name: "lời người báo giữ NGUYÊN VĂN, xuống dòng được giữ",
    input: "Em không vào được Classin.\nMã lớp 12A1.\nGiúp em với.",
    expect: "Em không vào được Classin.\nMã lớp 12A1.\nGiúp em với.",
  },
  {
    commit: "d0d1ed9",
    name: "phong bì kênh (chat_id/username) bị bỏ, giữ lời thật",
    input:
      'Conversation info (untrusted metadata):\n{\n  "chat_id": "telegram:123",\n  "username": "thaygiaotoan"\n}\nEm bị lỗi không nộp được bài.',
    expect: "Em bị lỗi không nộp được bài.",
  },
  {
    commit: "4aabc54",
    name: "payload nút máy (reporter_ok:) bị bỏ",
    input: "callback_data: reporter_ok:481",
    expect: "",
  },
  {
    commit: "4aabc54",
    name: "nhãn nút chữ (người bấm) được GIỮ làm câu trả lời",
    input: "callback_data: Đã ổn rồi ạ",
    expect: "Đã ổn rồi ạ",
  },
  {
    commit: "7323bc7",
    name: "thẻ media nội bộ bị bỏ, lời giữ nguyên",
    input: "Màn hình trắng [media attached: /tmp/a.png]",
    expect: "Màn hình trắng",
  },
  {
    commit: "7323bc7",
    name: "ký tự markdown của người báo KHÔNG bị escape (nguyên văn sang tracker)",
    input: "Tài khoản HS_12345 lỗi *nghiêm trọng*",
    expect: "Tài khoản HS_12345 lỗi *nghiêm trọng*",
  },
];

describe("renderTelegramToTracker — bảng lỗi hiển thị theo commit", () => {
  for (const c of tgCases) {
    it(`[${c.commit}] ${c.name}`, () => {
      expect(renderTelegramToTracker(c.input)).toBe(c.expect);
    });
  }

  it("stripMentions bật thì gỡ mention bot khỏi lời người", () => {
    expect(renderTelegramToTracker("@tieulinh em cần hỗ trợ", { stripMentions: true })).toBe(
      "em cần hỗ trợ",
    );
  });
});

// ── Round-trip & helpers ─────────────────────────────────────────────────────

describe("round-trip: tracker → Telegram → tracker giữ chữ người báo", () => {
  it("lời có '_' đi về Telegram escape, quay lại tracker lại nguyên văn", () => {
    const original = "Tài khoản HS_12345 không vào được.";
    const toTg = renderTrackerToTelegram(original);
    expect(toTg.text).toBe("Tài khoản HS\\_12345 không vào được.");
    // Người báo gõ nguyên văn, tracker nhận nguyên văn:
    expect(renderTelegramToTracker(original)).toBe(original);
  });
});

describe("helpers link/nhãn — nhãn là tham số, không literal tiếng Việt", () => {
  it("renderTicketLink Markdown dựng [label](url), escape nhãn", () => {
    expect(renderTicketLink("Phiếu TECH_12", "https://x/TECH-12")).toBe(
      "[Phiếu TECH\\_12](https://x/TECH-12)",
    );
  });
  it("renderTicketLink plain trả 'label: url'", () => {
    expect(renderTicketLink("Phiếu 12", "https://x/12", "plain")).toBe("Phiếu 12: https://x/12");
  });
  it("renderLabeledValue bold prefix", () => {
    expect(renderLabeledValue("Người báo", "Cô Lan_A", DEFAULT_PARSE_MODE, true)).toBe(
      "**Người báo**: Cô Lan\\_A",
    );
  });
  it("renderLabeledValue plain", () => {
    expect(renderLabeledValue("Ưu tiên", "Cao", "plain")).toBe("Ưu tiên: Cao");
  });
});

describe("toPlainText / isEntityParseError", () => {
  it("toPlainText bỏ ** in đậm, giữ chữ", () => {
    expect(toPlainText("**Tên**: nội dung")).toBe("Tên: nội dung");
  });
  it("isEntityParseError nhận lỗi Telegram", () => {
    expect(isEntityParseError(new Error("Bad Request: can't parse entities"))).toBe(true);
    expect(isEntityParseError(new Error("timeout"))).toBe(false);
  });
});

// ── Property-ish: output không bao giờ có entity marker lẻ ────────────────────

/** Đếm số ký tự `ch` KHÔNG đứng sau dấu escape `\`. */
function countUnescaped(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ch) continue;
    if (i > 0 && s[i - 1] === "\\") continue;
    n++;
  }
  return n;
}

describe("property-ish: tên ngẫu nhiên có _*[]` không để lại entity marker lẻ", () => {
  const alphabet = "abcDE_*[]`()@. 12-ôâ";
  function randName(seed: number): string {
    let s = "";
    let x = seed;
    const len = 1 + (x % 20);
    for (let i = 0; i < len; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      s += alphabet[x % alphabet.length];
    }
    return s;
  }

  it("escapeMarkdown: mọi _*[]` trong output đều đã escape", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const name = randName(seed);
      const out = escapeMarkdown(name);
      for (const ch of ["_", "*", "`", "[", "]"]) {
        expect(countUnescaped(out, ch)).toBe(0);
      }
    }
  });

  it("renderTrackerToTelegram: text ra không có entity marker lẻ cho tên ngẫu nhiên", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const name = randName(seed);
      // Nhúng tên vào một comment tracker có cả HTML + mention để test cả pipeline.
      const body = `<mark>${name}</mark> báo lỗi @tieulinh`;
      const out = renderTrackerToTelegram(body).text;
      for (const ch of ["_", "*", "`", "[", "]"]) {
        expect(countUnescaped(out, ch)).toBe(0);
      }
    }
  });

  it("renderTicketLink: nhãn ngẫu nhiên không phá cú pháp [..](..)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const label = randName(seed);
      const out = renderTicketLink(label, "https://x/1");
      // Đúng một '[' mở và một '](' — nhãn escape nên không sinh thêm cặp.
      expect(out.startsWith("[")).toBe(true);
      expect(out.endsWith("(https://x/1)")).toBe(true);
      const labelPart = out.slice(1, out.indexOf("](https://x/1)"));
      for (const ch of ["_", "*", "`", "[", "]"]) {
        expect(countUnescaped(labelPart, ch)).toBe(0);
      }
    }
  });
});
