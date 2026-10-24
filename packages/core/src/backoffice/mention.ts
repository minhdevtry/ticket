/**
 * Đọc prompt của run `mention`.
 *
 * Server "đóng khung" prompt: có câu dẫn nói agent được nhắc ở issue nào, dòng chỉ
 * dẫn trả lời (kèm `replyToId` của comment gốc), tuỳ chọn các comment cha trong luồng,
 * rồi sau dòng `The comment that mentioned you:` là NGUYÊN VĂN comment. Khung này do
 * server chọn nên có thể đổi; hàm này lấy phần nó nhận ra được và, khi không thấy
 * dấu hiệu nào, coi cả prompt là nội dung comment (không bao giờ ném).
 */
import { stripBotMentions, stripCommentHtml } from "../core/formatting";

const COMMENT_MARKER = "The comment that mentioned you:";
const THREAD_MARKER = "oldest first:";

export interface MentionComment {
  /** Nguyên văn comment, chưa lọc. */
  raw: string;
  /** Đã gỡ thẻ HTML của editor và các @mention của chính bot. */
  text: string;
  /** Id comment cần trả lời vào luồng của nó (nếu khung nêu). */
  replyToId: number | null;
  /** Các comment cha, cũ trước. */
  threadContext: string | null;
  /** Prompt có đúng khung đã biết không (false = đang đoán). */
  framed: boolean;
}

/** Phân tích prompt mention. `handles` là các handle của bot cần gỡ khỏi `text`. */
export function parseMentionPrompt(prompt: string, handles: string[] = []): MentionComment {
  const at = prompt.lastIndexOf(COMMENT_MARKER);
  const framed = at !== -1;
  const raw = (framed ? prompt.slice(at + COMMENT_MARKER.length) : prompt).trim();
  const head = framed ? prompt.slice(0, at) : "";

  const reply = head.match(/replyToId\s+(\d+)/);
  let threadContext: string | null = null;
  const threadAt = head.indexOf(THREAD_MARKER);
  if (threadAt !== -1) {
    const ctx = head.slice(threadAt + THREAD_MARKER.length).trim();
    threadContext = ctx || null;
  }

  return {
    raw,
    text: stripBotMentions(stripCommentHtml(raw), handles),
    replyToId: reply ? Number(reply[1]) : null,
    threadContext,
    framed,
  };
}
