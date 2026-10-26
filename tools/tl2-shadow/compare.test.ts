import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  filterPairs,
  parseSince,
  renderFull,
  renderMarkdown,
  renderMetrics,
  renderTable,
  stripControl,
  summarize,
  toPairV2,
  wrap,
} from "./compare.ts";
import type { Pair, PairV2 } from "./queue.ts";
import { calculateMetrics } from "./receptionist-replay.ts";

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

  it("stripControl: chuỗi ESC và ký tự điều khiển không lọt ra terminal", () => {
    const evil = "ok\u001b[2J\u001b]0;tiêu đề\u0007x\u0000y\u0085z";
    expect(stripControl(evil)).toBe("okxyz");
    const p = pair(1);
    p.text = evil;
    p.tl2.reply = "\u001b[31mđỏ";
    for (const out of [renderTable([p], 100), renderFull([p]), renderMarkdown([p])]) {
      expect(out).not.toContain("\u001b");
    }
  });

  it("filterPairs theo thời gian, chat, giới hạn", () => {
    const ps = [pair(1), pair(2), pair(3)];
    expect(filterPairs(ps, { limit: 2 }).map((p) => p.eid)).toEqual(["e2", "e3"]);
    expect(filterPairs(ps, { since: ps[1].ts }).map((p) => p.eid)).toEqual(["e2", "e3"]);
    expect(filterPairs(ps, { chat: "nope" })).toEqual([]);
  });

  it("toPairV2 và calculateMetrics: tính đúng M0-M4", () => {
    const v2: PairV2 = {
      v: 2,
      eid: "e10",
      ts: Date.now(),
      chatId: "chat1",
      text: "Lỗi app",
      tl1: { reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.", action: "ask_missing_field" },
      tl2: {
        reply: "Anh/chị bổ sung giúp em: bộ phận",
        outcome: "asked",
        buttons: [],
        fields: {},
        latencyMs: 100,
        error: null,
      },
      diff: { class: "S2", code: "wording_difference" },
    };

    const metrics = calculateMetrics([v2]);
    expect(metrics.m0).toBe(0);
    expect(metrics.m1).toBe(1);
    expect(metrics.classes.s0).toBe(0);
    expect(metrics.classes.s2).toBe(1);

    const rendered = renderMetrics(metrics);
    expect(rendered).toContain("M0");
    expect(rendered).toContain("An toàn (lệch S0)");
    expect(rendered).toContain("**ĐẠT**");
  });

  it("calculateMetrics: phát hiện S0 và đếm M0 > 0", () => {
    const unsafePair: PairV2 = {
      v: 2,
      eid: "e11",
      ts: Date.now(),
      chatId: "chat2",
      text: "tin báo",
      tl1: { reply: "cần thêm thông tin", action: "ask_missing_field" },
      tl2: {
        reply: "đã tạo ticket",
        outcome: "created",
        buttons: [],
        fields: {},
        latencyMs: 100,
        error: null,
      },
      diff: { class: "S0", code: "unconfirmed_ticket_creation" },
    };

    const metrics = calculateMetrics([unsafePair]);
    expect(metrics.m0).toBe(1);
    const rendered = renderMetrics(metrics);
    expect(rendered).toContain("**CHẶN**");
  });

  it("toPairV2 nâng cấp Pair v1 sang v2 và phân loại action của TL1", () => {
    const p1 = pair(1);
    p1.tl1.reply = "Em tóm tắt lại sự cố nhé: Lỗi app, thuộc hệ thống DUO, mức ưu tiên Trung bình.";
    const p2 = toPairV2(p1);
    expect(p2.v).toBe(2);
    expect(p2.tl1.action).toBe("confirm_summary");
    expect(p2.tl1.summary?.system).toBe("DUO");
  });

  it("CLI compare.ts --metrics: thoát mã khác 0 (EXIT 1) khi M0 > 0", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "shadow-metrics-unsafe-"));
    const filePath = join(tmpDir, "pairs.jsonl");
    const unsafePair: PairV2 = {
      v: 2,
      eid: "e-cli-unsafe",
      ts: Date.now(),
      chatId: "chat-cli",
      text: "tin báo",
      tl1: { reply: "cần thêm thông tin", action: "ask_missing_field" },
      tl2: {
        reply: "đã tạo ticket",
        outcome: "created",
        buttons: [],
        fields: {},
        latencyMs: 50,
        error: null,
      },
      diff: { class: "S0", code: "unconfirmed_ticket_creation" },
    };
    writeFileSync(filePath, `${JSON.stringify(unsafePair)}\n`, "utf8");

    const compareScript = join(import.meta.dir, "compare.ts");
    const proc = Bun.spawn(["bun", "run", compareScript, filePath, "--metrics"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    rmSync(tmpDir, { recursive: true, force: true });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("**CHẶN**");
  });

  it("CLI compare.ts --metrics: thoát mã 0 khi M0 = 0", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "shadow-metrics-safe-"));
    const filePath = join(tmpDir, "pairs.jsonl");
    const safePair: PairV2 = {
      v: 2,
      eid: "e-cli-safe",
      ts: Date.now(),
      chatId: "chat-cli",
      text: "tin báo",
      tl1: { reply: "cần thêm thông tin", action: "ask_missing_field" },
      tl2: {
        reply: "xin thêm thông tin",
        outcome: "asked",
        buttons: [],
        fields: {},
        latencyMs: 50,
        error: null,
      },
      diff: { class: "S2", code: "wording_difference" },
    };
    writeFileSync(filePath, `${JSON.stringify(safePair)}\n`, "utf8");

    const compareScript = join(import.meta.dir, "compare.ts");
    const proc = Bun.spawn(["bun", "run", compareScript, filePath, "--metrics"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    rmSync(tmpDir, { recursive: true, force: true });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("**ĐẠT**");
  });
});
