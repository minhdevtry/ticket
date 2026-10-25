/**
 * Tiện ích xử lý HTML entities và escaping cho tương tác giữa Itsaplan và Telegram.
 *
 * Chiều 1: Itsaplan → Telegram
 * - Bình luận/mô tả trên Itsaplan được nhập qua trình soạn thảo (Tiptap/WYSIWYG/Markdown),
 *   các ký tự đặc biệt như `<`, `>`, `&`, `"`, `'` được lưu dưới dạng HTML entities
 *   (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;`...).
 * - Telegram bot gửi tin nhắn dạng Markdown/plain text không tự giải mã entities này,
 *   khiến người dùng thấy chuỗi thô `&lt;` thay vì `<` (ví dụ TECH-691: `UID là 900015 &lt; 900016`).
 * - `decodeHtmlEntities()` giải mã một lần (single-pass regex) để không decode hai lần
 *   (tránh biến `&amp;lt;` thành `<` sai nghĩa, tránh XSS/chèn thẻ).
 *
 * Chiều 2: Telegram/bot → Itsaplan
 * - Lời kể người báo từ Telegram/bot được đưa vào mô tả ticket hoặc bình luận Itsaplan.
 * - Trình hiển thị Itsaplan (marked + DOMPurify) coi `<tag>` (ví dụ `<NullPointerException>`, `<Lỗi>`)
 *   là thẻ HTML và DOMPurify xoá trắng thẻ đó, làm mất thông tin người báo cung cấp.
 * - `escapeItsaplanMarkdown()` mã hóa `<` thành `&lt;` và `>` thành `&gt;` ngoài các khối code,
 *   giữ nguyên ký tự `&` để tránh escape đôi các entity sẵn có.
 */

const NAMED_HTML_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  bull: "•",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  sect: "§",
  para: "¶",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  micro: "µ",
  middot: "·",
};

/**
 * Giải mã HTML entities một lần (single-pass) từ văn bản HTML/rich-text sang văn bản thuần/markdown.
 *
 * Bất biến an toàn:
 * - Single-pass regex quét từ trái qua phải, không bao giờ decode lặp lại (ví dụ `&amp;lt;` -> `&lt;`, KHÔNG thành `<`).
 * - Hỗ trợ cả entity có tên (`&lt;`), số thập phân (`&#60;`), và số thập lục phân (`&#x3C;`).
 * - Không làm thay đổi tiếng Việt có dấu hay ký tự Unicode khác.
 */
export function decodeHtmlEntities(text?: string | null): string {
  if (!text || typeof text !== "string") return text ?? "";

  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g, (match, hex, dec, named) => {
    if (hex) {
      try {
        const codePoint = parseInt(hex, 16);
        if (codePoint > 0 && codePoint <= 0x10ffff) {
          return String.fromCodePoint(codePoint);
        }
      } catch {
        return match;
      }
    }
    if (dec) {
      try {
        const codePoint = parseInt(dec, 10);
        if (codePoint > 0 && codePoint <= 0x10ffff) {
          return String.fromCodePoint(codePoint);
        }
      } catch {
        return match;
      }
    }
    if (named) {
      const lower = named.toLowerCase();
      if (NAMED_HTML_ENTITIES[lower] !== undefined) {
        return NAMED_HTML_ENTITIES[lower];
      }
    }
    return match;
  });
}

/**
 * Mã hóa ký tự đặc biệt cho định dạng Markdown của Itsaplan.
 *
 * Quy tắc:
 * - Mã hóa `<` thành `&lt;` và `>` thành `&gt;` ở ngoài khối code (inline code `...` hoặc code fence ```...```)
 *   để trình phân tích Markdown và bộ lọc DOMPurify của Itsaplan không coi đó là thẻ HTML và xoá mất nội dung.
 * - Giữ nguyên ký tự `&` (không biến thành `&amp;`) để không gây lỗi escape đôi cho các entity đã có.
 * - Giữ nguyên nội dung bên trong code block / inline code vì CommonMark đã tự xử lý literal bên trong code.
 */
export function escapeItsaplanMarkdown(text?: string | null): string {
  if (!text || typeof text !== "string") return text ?? "";

  // Tách văn bản theo code fence (```...```) và inline code (`...`) để không escape thừa bên trong code
  const codeRegex = /(```[\s\S]*?```|`[^`\n]*`)/g;
  const parts = text.split(codeRegex);

  return parts
    .map((part, index) => {
      // Chỉ số lẻ là nội dung bên trong code block / inline code -> giữ nguyên
      if (index % 2 === 1) {
        return part;
      }
      return part.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("");
}

/**
 * Mã hóa ký tự theo chuẩn Telegram HTML mode (&, <, >).
 */
export function escapeTelegramHtml(text?: string | null): string {
  if (!text || typeof text !== "string") return text ?? "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Mã hóa HTML tổng quát (&, <, >, ", ').
 */
export function escapeHtml(text?: string | null): string {
  if (!text || typeof text !== "string") return text ?? "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
