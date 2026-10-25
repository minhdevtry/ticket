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

describe("parseCron: prev và hiệu năng", () => {
  it("prev là mốc cuối <= thời điểm cho trước", () => {
    const c = parseCron("0 8 * * *", "UTC");
    expect(iso(c.prev(at("2026-10-25T08:00:00Z")))).toBe("2026-10-25T08:00:00.000Z");
    expect(iso(c.prev(at("2026-10-25T07:59:59Z")))).toBe("2026-10-24T08:00:00.000Z");
    expect(iso(parseCron("0 0 29 2 *", "UTC").prev(at("2026-10-25T00:00:00Z")))).toBe(
      "2024-02-29T00:00:00.000Z",
    );
    expect(iso(parseCron("0 8 * * *").prev(at("2026-10-25T00:30:00Z")))).toBe(
      "2026-10-24T01:00:00.000Z",
    );
  });

  // Tham chiếu chậm: duyệt từng phút bằng chính Intl, độc lập với cài đặt trong cron.ts.
  function reference(timezone: string, matches: (w: Record<string, number>) => boolean) {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (ms: number): boolean => {
      const w: Record<string, number> = {};
      for (const p of f.formatToParts(new Date(ms))) {
        if (p.type === "weekday") w.dow = dayNames.indexOf(p.value);
        else if (p.type !== "literal") w[p.type] = Number(p.value);
      }
      if (w.hour === 24) w.hour = 0;
      return matches(w);
    };
  }

  it("next/prev/count khớp duyệt từng phút, kể cả quanh ngày chuyển giờ mùa hè", () => {
    const cases: { tz: string; expr: string; from: string; to: string; ok: (w: any) => boolean }[] =
      [
        {
          tz: "America/New_York",
          expr: "*/20 * * * *",
          from: "2026-03-07T12:00:00Z",
          to: "2026-03-10T12:00:00Z",
          ok: (w) => w.minute % 20 === 0,
        },
        {
          tz: "America/New_York",
          expr: "30 2 * * *", // 02:30 không tồn tại ngày 2026-03-08
          from: "2026-03-06T00:00:00Z",
          to: "2026-03-12T00:00:00Z",
          ok: (w) => w.hour === 2 && w.minute === 30,
        },
        {
          tz: "Europe/London",
          expr: "15 9-17 * * MON-FRI",
          from: "2026-10-22T00:00:00Z",
          to: "2026-10-30T00:00:00Z",
          ok: (w) => w.hour >= 9 && w.hour <= 17 && w.minute === 15 && w.dow >= 1 && w.dow <= 5,
        },
        {
          tz: "Australia/Lord_Howe",
          expr: "0,30 * * * *",
          from: "2026-10-03T00:00:00Z",
          to: "2026-10-06T00:00:00Z",
          ok: (w) => w.minute === 0 || w.minute === 30,
        },
        {
          tz: "Asia/Ho_Chi_Minh",
          expr: "5 */6 * * *",
          from: "2026-10-20T00:00:00Z",
          to: "2026-10-27T00:00:00Z",
          ok: (w) => w.hour % 6 === 0 && w.minute === 5,
        },
      ];
    for (const c of cases) {
      const cron = parseCron(c.expr, c.tz);
      const test = reference(c.tz, c.ok);
      const from = at(c.from);
      const to = at(c.to);
      const slots: number[] = [];
      for (let t = from; t <= to; t += 60_000) if (test(t)) slots.push(t);
      // count/between
      const r = cron.between(from - 60_000, to, 1_000_000);
      expect(r.count).toBe(slots.length);
      expect(r.last).toBe(slots.at(-1) as number);
      // next theo từng mốc, prev tại từng mốc và ngay trước nó
      let cursor = from - 60_000;
      for (const s of slots) {
        expect(cron.next(cursor)).toBe(s);
        expect(cron.prev(s)).toBe(s);
        cursor = s;
      }
      expect(cron.prev(slots[0] + 30_000)).toBe(slots[0]);
    }
  });

  it("giờ lặp khi lùi giờ chỉ chạy một lần", () => {
    const c = parseCron("30 1 * * *", "America/New_York"); // 01:30 xuất hiện hai lần ngày 2026-11-01
    const r = c.between(at("2026-10-31T12:00:00Z"), at("2026-11-02T12:00:00Z"));
    expect(r.count).toBe(2); // một lần ngày 11-01 (dù 01:30 xuất hiện hai lần) và một lần ngày 11-02
    expect(iso(c.next(at("2026-10-31T12:00:00Z")))).toBe("2026-11-01T05:30:00.000Z"); // lần đầu (EDT)
  });

  it("quét lịch mỗi phút sau 2 ngày tắt máy rất nhanh, không chặn event loop", () => {
    const c = parseCron("* * * * *"); // Asia/Ho_Chi_Minh
    const now = at("2026-10-25T00:00:00Z");
    const t0 = performance.now();
    const latest = c.prev(now);
    const r = c.between(now - 2 * 86_400_000, latest as number);
    const next = c.next(now - 2 * 86_400_000);
    const elapsed = performance.now() - t0;
    expect(r.count).toBe(2 * 24 * 60);
    expect(next).toBe(now - 2 * 86_400_000 + 60_000);
    expect(elapsed).toBeLessThan(50);
  });

  it("lịch hiếm không quét lâu: ngày 29/2 từ 2026 và lịch giờ trong múi giờ có chuyển giờ", () => {
    const t0 = performance.now();
    const feb = parseCron("0 0 29 2 *", "America/New_York");
    expect(iso(feb.next(at("2026-10-25T00:00:00Z")))).toBe("2028-02-29T05:00:00.000Z");
    expect(iso(feb.prev(at("2026-10-25T00:00:00Z")))).toBe("2024-02-29T05:00:00.000Z");
    for (let i = 0; i < 200; i++) {
      parseCron("*/5 * * * *", "Europe/London").between(
        at("2026-10-20T00:00:00Z"),
        at("2026-10-31T00:00:00Z"),
      );
    }
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
