import { describe, expect, test } from "bun:test";
import { DEFAULT_FILES, firstErrorLine, parseArgs } from "./test-flaky.ts";

describe("parseArgs", () => {
  test("mặc định: 20 vòng, ba file của issue #38", () => {
    const opts = parseArgs([]);
    expect(opts.rounds).toBe(20);
    expect(opts.files).toEqual([...DEFAULT_FILES]);
    expect(opts.list).toBe(false);
  });

  test("--rounds đổi số vòng", () => {
    expect(parseArgs(["--rounds", "5"]).rounds).toBe(5);
  });

  test("--rounds thiếu số thì báo lỗi", () => {
    expect(() => parseArgs(["--rounds"])).toThrow();
    expect(() => parseArgs(["--rounds", "0"])).toThrow();
    expect(() => parseArgs(["--rounds", "abc"])).toThrow();
  });

  test("--file thêm file vào danh sách", () => {
    const opts = parseArgs(["--file", "packages/core/src/x.test.ts"]);
    expect(opts.files).toContain("packages/core/src/x.test.ts");
    // File mặc định vẫn còn.
    expect(opts.files).toEqual([...DEFAULT_FILES, "packages/core/src/x.test.ts"]);
  });

  test("--file thiếu đường dẫn thì báo lỗi", () => {
    expect(() => parseArgs(["--file"])).toThrow();
  });

  test("--list bật chế độ chỉ liệt kê", () => {
    expect(parseArgs(["--list"]).list).toBe(true);
  });

  test("cờ lạ thì báo lỗi, không bỏ qua âm thầm", () => {
    expect(() => parseArgs(["--khong-co"])).toThrow();
  });
});

describe("firstErrorLine", () => {
  test("lấy dòng đầu có (fail)", () => {
    const out = ["ok", "(fail) something broke", "more"].join("\n");
    expect(firstErrorLine(out)).toBe("(fail) something broke");
  });

  test("lấy dòng đầu có error:", () => {
    const out = ["ok", "error: boom", "more"].join("\n");
    expect(firstErrorLine(out)).toBe("error: boom");
  });

  test("không tìm thấy thì trả lời chung chung, không trả chuỗi rỗng", () => {
    expect(firstErrorLine("all good")).toBe("xem output đầy đủ");
  });

  test("bỏ khoảng trắng thừa ở đầu dòng", () => {
    expect(firstErrorLine("   (fail) x")).toBe("(fail) x");
  });
});
