/**
 * Dịch tên cột / stateType của Itsaplan sang tiếng Việt thuần cho người dùng.
 *
 * Sống ở `lib/itsaplan/` chứ không phải cạnh một MCP tool, vì đây là logic
 * của tracker — cả tool tra cứu lẫn worker chạy nền đều cần đúng một cách
 * phân loại, không phải hai cách suy đoán độc lập dễ lệch nhau.
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

export function resolveFriendlyStatusName(columnName?: string, stateType?: string): string {
  const byName = (columnName || "").toLowerCase().trim();
  if (
    byName.includes("resolved") ||
    byName.includes("xử lý xong") ||
    byName.includes("giải quyết")
  ) {
    return "Đã xử lý (chờ duyệt)";
  }
  if (byName.includes("done") || byName.includes("hoàn tất") || byName.includes("hoàn thành")) {
    return "Hoàn tất";
  }
  if (byName.includes("progress") || byName.includes("đang xử lý")) {
    return "Đang xử lý";
  }
  if (
    byName.includes("backlog") ||
    byName.includes("mới tiếp nhận") ||
    byName.includes("tiếp nhận")
  ) {
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

  return columnName || "Chờ xử lý";
}
