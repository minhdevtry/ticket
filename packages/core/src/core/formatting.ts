/**
 * Tiện ích định dạng chuỗi/thời gian và DẤU chống echo-loop cho comment bot —
 * chỉ phần CHUNG mọi bot dùng.
 *
 * MERGED (0.1.0):
 *  - `BOT_COMMENT_MARKER`/`markBotComment`/`isBotComment`: gốc intake, nhận thêm
 *    marker cũ của cả hai bot (`intake-bot`, `cm-bot`). Dấu GHI mặc định giữ
 *    `<!-- intake-bot -->` (worker đang chạy chỉ nhận dấu của mình), bot khác đặt
 *    bằng `setBotCommentMarker`.
 *  - `cleanMediaTags`/`extractMediaAttachments`/`formatIctTimestamp`: giống nhau
 *    ở cả hai; lấy bản intake.
 *  - `formatIctDate`, `foldForComparison`/`looseIncludes`: thêm từ CM (intake không có).
 *  - `stripCommentHtml`: thêm từ intake (CM không có) — gỡ thẻ Tiptap.
 *  - `stripBotMentions`: hợp nhất — giữ cách intake (danh sách handle + `extraHandles`)
 *    VÀ thêm luật CM (bỏ mọi `@<tên>_bot`).
 *
 * ĐỂ LẠI NGOÀI LÕI (gắn layout ticket của Tiểu Linh / kênh Telegram, không chung):
 *  - `appendTicketUpdateDescription` (layout "### Mô tả / Thông tin sự cố" của intake);
 *  - `isCommentRecentlyForwarded` (trạng thái toàn cục của worker intake);
 *  - `catTinChoTelegram`/`catKyTu`/`catDanhSach`/`danhDauCat` (cắt theo trần Telegram của CM).
 */

/**
 * Dấu vô hình gắn vào mọi bình luận do chính bot ghi lên tracker.
 *
 * Bot ghi comment → tracker bắn `comment.created` → worker thấy comment mới và
 * đẩy ngược về kênh → người dùng nhận lại đúng câu mình vừa nhắn. Vòng này có
 * thật, nên comment của bot phải tự nhận diện được. Markdown không hiện thẻ chú
 * thích HTML, nên người đọc trên tracker không thấy gì.
 *
 * KHÔNG đổi dấu đã ghi lên tracker: worker đang chạy (kg-sync, duplicate-merger,
 * notifier của intake; dispatcher của CM) chỉ nhận ra đúng dấu của mình. Đổi dấu
 * là comment bot bị coi như người viết — KG học lời khuyên của bot thành kiến
 * thức (ADR-0007 intake) và vòng echo quay lại. Vì vậy dấu GHI mặc định là dấu
 * của intake, bot khác đặt dấu của mình bằng `setBotCommentMarker` (CM: `cm-bot`).
 */
export const BOT_COMMENT_MARKER = "<!-- intake-bot -->";

/** Mọi dấu đã từng được ghi lên tracker — đều phải nhận ra để không gửi lặp. */
export const LEGACY_BOT_COMMENT_MARKERS = ["<!-- intake-bot -->", "<!-- cm-bot -->"];

let writeMarker = BOT_COMMENT_MARKER;

/** Đặt dấu mà bot này GHI (mặc định `<!-- intake-bot -->`). Phải là một thẻ chú thích HTML. */
export function setBotCommentMarker(marker: string): void {
  if (!/^<!--\s*[\w.-]+\s*-->$/.test(marker)) {
    throw new Error(`setBotCommentMarker: dấu phải có dạng <!-- ten-bot -->, nhận: ${marker}`);
  }
  writeMarker = marker;
}

/** Dấu bot này đang ghi. */
export function getBotCommentMarker(): string {
  return writeMarker;
}

/** Gắn dấu vào một bình luận bot sắp ghi lên tracker. */
export function markBotComment(body: string): string {
  if (isBotComment(body)) return body;
  return `${body}\n\n${writeMarker}`;
}

/** Bình luận này do bot ghi ra? (nhận dấu đang ghi lẫn mọi dấu đã từng ghi) */
export function isBotComment(body?: string | null): boolean {
  if (typeof body !== "string") return false;
  return body.includes(writeMarker) || LEGACY_BOT_COMMENT_MARKERS.some((m) => body.includes(m));
}

/**
 * Bỏ các thẻ media nội bộ (`[media attached: ...]`, `<media:...>`) để chúng
 * không lọt vào mô tả ticket.
 */
export function cleanMediaTags(str?: string | null): string {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/\[media attached:\s*[^\]]+\]/gi, "")
    .replace(/<media:\w+[^>]*>/gi, "")
    .trim();
}

/**
 * Trích xuất đường dẫn file ảnh/media đính kèm từ tin nhắn (vd `[media attached: ...]`).
 */
