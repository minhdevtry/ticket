import { describe, expect, test } from "bun:test";
import { scanText } from "./scan-transcript";

describe("scan-transcript", () => {
  test("thấy khoá kiểu openai", () => {
    const hits = scanText('x = "sk-abcdefghijklmnopqrstuvwxyz012345"');
    expect(hits.map((h) => h.id)).toContain("openai-style-key");
  });

  test("thấy token github", () => {
    const hits = scanText("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hits.map((h) => h.id)).toContain("github-token");
  });

  test("thấy token bot telegram", () => {
    const hits = scanText("123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789");
    expect(hits.map((h) => h.id)).toContain("telegram-bot-token");
  });

  test("thấy khoá riêng tư", () => {
    const hits = scanText("-----BEGIN RSA PRIVATE KEY-----");
    expect(hits.map((h) => h.id)).toContain("private-key-block");
  });

  test("thấy apiKey trong JSON", () => {
    const hits = scanText('{"apiKey": "abcdefghijklmnop"}');
    expect(hits.map((h) => h.id)).toContain("api-key-json");
  });

  test("báo đúng số dòng", () => {
    const hits = scanText("dòng một\ndòng hai\nghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hits[0]?.line).toBe(3);
  });

  test("văn bản sạch thì không có hit", () => {
    expect(scanText("một dòng văn bản bình thường, không có khoá")).toEqual([]);
  });

  test("tên biến không phải secret thì không báo", () => {
    expect(scanText('const apiKey = "short";')).toEqual([]);
  });
});
