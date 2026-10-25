/**
 * Đọc khoảng thời gian dạng người đọc: `"48h"`, `"90m"`, `"1d 12h"`, `"30s"`, `"500ms"`.
 * Dùng cho `after("48h", ...)`, `closeAfter("48h")` và các tuỳ chọn hẹn giờ.
 */

const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

/** Trần 366 ngày: hẹn dài hơn thường là gõ nhầm đơn vị. */
export const MAX_DURATION_MS = 366 * UNIT_MS.d;

/**
 * Đổi `"48h"`, `"1d 12h"`, `"90m"`… (đơn vị `ms`, `s`, `m`, `h`, `d`, `w`) hoặc một số ms
 * thành mili-giây. Ném `RangeError` với thông báo rõ nếu sai định dạng, bằng 0 hoặc quá 366 ngày.
 */
export function parseDuration(input: string | number): number {
  let total: number;
  if (typeof input === "number") {
    total = input;
  } else {
    const text = String(input).trim().toLowerCase();
    const part = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)(?![a-z])/y;
    total = 0;
    let rest = text;
    let matched = false;
    while (rest.length > 0) {
      part.lastIndex = 0;
      const m = part.exec(rest);
      if (!m) {
        throw new RangeError(
          `khoảng thời gian "${input}" không hợp lệ (ví dụ đúng: "48h", "90m", "1d 12h", "30s")`,
        );
      }
      total += Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
      rest = rest.slice(m[0].length).trimStart();
      matched = true;
    }
    if (!matched) throw new RangeError("khoảng thời gian rỗng");
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError(`khoảng thời gian phải > 0, nhận ${String(input)}`);
  }
  if (total > MAX_DURATION_MS) {
    throw new RangeError(`khoảng thời gian ${String(input)} vượt quá 366 ngày`);
  }
  return Math.round(total);
}