export function extractMediaAttachments(str?: string | null): string[] {
  if (!str || typeof str !== "string") return [];
  const matches = str.matchAll(/\[media attached:\s*([^\]]+?)(?:\s*\([^)]+\))?\]/gi);
  const paths: string[] = [];
  for (const m of matches) {
    if (m[1]) paths.push(m[1].trim());
  }
  return paths;
}

/**
 * Gỡ thẻ HTML nhúng trong bình luận tracker (`<video>`, `<mark>`, `<span>` của
 * Tiptap) trước khi gửi về kênh hoặc đưa vào LLM/KG. NGUỒN: intake (CM không có).
 */
export function stripCommentHtml(text?: string | null): string {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, "")
    .replace(/<\/?video\b[^>]*>/gi, "")
    .replace(/<\/?(?:mark|span)\b[^>]*>/gi, "");
}

/** Định dạng Date theo giờ Việt Nam UTC+7 (ICT) dạng `YYYY-MM-DD HH:mm`. */
export function formatIctTimestamp(date: Date = new Date()): string {
  const ict = new Date(date.getTime() + 7 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${ict.getUTCFullYear()}-${pad(ict.getUTCMonth() + 1)}-${pad(ict.getUTCDate())} ` +
    `${pad(ict.getUTCHours())}:${pad(ict.getUTCMinutes())}`
  );
}

/** Định dạng Date theo giờ Việt Nam UTC+7 (ICT) dạng `YYYY-MM-DD`. NGUỒN: CM. */
export function formatIctDate(date: Date = new Date()): string {
  const ict = new Date(date.getTime() + 7 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ict.getUTCFullYear()}-${pad(ict.getUTCMonth() + 1)}-${pad(ict.getUTCDate())}`;
}

/**
 * Bỏ dấu tiếng Việt + hạ chữ thường + gộp khoảng trắng: dạng dùng để SO KHỚP
 * giữa hai cách viết của cùng một ý. KHÔNG dùng để ghi DB. NGUỒN: CM.
 */
export function foldForComparison(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** `true` khi `needle` xuất hiện trong `haystack` khi bỏ dấu + gộp khoảng trắng. NGUỒN: CM. */
export function looseIncludes(haystack: string, needle: string): boolean {
  return foldForComparison(haystack).includes(foldForComparison(needle));
}

/**
 * Danh sách handle bot để lọc khỏi câu trao đổi (gốc intake).
 */
export const KNOWN_BOT_HANDLES = [
  "iris",
  "tieulinh",
  "bot-iris-intake",
  "bot-ticket-intake",
  "vhiris_bot",
  "vhticket_bot",
  "iris-bot",
  "intake",
  "intake-bot",
  "itsaplan_agent_bot",
  "cmsupport",
];

/**
 * Gỡ mọi mention tới bot khỏi nội dung trước khi gửi về kênh.
 *
 * HỢP NHẤT: cách intake (khớp theo danh sách `KNOWN_BOT_HANDLES` + `extraHandles`,
 * giữ được `@iris`, `@tieulinh`, `@bot-iris-intake` ở mọi vị trí) VÀ luật CM (bỏ
 * mọi `@<tên>_bot`, vd `@vh_teacher_sp_bot`). Hai lượt thay thế độc lập.
 */
export interface StripBotMentionsOptions {
  /**
   * Danh sách handle thay cho {@link KNOWN_BOT_HANDLES} (vd bot cũ chỉ muốn đúng
   * bộ handle của mình, không có `cmsupport`).
   */
  knownHandles?: readonly string[];
  /** Bỏ thêm mọi `@<tên>_bot` (luật CM). Mặc định `true`; intake cũ không có luật này. */
  stripBotSuffixHandles?: boolean;
}

export function stripBotMentions(
  text?: string | null,
  extraHandles: string[] = [],
  opts: StripBotMentionsOptions = {},
): string {
  if (!text || typeof text !== "string") return "";
  const knownHandles = opts.knownHandles ?? KNOWN_BOT_HANDLES;
  const stripSuffix = opts.stripBotSuffixHandles ?? true;
  // Lượt 1 (intake): danh sách handle cụ thể, ở bất kỳ vị trí nào, nuốt dấu nối ": , -".
  const allHandles = Array.from(new Set([...knownHandles, ...extraHandles])).filter(Boolean);
  const sorted = allHandles.sort((a, b) => b.length - a.length);
  const escaped = sorted.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const byList = new RegExp(`(?<=^|\\s)@(${escaped})(?![a-zA-Z0-9_-])\\s*(?:[:,-]\\s*)?`, "gi");
  // Lượt 2 (CM): mọi `@<tên>_bot` còn sót. Nuốt luôn một khoảng trắng theo sau
  // (như lượt 1) để bỏ mention giữa câu không để lại khoảng trắng đôi.
  const byListOnly = text.replace(byList, "");
  return (stripSuffix ? byListOnly.replace(/@\w+_bot\b\s*/gi, "") : byListOnly).trim();
}
