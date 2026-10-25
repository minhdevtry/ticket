/**
 * Lời báo người dùng khi yêu cầu đổi cột (trạng thái) — theo từng dự án.
 *
 * PO (PO) 01/10: tên trạng thái PO nghe khó hiểu với người ngoài team ("PO Done" không phải
 * "hoàn tất"), muốn mỗi trạng thái kèm một câu giải thích. Tên cột trên Itsaplan GIỮ NGUYÊN (bảng của
 * team PO) — chỉ chữ báo cho người gửi là mới. Dự án không khai ở đây thì giữ cách báo cũ.
 */
export interface StateMessage {
  /** Tên hiển thị cho người báo. */
  name: string;
  /** Giải thích ngắn, đặt trong ngoặc. */
  description: string;
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const PO_STATES: Record<string, StateMessage> = {
  backlog: { name: "Backlog", description: "tính năng mới được order" },
  discussion: {
    name: "Discussion",
    description: "PO nhặt ticket và bắt đầu trao đổi cùng các bên",
  },
  "po inprogress": { name: "PO inprogress", description: "PO bắt đầu làm giải pháp" },
  "po done": { name: "PO done", description: "đã làm xong giải pháp" },
  "sent to dev": { name: "Sent to dev", description: "đã gửi ticket sang Tech team" },
  "dev inprogress": { name: "Dev inprogress", description: "đang bắt đầu phát triển" },
  golive: { name: "Golive", description: "tính năng đã golive" },
  canceled: { name: "Cancelled", description: "yêu cầu đã được huỷ" },
  cancelled: { name: "Cancelled", description: "yêu cầu đã được huỷ" },
};

const BY_PROJECT: Record<string, Record<string, StateMessage>> = { PO: PO_STATES };

/** Lời giải thích cho cột này, `null` nếu dự án chưa khai (giữ cách báo cũ). */
export function stateMessageFor(
  projectKey: string | undefined,
  columnName: string | undefined,
): StateMessage | null {
  if (!projectKey || !columnName) return null;
  return BY_PROJECT[projectKey.toUpperCase()]?.[fold(columnName)] ?? null;
}

/** "Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)". */
export function describeState(
  projectKey: string | undefined,
  columnName: string | undefined,
): string | null {
  const m = stateMessageFor(projectKey, columnName);
  return m ? `${m.name} (${m.description})` : null;
}
