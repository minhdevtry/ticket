/**
 * Bộ phân tích cron 5 trường, không phụ thuộc thư viện ngoài.
 *
 * Cú pháp: `phút giờ ngày-trong-tháng tháng thứ`, mỗi trường nhận `*`, số, khoảng `a-b`,
 * bước (đuôi `/n` sau `*`, `a-b` hoặc `a`, vd `0-30/10`), danh sách `a,b,c`, và tên tiếng Anh viết tắt cho tháng
 * (`JAN`…`DEC`) và thứ (`SUN`…`SAT`). Thứ nhận 0–7 (0 và 7 đều là Chủ nhật). Có thêm các bí
 * danh `@hourly`, `@daily` (`@midnight`), `@weekly`, `@monthly`, `@yearly` (`@annually`).
 *
 * Như cron cổ điển: khi CẢ ngày-trong-tháng LẪN thứ đều bị giới hạn (không bắt đầu bằng `*`)
 * thì chỉ cần khớp MỘT trong hai.
 *
 * Múi giờ tính bằng `Intl` (IANA, vd `Asia/Ho_Chi_Minh`); mặc định {@link DEFAULT_TIMEZONE}.
 * Giờ không tồn tại (nhảy giờ mùa hè) bị bỏ qua; giờ lặp (lùi giờ) chạy một lần.
 */

/** Múi giờ mặc định của bot (không có giờ mùa hè). */
export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

const MINUTE = 60_000;

