import { describe, expect, it } from "bun:test";
import { MAX_DURATION_MS, parseDuration } from "./duration";

describe("parseDuration", () => {
  it("đọc các đơn vị và dạng ghép", () => {
    expect(parseDuration("48h")).toBe(48 * 3_600_000);
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("1d 12h")).toBe(36 * 3_600_000);
    expect(parseDuration("1d12h30m")).toBe(36.5 * 3_600_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
    expect(parseDuration(" 1.5h ")).toBe(5_400_000);
    expect(parseDuration(1234)).toBe(1234);
  });

  it("từ chối định dạng sai, 0, âm, quá 366 ngày", () => {
    for (const bad of ["", "48", "h", "48 giờ", "1d foo", "-5m", "0s", 0, -1, Number.NaN]) {
      expect(() => parseDuration(bad as string | number)).toThrow(RangeError);
    }
    expect(() => parseDuration("400d")).toThrow(/366/);
    expect(parseDuration(MAX_DURATION_MS)).toBe(MAX_DURATION_MS);
  });
});
