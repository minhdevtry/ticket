import { describe, expect, test } from "bun:test";
import { compare, readBaseline } from "./lint-baseline";

describe("lint-baseline", () => {
  test("đọc baseline và bỏ qua khóa chú thích", () => {
    const base = readBaseline();
    expect(base["suspicious/noExplicitAny"]).toBeGreaterThan(0);
    expect(Object.keys(base).every((k) => !k.startsWith("$"))).toBe(true);
  });

  test("số lỗi bằng baseline thì xanh", () => {
    const rows = compare({ "a/b": 3 }, { "a/b": 3 });
    expect(rows).toEqual([{ rule: "a/b", allowed: 3, actual: 3, ok: true }]);
  });

  test("số lỗi tăng thì đỏ", () => {
    const rows = compare({ "a/b": 3 }, { "a/b": 4 });
    expect(rows[0]?.ok).toBe(false);
  });

  test("số lỗi giảm thì vẫn xanh", () => {
    const rows = compare({ "a/b": 3 }, { "a/b": 1 });
    expect(rows[0]?.ok).toBe(true);
  });

  test("rule mới chưa có trong baseline thì mặc định 0 lỗi", () => {
    const rows = compare({}, { "a/b": 1 });
    expect(rows[0]?.allowed).toBe(0);
    expect(rows[0]?.ok).toBe(false);
  });
});
