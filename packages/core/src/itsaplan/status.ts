/**
 * Dịch tên cột / `stateType` của Itsaplan sang trạng thái người đọc được —
 * một cách phân loại duy nhất cho cả tool tra cứu lẫn worker chạy nền.
 *
 * MERGED (0.1.0):
 *  - `STATUS_DISPLAY_MAP` + `resolveFriendlyStatusName` → from INTAKE (reference),
 *    returning the Vietnamese display string and falling back to the raw column
 *    name. Behaviour unchanged from intake.
 *  - `tryResolveTicketStatus` → the "truthful" variant from CM that returns
 *    `null` on no match instead of guessing a status. CM's version was bolted
 *    onto CM's own 5-status `TicketStatus` union and `sync.ts`; here it is
 *    DECOUPLED to return a plain display string (or null), so the library carries
 *    no CM domain. A webhook path that must not fabricate a status (overwriting a
 *    real "Hoàn tất" with a guessed "Đang xử lý") uses this and treats `null` as
 *    "unknown column, do not write".
 */

export const STATUS_DISPLAY_MAP: Record<string, string> = {
  backlog: "Mới tiếp nhận",
  unstarted: "Chờ xử lý",
  todo: "Chờ xử lý",
  started: "Đang xử lý",
  in_progress: "Đang xử lý",
  resolved: "Đã xử lý (chờ duyệt)",
  completed: "Hoàn tất",
  done: "Hoàn tất",
  canceled: "Đã hủy",
  cancelled: "Đã hủy",
};

/** Tra tên cột tiếng Việt; không khớp mẫu nào → `null` (không đoán). */
export function tryResolveFriendlyStatusName(
  columnName?: string,
  stateType?: string,
): string | null {
  const byName = (columnName || "").toLowerCase().trim();
  if (byName.includes("resolved") || byName.includes("xử lý xong") || byName.includes("giải quyết")) {
    return "Đã xử lý (chờ duyệt)";
  }
  if (byName.includes("done") || byName.includes("hoàn tất") || byName.includes("hoàn thành")) {
    return "Hoàn tất";
  }
  if (byName.includes("progress") || byName.includes("đang xử lý")) {
    return "Đang xử lý";
  }
  if (byName.includes("backlog") || byName.includes("mới tiếp nhận") || byName.includes("tiếp nhận")) {
    return "Mới tiếp nhận";
  }
  if (byName.includes("todo") || byName.includes("chờ xử lý") || byName.includes("chờ")) {
    return "Chờ xử lý";
  }
  if (byName.includes("cancel") || byName.includes("hủy")) {
    return "Đã hủy";
  }
  if (byName && STATUS_DISPLAY_MAP[byName]) {
    return STATUS_DISPLAY_MAP[byName];
  }

  const byState = (stateType || "").toLowerCase().trim();
  if (byState && STATUS_DISPLAY_MAP[byState]) {
    return STATUS_DISPLAY_MAP[byState];
  }

  return null;
}

/**
 * Tên cột / `stateType` → chuỗi hiển thị. Khi không khớp mẫu nào, trả nguyên tên
 * cột (hoặc "Chờ xử lý" nếu thiếu) — hành vi gốc của intake, nơi bắt buộc phải
 * có một chuỗi hiển thị.
 */
export function resolveFriendlyStatusName(columnName?: string, stateType?: string): string {
  return tryResolveFriendlyStatusName(columnName, stateType) ?? columnName ?? "Chờ xử lý";
}
