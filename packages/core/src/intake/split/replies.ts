/**
 * Phân loại phản hồi của người báo khi được hỏi "Tách N ticket hay Gộp 1 ticket" (W29-SPLIT, TECH-1146).
 *
 * Hàm thuần túy, không phụ thuộc vào trạng thái hay I/O.
 * Trả về:
 * - "split": Người báo đồng ý tách nhiều ticket.
 * - "merge": Người báo muốn gộp vào 1 ticket (hoặc từ chối/huỷ việc tách).
 * - "unknown": Phản hồi chưa rõ ý hoặc chuyển sang nội dung khác.
 */
export type SplitReplyDecision = "split" | "merge" | "unknown";

export function classifySplitReply(reply: string): SplitReplyDecision {
  const normalized = reply.trim().toLowerCase();
  if (!normalized) return "unknown";

  const negated = /(?:^|[^\p{L}])(?:không|ko|k|chẳng|chưa|đừng|khỏi|thôi)(?:$|[^\p{L}])/u.test(
    normalized,
  );
  const saysStopSplit = /^(?:thôi|khỏi)(?:\s+(?:ạ|a|nha|nhé|vậy|đi|thôi|khỏi|luôn))*$/u.test(
    normalized,
  );
  const saysSplit = !negated && /(?:^|[^\p{L}])tách(?:$|[^\p{L}])/u.test(normalized);
  const agreesToSplit =
    saysSplit ||
    (!negated &&
      /^(?:đúng rồi|ok|oke|okay|ừ|vâng|dạ|chuẩn|tạo đi|yes|đồng ý|đúng)$/u.test(normalized));
  const agreesToMerge =
    !saysSplit &&
    (saysStopSplit ||
      /(?:^|[^\p{L}])gộp(?:$|[^\p{L}])/u.test(normalized) ||
      /để chung|chung 1 ticket|một ticket|1 ticket/u.test(normalized) ||
      (negated && /(?:^|[^\p{L}])tách(?:$|[^\p{L}])/u.test(normalized)) ||
      /^(?:không|ko|k|no)$/u.test(normalized));

  if (agreesToSplit) return "split";
  if (agreesToMerge) return "merge";
  return "unknown";
}
