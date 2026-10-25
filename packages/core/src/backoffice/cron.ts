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
   * Đếm các thời điểm khớp trong `(afterMs, untilMs]` và trả thời điểm cuối cùng (hoặc `null`
   * nếu không có). Dừng ở `maxCount` (mặc định 100 000) để lịch mỗi phút không quét mãi sau
   * một thời gian dài tắt máy; khi đó `capped` là `true` và `last` là mốc cuối đã đếm.
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

  const next = (afterMs: number): number | null => {
    const from = (Math.floor(afterMs / MINUTE) + 1) * MINUTE;
    const start = wall(from, timezone);
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      const day = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
      const y = day.getUTCFullYear();
      const m = day.getUTCMonth() + 1;
      const d = day.getUTCDate();
      if (!dayMatches(y, m, d)) continue;
      let best: number | null = null;
      for (const h of hour.values) {
        for (const mi of minute.values) {
          const t = wallToInstant(y, m, d, h, mi, timezone);
          if (t !== null && t >= from && (best === null || t < best)) best = t;
        }
      }
      if (best !== null) return best;
    }
    return null;
  };

  return {
    expression: raw,
    timezone,
    next,
    between(afterMs, untilMs, maxCount = 100_000) {
      let count = 0;
      let last: number | null = null;
      let cursor = afterMs;
      while (count < maxCount) {
        const t = next(cursor);
        if (t === null || t > untilMs) return { count, last, capped: false };
        count++;
        last = t;
        cursor = t;
      }
      return { count, last, capped: true };
    },
  };
}
