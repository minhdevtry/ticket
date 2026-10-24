import { describe, expect, test } from "bun:test";
import {
  injectContext,
  InMemorySessionInjectionTracker,
} from "./context-injection";

describe("injectContext — embedded (mỗi lượt)", () => {
  test("luôn chèn khi có nội dung", () => {
    const r1 = injectContext({ runtime: "embedded", sessionKey: "s1", content: "ROUTING" });
    const r2 = injectContext({ runtime: "embedded", sessionKey: "s1", content: "ROUTING" });
    expect(r1.prependSystemContext).toBe("ROUTING");
    expect(r1.reason).toBe("injected-per-turn");
    expect(r2.prependSystemContext).toBe("ROUTING"); // chèn LẠI — runtime không giữ
  });

  test("nội dung rỗng ⇒ không chèn", () => {
    expect(injectContext({ runtime: "embedded", sessionKey: "s1", content: "   " })).toEqual({
      prependSystemContext: null,
      reason: "empty",
    });
    expect(injectContext({ runtime: "embedded", sessionKey: "s1", content: null }).reason).toBe("empty");
  });
});

describe("injectContext — codex (một lần mỗi phiên)", () => {
  test("chèn lần đầu, bỏ các lần sau cùng phiên+tag", () => {
    const tracker = new InMemorySessionInjectionTracker();
    const first = injectContext({ runtime: "codex", sessionKey: "s1", content: "SKILL", tag: "toan", tracker });
    const second = injectContext({ runtime: "codex", sessionKey: "s1", content: "SKILL", tag: "toan", tracker });
    expect(first.prependSystemContext).toBe("SKILL");
    expect(first.reason).toBe("injected-once");
    expect(second.prependSystemContext).toBeNull();
    expect(second.reason).toBe("already-in-session");
  });

  test("tag khác trong cùng phiên vẫn chèn được", () => {
    const tracker = new InMemorySessionInjectionTracker();
    injectContext({ runtime: "codex", sessionKey: "s1", content: "A", tag: "toan", tracker });
    const b = injectContext({ runtime: "codex", sessionKey: "s1", content: "B", tag: "anh", tracker });
    expect(b.reason).toBe("injected-once");
  });

  test("phiên khác chèn độc lập", () => {
    const tracker = new InMemorySessionInjectionTracker();
    injectContext({ runtime: "codex", sessionKey: "s1", content: "X", tag: "t", tracker });
    const other = injectContext({ runtime: "codex", sessionKey: "s2", content: "X", tag: "t", tracker });
    expect(other.reason).toBe("injected-once");
  });

  test("thiếu sessionKey/tracker ⇒ không nhớ được, chèn như mỗi lượt", () => {
    expect(injectContext({ runtime: "codex", sessionKey: null, content: "X" }).reason).toBe("injected-per-turn");
    const tracker = new InMemorySessionInjectionTracker();
    expect(injectContext({ runtime: "codex", sessionKey: "", content: "X", tracker }).reason).toBe("injected-per-turn");
  });
});

describe("InMemorySessionInjectionTracker", () => {
  test("đuổi phần tử cũ nhất khi vượt trần", () => {
    const tracker = new InMemorySessionInjectionTracker(2);
    tracker.mark("s1", "t");
    tracker.mark("s2", "t");
    tracker.mark("s3", "t"); // đuổi s1
    expect(tracker.has("s1", "t")).toBe(false);
    expect(tracker.has("s2", "t")).toBe(true);
    expect(tracker.has("s3", "t")).toBe(true);
  });
});
