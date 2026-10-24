import { describe, expect, it } from "bun:test";
import {
  filterPairs,
  parseSince,
  renderFull,
  renderMarkdown,
  renderTable,
  summarize,
  wrap,
} from "./compare.ts";
import type { Pair } from "./queue.ts";

const pair = (n: number, over: Partial<Pair["tl2"]> = {}): Pair => ({
  v: 1,
  eid: `e${n}`,
  ts: Date.UTC(2026, 9, 24, 10, n),
  chatId: "1000000001",
  text: `Máy in tầng ${n} không in được, báo lỗi giấy kẹt dù không kẹt`,
  tl1: {
    reply: "Em xin mã đơn ạ",
    tools: [{ tool: "ticketintake__intake_step", params: {}, ok: true }],
  },
  tl2: {
    reply: "Anh/chị cho em xin thêm thông tin nhé",
    latencyMs: 1500 + n * 100,
    model: "m",
    error: null,
    ...over,
  },
});

describe("compare", () => {
  it("parseSince", () => {
    expect(parseSince("2h", 10_000_000)).toBe(10_000_000 - 7_200_000);
    expect(() => parseSince("abc")).toThrow();
  });

  it("wrap ngắt theo từ và theo ký tự, giữ dấu tiếng Việt", () => {
    expect(wrap("Máy in tầng hai không in được", 12)).toEqual([
      "Máy in tầng",
      "hai không in",
      "được",
    ]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("", 5)).toEqual([""]);
  });

  it("summarize đếm lỗi và độ trễ", () => {
    const s = summarize([
      pair(1),
      pair(2),
      pair(3, { reply: null, error: "HTTP 500", latencyMs: null }),
    ]);
    expect(s).toContain("3 lượt");
    expect(s).toContain("TL2 trả lời 2, lỗi 1");
    expect(s).toContain("model m");
  });

  it("renderTable: mọi dòng không vượt bề rộng, có tiêu đề cột và nhãn LỖI", () => {
    const out = renderTable([pair(1), pair(2, { reply: null, error: "HTTP 500" })], 100);
    for (const line of out.split("\n")) expect([...line].length).toBeLessThanOrEqual(100);
    expect(out).toContain("Tiểu Linh 1");
    expect(out).toContain("[LỖI] HTTP 500");
  });

  it("renderFull và renderMarkdown", () => {
    expect(renderFull([pair(1)])).toContain("NGƯỜI DÙNG:");
    expect(renderFull([pair(1)])).toContain("ticketintake__intake_step");
    const md = renderMarkdown([pair(1)]);
    expect(md.split("\n")).toHaveLength(3);
    expect(md).toContain("| Giờ |");
  });

  it("filterPairs theo thời gian, chat, giới hạn", () => {
    const ps = [pair(1), pair(2), pair(3)];
    expect(filterPairs(ps, { limit: 2 }).map((p) => p.eid)).toEqual(["e2", "e3"]);
    expect(filterPairs(ps, { since: ps[1].ts }).map((p) => p.eid)).toEqual(["e2", "e3"]);
    expect(filterPairs(ps, { chat: "nope" })).toEqual([]);
  });
});