/** Lịch cron đã phân tích. */
export interface CronSchedule {
  /** Biểu thức đã chuẩn hoá khoảng trắng (bí danh `@daily`… giữ nguyên dạng người viết). */
  readonly expression: string;
  readonly timezone: string;
  /**
   * Thời điểm khớp ĐẦU TIÊN lớn hơn `afterMs` (epoch ms, chẵn phút), hoặc `null` nếu không có
   * trong 8 năm tới.
   */
  next(afterMs: number): number | null;
  /**
   * Thời điểm khớp CUỐI CÙNG nhỏ hơn hoặc bằng `atOrBeforeMs` (chẵn phút), hoặc `null` nếu không
   * có trong 8 năm trước đó. Tìm ngược từ `atOrBeforeMs` nên không tốn theo thời gian đã trôi.
   */
  prev(atOrBeforeMs: number): number | null;
  /**
   * Đếm các thời điểm khớp trong `(afterMs, untilMs]` và trả thời điểm cuối cùng (hoặc `null`
   * nếu không có). Đếm theo ngày bằng tìm nhị phân, không duyệt từng mốc; dừng ở `maxCount`
   * (mặc định 100 000), khi đó `capped` là `true` và `count` bằng `maxCount`.
   */
  between(
    afterMs: number,
    untilMs: number,
    maxCount?: number,
  ): { count: number; last: number | null; capped: boolean };
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Giá trị của tên đầu tiên (tháng bắt đầu từ 1, thứ từ 0). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "phút", min: 0, max: 59 },
  { name: "giờ", min: 0, max: 23 },
  { name: "ngày trong tháng", min: 1, max: 31 },
  { name: "tháng", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "thứ", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function parseField(text: string, spec: FieldSpec): { values: number[]; star: boolean } {
  const fail = (why: string): never => {
    throw new RangeError(`cron: trường ${spec.name} "${text}" không hợp lệ: ${why}`);
  };
  const num = (raw: string): number => {
    const upper = raw.toUpperCase();
    const named = spec.names?.indexOf(upper);
    if (named !== undefined && named >= 0) return named + (spec.nameBase ?? 0);
    if (!/^\d+$/.test(raw)) return fail(`"${raw}" không phải số${spec.names ? " hoặc tên" : ""}`);
    const n = Number(raw);
    if (n < spec.min || n > spec.max) {
      return fail(`${n} ngoài khoảng ${spec.min}-${spec.max}`);
    }
    return n;
  };
  if (text === "") return fail("rỗng");
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "") return fail("phần tử rỗng trong danh sách");
    const [base, stepText, extra] = part.split("/");
    if (extra !== undefined) return fail(`"${part}" có nhiều hơn một dấu "/"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        return fail(`bước "${stepText}" phải là số nguyên >= 1`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (base === "*") {
      from = spec.min;
      to = spec.max;
    } else if (base.includes("-")) {
      const [a, b, more] = base.split("-");
      if (more !== undefined || a === "" || b === undefined || b === "") {
        return fail(`khoảng "${base}" sai dạng a-b`);
      }
      from = num(a);
      to = num(b);
      if (from > to) return fail(`khoảng ngược "${base}"`);
    } else {
      from = num(base);
      to = stepText !== undefined ? spec.max : from;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values: [...values].sort((x, y) => x - y), star: text.startsWith("*") };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Kiểm tra tên múi giờ IANA; ném `RangeError` rõ ràng nếu sai. */
export function assertTimezone(timezone: string): void {
  try {
    formatter(timezone);
  } catch {
    throw new RangeError(
      `múi giờ "${timezone}" không hợp lệ (dùng tên IANA, vd "${DEFAULT_TIMEZONE}")`,
    );
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wall(ms: number, timezone: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  };
}

/** Độ lệch (ms) của múi giờ so với UTC tại thời điểm `ms`. */
function offsetAt(ms: number, timezone: string): number {
  const w = wall(ms, timezone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

/** Giờ treo tường → epoch ms; `null` nếu giờ đó không tồn tại (nhảy giờ mùa hè). */
function wallToInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number | null {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc - offsetAt(asUtc, tz);
  guess = asUtc - offsetAt(guess, tz);
  const w = wall(guess, tz);
  return w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi
    ? guess
    : null;
}

const daysIn = (month: number, leap: boolean): number =>
  month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

const MAX_SCAN_DAYS = 366 * 8;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Độ lệch múi giờ quanh một ngày địa phương (y, m, d): `before` áp dụng trước thời điểm `at`,
 * `after` từ `at` trở đi. Ngày thường `before === after` (không gọi `Intl` cho từng phút); ngày
 * chuyển giờ thì `at` là phút chuyển (tìm bằng chia đôi, ~12 lần gọi `Intl`). `null` nếu cửa sổ
 * có hơn một lần chuyển (không xảy ra trên thực tế): caller rơi về cách tính từng giờ. Nhớ theo ngày.
 * Cửa sổ 50 giờ phủ mọi thời điểm có thể thuộc ngày địa phương đó.
 */
interface DayOffsets {
  before: number;
  after: number;
  at: number;
}
const offsetCache = new Map<string, DayOffsets | null>();
function dayOffsets(y: number, m: number, d: number, tz: string): DayOffsets | null {
  const key = `${tz}|${y}-${m}-${d}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const asUtc0 = Date.UTC(y, m - 1, d);
  const lo = asUtc0 - 14 * HOUR;
  const hi = asUtc0 + DAY_MS + 12 * HOUR;
  const before = offsetAt(lo, tz);
  const after = offsetAt(hi, tz);
  let value: DayOffsets | null;
  if (before === after) {
    value = { before, after, at: Number.POSITIVE_INFINITY };
  } else {
    // Nhỏ nhất t (chẵn phút) trong (lo, hi] mà độ lệch đã là `after`.
    let a = Math.floor(lo / MINUTE);
    let b = Math.floor(hi / MINUTE);
    while (b - a > 1) {
      const mid = Math.floor((a + b) / 2);
      if (offsetAt(mid * MINUTE, tz) === after) b = mid;
      else a = mid;
    }
    const at = b * MINUTE;
    value =
      offsetAt(at - MINUTE, tz) === before && offsetAt(at, tz) === after
        ? { before, after, at }
        : null;
  }
  if (offsetCache.size > 4000) offsetCache.clear();
  offsetCache.set(key, value);
  return value;
}

/** Vị trí đầu tiên trong `arr` (đã sắp tăng) có giá trị >= `x`. */
function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Phân tích một biểu thức cron. Ném `RangeError` (thông báo tiếng Việt, nêu rõ trường sai)
 * nếu biểu thức hoặc múi giờ không hợp lệ, hoặc lịch không bao giờ khớp (vd `0 0 30 2 *`).
 */
export function parseCron(expression: string, timezone: string = DEFAULT_TIMEZONE): CronSchedule {
  assertTimezone(timezone);
  const raw = String(expression ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const resolved = ALIASES[raw.toLowerCase()] ?? raw;
  const fields = resolved.split(" ");
  if (fields.length !== 5) {
    throw new RangeError(
      `cron "${expression}": cần đúng 5 trường (phút giờ ngày tháng thứ), nhận ${raw === "" ? 0 : fields.length}`,
    );
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELDS[i]));
  const dowValues = [...new Set(dow.values.map((v) => v % 7))].sort((a, b) => a - b);
  if (
    !dom.star &&
    dow.star === true &&
    !month.values.some((m) => dom.values.some((d) => d <= daysIn(m, true)))
  ) {
    throw new RangeError(
      `cron "${expression}": không tháng nào có ngày ${dom.values.join(",")} nên lịch không bao giờ chạy`,
    );
  }
  const monthSet = new Set(month.values);
  const domSet = new Set(dom.values);
  const dowSet = new Set(dowValues);

  const dayMatches = (y: number, m: number, d: number): boolean => {
    if (!monthSet.has(m)) return false;
    const domOk = domSet.has(d);
    const dowOk = dowSet.has(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
    if (!dom.star && !dow.star) return domOk || dowOk;
    return domOk && dowOk;
  };

  /**
   * Các mốc (epoch ms, tăng dần) của một ngày địa phương. Ngày thường: cộng trừ độ lệch cố định,
   * không gọi `Intl`. Ngày chuyển giờ: tính từng giờ treo tường (bỏ giờ không tồn tại, giờ lặp
   * chỉ tính một lần).
   */
  const dayCache = new Map<string, number[]>();
  const slotsOfDay = (y: number, m: number, d: number): number[] => {
    const key = `${y}-${m}-${d}`;
    const hit = dayCache.get(key);
    if (hit) return hit;
    const out: number[] = [];
    const offs = dayOffsets(y, m, d, timezone);
    if (offs !== null) {
      for (const h of hour.values) {
        for (const mi of minute.values) {
          const local = Date.UTC(y, m - 1, d, h, mi);
          const first = local - offs.before;
          if (first < offs.at)
            out.push(first); // giờ lặp (lùi giờ): lấy lần đầu, chạy một lần
          else if (offs.before === offs.after) out.push(first);
          else {
            const second = local - offs.after;
            if (second >= offs.at) out.push(second);
          }
          // else: giờ không tồn tại (nhảy giờ mùa hè) bị bỏ qua
        }
      }
      out.sort((p, q) => p - q);
    } else {
      const set = new Set<number>();
      for (const h of hour.values) {
        for (const mi of minute.values) {
          const t = wallToInstant(y, m, d, h, mi, timezone);
          if (t !== null) set.add(t);
        }
      }
      out.push(...[...set].sort((p, q) => p - q));
    }
    if (dayCache.size >= 8) {
      const oldest = dayCache.keys().next().value;
      if (oldest !== undefined) dayCache.delete(oldest);
    }
    dayCache.set(key, out);
    return out;
  };

  const ymd = (startDay: Wall, offsetDays: number) => {
    const day = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day + offsetDays));
    return { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() };
  };

  const next = (afterMs: number): number | null => {
    const from = (Math.floor(afterMs / MINUTE) + 1) * MINUTE;
    const start = wall(from, timezone);
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      const { y, m, d } = ymd(start, i);
      if (!dayMatches(y, m, d)) continue;
      const slots = slotsOfDay(y, m, d);
      const k = lowerBound(slots, from);
      if (k < slots.length) return slots[k];
    }
    return null;
  };

  const prev = (atOrBeforeMs: number): number | null => {
    const t = Math.floor(atOrBeforeMs / MINUTE) * MINUTE;
    const start = wall(t, timezone);
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      const { y, m, d } = ymd(start, -i);
      if (!dayMatches(y, m, d)) continue;
      const slots = slotsOfDay(y, m, d);
      const k = lowerBound(slots, t + 1) - 1;
      if (k >= 0) return slots[k];
    }
    return null;
  };

  const count = (afterMs: number, untilMs: number, maxCount: number) => {
    if (untilMs <= afterMs) return { count: 0, capped: false };
    const from = (Math.floor(afterMs / MINUTE) + 1) * MINUTE;
    const until = Math.floor(untilMs / MINUTE) * MINUTE;
    if (until < from) return { count: 0, capped: false };
    const start = wall(from, timezone);
    const end = wall(until, timezone);
    const span = Math.round(
      (Date.UTC(end.year, end.month - 1, end.day) -
        Date.UTC(start.year, start.month - 1, start.day)) /
        DAY_MS,
    );
    let total = 0;
    for (let i = 0; i <= Math.min(span, MAX_SCAN_DAYS); i++) {
      const { y, m, d } = ymd(start, i);
      if (!dayMatches(y, m, d)) continue;
      const slots = slotsOfDay(y, m, d);
      total += lowerBound(slots, until + 1) - lowerBound(slots, from);
      if (total >= maxCount) return { count: maxCount, capped: true };
    }
    return { count: total, capped: span > MAX_SCAN_DAYS };
  };

  return {
    expression: raw,
    timezone,
    next,
    prev,
    between(afterMs, untilMs, maxCount = 100_000) {
      const last = prev(untilMs);
      if (last === null || last <= afterMs) return { count: 0, last: null, capped: false };
      return { ...count(afterMs, untilMs, maxCount), last };
    },
  };
}
