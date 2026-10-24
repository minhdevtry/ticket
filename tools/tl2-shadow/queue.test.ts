import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHAT, cleanTmp, inbound, outbound, tmpDir, tool } from "./fixtures.ts";
import { EventStore, JsonlFile, PairStore } from "./queue.ts";

afterEach(cleanTmp);
const mode = (p: string) => statSync(p).mode & 0o777;

describe("JsonlFile", () => {
  it("tạo file 0600 trong thư mục 0700, bỏ qua dòng hỏng", () => {
    const dir = join(tmpDir(), "sub");
    const f = new JsonlFile<{ ts: number }>(join(dir, "a.jsonl"));
    f.append({ ts: 1 });
    appendFileSync(f.path, "{hỏng\n");
    f.append({ ts: 2 });
    appendFileSync(f.path, '{"ts":3'); // dòng cuối ghi dở
    expect(f.readAll().map((r) => r.ts)).toEqual([1, 2]);
    expect(mode(f.path)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  it("prune giữ bản ghi mới, vẫn 0600", () => {
    const f = new JsonlFile<{ ts: number }>(join(tmpDir(), "a.jsonl"));
    for (const ts of [1, 5, 10]) f.append({ ts });
    expect(f.prune(5).removed).toBe(1);
    expect(f.readAll().map((r) => r.ts)).toEqual([5, 10]);
    expect(mode(f.path)).toBe(0o600);
  });
});

describe("EventStore", () => {
  it("khử trùng theo eid và dựng lại từ file", () => {
    const p = join(tmpDir(), "e.jsonl");
    const s = new EventStore(p);
    expect(s.add(inbound(1, 100))).toBe(true);
    expect(s.add(inbound(1, 100))).toBe(false);
    expect(new EventStore(p).inboundsOf(CHAT)).toHaveLength(1);
  });

  it("ghép tin ra và tool vào đúng tin vào theo cửa sổ thời gian", () => {
    const s = new EventStore(join(tmpDir(), "e.jsonl"));
    s.add(inbound(1, 100));
    s.add(tool(1, 110, "ticketintake__intake_step"));
    s.add(outbound(1, 120, "câu hỏi thêm"));
    s.add(outbound(2, 125, "kèm nút"));
    s.add(inbound(2, 200));
    s.add(outbound(3, 220, "đã tạo ticket"));
    const [a, b] = s.inboundsOf(CHAT);
    expect(s.tl1Reply(a)).toBe("câu hỏi thêm\n\nkèm nút");
    expect(s.toolsFor(a).map((t) => t.tool)).toEqual(["ticketintake__intake_step"]);
    expect(s.tl1Reply(b)).toBe("đã tạo ticket");
    expect(s.toolsFor(b)).toEqual([]);
  });

  it("xếp lại sự kiện đến trễ theo ts", () => {
    const s = new EventStore(join(tmpDir(), "e.jsonl"));
    s.add(inbound(2, 200));
    s.add(inbound(1, 100));
    expect(s.inboundsOf(CHAT).map((i) => i.messageId)).toEqual(["1", "2"]);
  });

  it("tl1Settled: có tin ra và im lặng; hoặc hết hạn chờ; hoặc cửa sổ đã đóng", () => {
    const s = new EventStore(join(tmpDir(), "e.jsonl"));
    s.add(inbound(1, 1000));
    const [a] = s.inboundsOf(CHAT);
    expect(s.tl1Settled(a, 1500, 1000, 30000)).toBe(false);
    s.add(outbound(1, 2000, "ok"));
    expect(s.tl1Settled(a, 2500, 1000, 30000)).toBe(false);
    expect(s.tl1Settled(a, 3100, 1000, 30000)).toBe(true);
    s.add(inbound(5, 5000));
    const [x, y] = [s.inboundsOf(CHAT)[0], s.inboundsOf(CHAT)[1]];
    expect(s.tl1Settled(y, 5500, 1000, 30000)).toBe(false);
    expect(s.tl1Settled(y, 40000, 1000, 30000)).toBe(true);
    expect(x).toBe(a);
  });

  it("recentTurns lấy các lượt trước kèm câu trả lời của Tiểu Linh 1, trong cửa sổ", () => {
    const s = new EventStore(join(tmpDir(), "e.jsonl"));
    s.add(inbound(1, 100, "một"));
    s.add(outbound(1, 110, "đáp một"));
    s.add(inbound(2, 200, "hai"));
    s.add(inbound(3, 300, "ba"));
    const cur = s.inboundsOf(CHAT)[2];
    expect(s.recentTurns(cur, 5, 1000)).toEqual([
      { user: "một", assistant: "đáp một" },
      { user: "hai", assistant: null },
    ]);
    expect(s.recentTurns(cur, 1, 1000)).toEqual([{ user: "hai", assistant: null }]);
    expect(s.recentTurns(cur, 5, 150)).toEqual([{ user: "hai", assistant: null }]);
    expect(s.recentTurns(cur, 0, 1000)).toEqual([]);
  });

  it("prune bỏ sự kiện quá hạn và dựng lại chỉ mục", () => {
    const s = new EventStore(join(tmpDir(), "e.jsonl"));
    s.add(inbound(1, 100));
    s.add(inbound(2, 900));
    expect(s.prune(500)).toBe(1);
    expect(s.size()).toBe(1);
    expect(s.add(inbound(1, 100))).toBe(true);
  });
});

describe("PairStore", () => {
  it("nhớ eid đã xong sau khi mở lại, không ghi trùng", () => {
    const p = join(tmpDir(), "p.jsonl");
    const s = new PairStore(p);
    const pair = {
      v: 1 as const,
      eid: "x",
      ts: 1,
      chatId: CHAT,
      text: "t",
      tl1: { reply: null, tools: [] },
      tl2: { reply: "r", latencyMs: 5, model: "m", error: null },
    };
    s.add(pair);
    s.add(pair);
    expect(s.readAll()).toHaveLength(1);
    expect(new PairStore(p).has("x")).toBe(true);
    expect(mode(p)).toBe(0o600);
  });
});
