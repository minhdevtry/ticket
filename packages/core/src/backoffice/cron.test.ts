import { describe, expect, it } from "bun:test";
import { DEFAULT_TIMEZONE, assertTimezone, parseCron } from "./cron";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("parseCron: cú pháp", () => {
  it("nhận *, số, khoảng, bước, danh sách, tên tháng/thứ và bí danh", () => {
    expect(parseCron("*/15 0-6/2 1,15 JAN-MAR MON-FRI", "UTC").expression).toBe(
      "*/15 0-6/2 1,15 JAN-MAR MON-FRI",
    );
    expect(parseCron("  0   8 *  *  *  ").expression).toBe("0 8 * * *");
    for (const alias of [
      "@hourly",
      "@daily",
      "@midnight",
      "@weekly",
      "@monthly",
      "@yearly",
      "@annually",
    ]) {
      expect(() => parseCron(alias)).not.toThrow();
    }
  });

  it("báo lỗi tiếng Việt nêu rõ trường sai", () => {
    const cases: [string, RegExp][] = [
      ["* * * *", /đúng 5 trường/],
      ["", /đúng 5 trường/],
      ["60 * * * *", /phút.*60 ngoài khoảng 0-59/],
      ["0 24 * * *", /giờ.*24 ngoài khoảng 0-23/],
      ["0 0 0 * *", /ngày trong tháng/],
      ["0 0 * 13 *", /tháng/],
      ["0 0 * * 8", /thứ/],
      ["*/0 * * * *", /bước/],
      ["5-1 * * * *", /ngược/],
      ["a * * * *", /không phải số/],
      ["1,,2 * * * *", /rỗng/],
      ["1/2/3 * * * *", /nhiều hơn một/],
      ["0 0 30 2 *", /không bao giờ chạy/],
    ];
    for (const [expr, re] of cases) expect(() => parseCron(expr)).toThrow(re);
  });

  it("múi giờ sai bị từ chối; mặc định là Asia/Ho_Chi_Minh", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Ho_Chi_Minh");
    expect(parseCron("0 8 * * *").timezone).toBe("Asia/Ho_Chi_Minh");
    expect(() => parseCron("0 8 * * *", "Mars/Olympus")).toThrow(/múi giờ/);
    expect(() => assertTimezone("UTC")).not.toThrow();
  });
});

describe("parseCron: next", () => {
  it("mặc định theo giờ Việt Nam (UTC+7): 8 giờ sáng = 01:00Z", () => {
    const c = parseCron("0 8 * * *");
    expect(iso(c.next(at("2026-10-25T00:00:00Z")))).toBe("2026-10-25T01:00:00.000Z");
    expect(iso(c.next(at("2026-10-25T01:00:00Z")))).toBe("2026-10-26T01:00:00.000Z");
    expect(iso(c.next(at("2026-10-25T00:59:59Z")))).toBe("2026-10-25T01:00:00.000Z");
  });

  it("bước, khoảng giờ, danh sách", () => {
    const c = parseCron("*/20 9-10 * * *", "UTC");
    const out: string[] = [];
    let t = at("2026-10-25T08:00:00Z");
    for (let i = 0; i < 7; i++) {
      t = c.next(t) as number;
      out.push(iso(t)?.slice(11, 16) as string);
    }
    expect(out).toEqual(["09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "09:00"]);
    expect(iso(parseCron("5,35 * * * *", "UTC").next(at("2026-10-25T08:05:00Z")))).toBe(
      "2026-10-25T08:35:00.000Z",
    );
  });

  it("thứ trong tuần (tên và 0/7 đều là Chủ nhật)", () => {
    // 2026-10-24 là thứ Bảy, 2026-10-25 là Chủ nhật.
    const weekdays = parseCron("0 9 * * MON-FRI", "UTC");
    expect(iso(weekdays.next(at("2026-10-24T10:00:00Z")))).toBe("2026-10-26T09:00:00.000Z");
    expect(iso(parseCron("0 0 * * 7", "UTC").next(at("2026-10-24T00:00:00Z")))).toBe(
      "2026-10-25T00:00:00.000Z",
    );
    expect(iso(parseCron("0 0 * * 0", "UTC").next(at("2026-10-24T00:00:00Z")))).toBe(
      "2026-10-25T00:00:00.000Z",
    );
  });

  it("ngày-trong-tháng và thứ cùng bị giới hạn thì khớp MỘT trong hai", () => {
    const c = parseCron("0 0 13 * FRI", "UTC");
    expect(iso(c.next(at("2026-10-01T00:00:00Z")))).toBe("2026-10-02T00:00:00.000Z"); // thứ Sáu
    expect(iso(c.next(at("2026-10-09T00:00:00Z")))).toBe("2026-10-13T00:00:00.000Z"); // ngày 13 (thứ Ba)
  });

  it("qua ranh giới tháng/năm và năm nhuận", () => {
    expect(iso(parseCron("0 0 1 * *", "UTC").next(at("2026-12-31T23:59:00Z")))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(iso(parseCron("0 0 29 2 *", "UTC").next(at("2026-03-01T00:00:00Z")))).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("giờ không tồn tại (nhảy giờ mùa hè) bị bỏ qua", () => {
    const c = parseCron("30 2 * * *", "America/New_York");
    // 2026-03-08: 02:00 nhảy thành 03:00, nên không có 02:30 hôm đó.
    expect(iso(c.next(at("2026-03-07T08:00:00Z")))).toBe("2026-03-09T06:30:00.000Z");
  });

  it("múi giờ khác nhau cho mốc khác nhau", () => {
    const t = at("2026-10-25T00:00:00Z");
    expect(iso(parseCron("0 8 * * *", "UTC").next(t))).toBe("2026-10-25T08:00:00.000Z");
    expect(iso(parseCron("0 8 * * *", "Asia/Tokyo").next(t))).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("parseCron: between", () => {
  it("đếm các mốc trong (after, until] và trả mốc cuối", () => {
    const c = parseCron("0 * * * *", "UTC");
    const r = c.between(at("2026-10-25T00:30:00Z"), at("2026-10-25T03:30:00Z"));
    expect(r.count).toBe(3);
    expect(iso(r.last)).toBe("2026-10-25T03:00:00.000Z");
    expect(r.capped).toBe(false);
    // khoảng nửa mở: mốc đúng bằng `after` không tính, đúng bằng `until` có tính
    expect(c.between(at("2026-10-25T01:00:00Z"), at("2026-10-25T02:00:00Z")).count).toBe(1);
    expect(c.between(at("2026-10-25T01:00:00Z"), at("2026-10-25T01:59:00Z"))).toEqual({
      count: 0,
      last: null,
      capped: false,
    });
  });

  it("dừng ở maxCount để lịch dày không quét mãi", () => {
    const c = parseCron("* * * * *", "UTC");
    const r = c.between(at("2026-01-01T00:00:00Z"), at("2026-12-31T00:00:00Z"), 50);
    expect(r).toMatchObject({ count: 50, capped: true });
  });
});
