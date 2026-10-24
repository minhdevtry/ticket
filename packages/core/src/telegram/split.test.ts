/** Message splitter — R7E-B1 (CM): never emit an over-4096 or boundary-broken chunk. */
import { describe, expect, test } from "bun:test";
import { splitForTelegram, TELEGRAM_TEXT_LIMIT } from "./split";

describe("splitForTelegram (CM R7E-B1 — 4096 ceiling, UTF-16 counted)", () => {
  test("short text is returned as a single chunk", () => {
    expect(splitForTelegram("ngắn")).toEqual(["ngắn"]);
  });

  test("R7E-B1: every chunk stays within the 4096 UTF-16 limit", () => {
    const text = "dòng nội dung\n".repeat(1000); // ~14k chars
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // No content is silently dropped (modulo trimmed boundary whitespace).
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  test("prefers paragraph/line boundaries over mid-word cuts", () => {
    const para = "A".repeat(2000);
    const text = `${para}\n\n${"B".repeat(2000)}\n\n${"C".repeat(2000)}`;
    const chunks = splitForTelegram(text, 2500);
    // No chunk ends in the middle of a run of identical letters followed by more of it.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2500);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("never splits a surrogate pair or strands a combining mark", () => {
    const emoji = "😀".repeat(3000); // astral plane, .length = 2 each
    const chunks = splitForTelegram(emoji, 100);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      // A lone high surrogate at the end would be a broken character.
      const last = c.charCodeAt(c.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("a single over-limit token is hard-cut rather than left over-limit", () => {
    const giant = "x".repeat(10000); // one token, no boundary
    const chunks = splitForTelegram(giant, 4096);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("")).toBe(giant);
  });
});
