/**
 * `@vuihoc/bot-core/telegram` — render: tracker text ↔ Telegram display.
 *
 * Hai chiều hiển thị, thuần hàm (no I/O):
 *
 *  (a) tracker → Telegram: nội dung comment/mô tả Itsaplan (HTML Tiptap, highlight
 *      `<mark>`/`<span>` sau bản nâng cấp `5bf501e`, markdown ảnh, thẻ `<video>`,
 *      mention bot) → text an toàn cho một parse mode đã chọn, kèm danh sách URL
 *      ảnh/video bóc riêng. Escape đúng để tên có `_` `*` `[` `` ` `` không làm
 *      hỏng tin (`40f7062`: `PO_UserC` biến thành chữ nghiêng dở → Telegram từ
 *      chối cả tin). Có `plain` fallback khi không muốn/không thể định dạng.
 *
 *  (b) Telegram → tracker: tin người dùng → markdown sạch cho tracker: bỏ "phong
 *      bì" kênh (`d0d1ed9`: lọc theo nội dung, qua `stripChannelEnvelope` của core),
 *      bỏ thẻ media nội bộ (`cleanMediaTags`), GIỮ xuống dòng, còn lại NGUYÊN VĂN
 *      (`7323bc7`: mô tả ticket là lời nguyên văn của người báo).
 *
 *  (c) helpers link/nhãn ticket: nhãn là THAM SỐ (không chuỗi tiếng Việt cố định
 *      trong logic — mọi câu chữ do nơi gọi truyền vào).
 *
 * Dùng lại core (`stripCommentHtml`, `stripChannelEnvelope`, `cleanMediaTags`,
 * `stripBotMentions`) — không chép lại.
 */
import {
  cleanMediaTags,
  stripBotMentions,
  stripChannelEnvelope,
  stripCommentHtml,
} from "../../core";

/**
 * Parse mode của Telegram mà render hướng tới.
 *
 * `"Markdown"` là bản LEGACY (chữ intake dùng ở `notifier.ts`:
 * `parse_mode: "Markdown"`), KHÔNG phải MarkdownV2 — chúng escape khác nhau.
 * `"plain"` = không định dạng: dùng khi Telegram đã từ chối định dạng
 * (`isEntityParseError` → gửi lại dạng text thuần, `40f7062`), hoặc khi nơi gọi
 * cố ý không muốn định dạng.
 */
export type ParseMode = "Markdown" | "plain";

/** Parse mode mặc định — khớp intake notifier. */
export const DEFAULT_PARSE_MODE: ParseMode = "Markdown";

/**
 * Ký tự Telegram LEGACY Markdown coi là mở/đóng entity: `_` (nghiêng), `*` (đậm),
 * `` ` `` (mã), `[` (mở link). Một ký tự lẻ không có cặp đóng ⇒ "can't parse
 * entities" ⇒ Telegram từ chối tin (bug `40f7062`: tên `PO_UserC`, `@PRO_UserB`).
 *
 * Legacy Markdown chỉ hỗ trợ escape bằng `\` cho đúng bốn ký tự này; các ký tự
 * MarkdownV2 khác (`~`, `>`, `#`, …) KHÔNG phải entity ở legacy nên không escape.
 */
const LEGACY_MD_ENTITY_CHARS = /[_*`[\]]/g;

/**
 * Escape một đoạn text thường cho legacy Markdown: đặt `\` trước mỗi ký tự
 * entity để nó hiển thị NGUYÊN VĂN thay vì mở một entity dở dang.
 *
 * Đây là chốt chặn cho `40f7062`: tên người, mã lớp, username có `_`/`*`/`[`
 * đi qua đây thì không bao giờ làm Telegram từ chối tin nữa.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(LEGACY_MD_ENTITY_CHARS, (ch) => `\\${ch}`);
}

/**
 * Escape text theo parse mode. `"plain"` không cần escape (Telegram không parse
 * entity nào), trả nguyên văn.
 */
export function escapeForParseMode(text: string, mode: ParseMode = DEFAULT_PARSE_MODE): string {
  return mode === "Markdown" ? escapeMarkdown(text) : text;
}

/**
 * Bỏ phần `**` in đậm bot tự thêm, giữ nguyên chữ người viết — bản render của
 * `plainText()` trong intake `notifier.ts`, dùng khi hạ một tin đã dựng kèm
 * định dạng xuống dạng thuần (fallback khi Telegram từ chối entity).
 */
export function toPlainText(text: string): string {
  return text.replace(/\*\*/g, "");
}

/**
 * Telegram báo không parse được entity? (Markdown dở dang) — khi đúng, nơi gọi
 * gửi lại tin với `parse_mode` bỏ đi và text đã qua {@link toPlainText}.
 * Bản tách khỏi `isEntityParseError` trong intake `notifier.ts`.
 */
export function isEntityParseError(err: unknown): boolean {
  return /can'?t parse entities/i.test(String((err as { message?: unknown })?.message ?? err));
}

export interface TrackerToTelegram {
  /** Text đã sạch HTML, bỏ markdown ảnh, bỏ mention bot, escape theo parse mode. */
  text: string;
  /** URL ảnh bóc từ markdown `![alt](url)`. */
  images: string[];
  /** URL video bóc từ thẻ `<video src="…">`. */
  videos: string[];
}

export interface RenderTrackerOptions {
  /** Parse mode đích; mặc định `"Markdown"`. `"plain"` thì không escape. */
  parseMode?: ParseMode;
  /** Handle bot thêm cần gỡ (ngoài danh sách core), ví dụ handle riêng của bot này. */
  extraBotHandles?: string[];
  /** Giữ cú pháp markdown ảnh trong `text` thay vì bóc ra (mặc định bóc + xoá). */
  keepImageMarkdown?: boolean;
}

const MD_IMAGE = /!\[[^\]]*\]\(([^)]*)\)/g;
const HTML_VIDEO_SRC = /<video\b[^>]*\bsrc="([^"]*)"[^>]*>/gi;

/**
 * tracker → Telegram.
 *
 * Thứ tự: (1) bóc URL video từ thẻ `<video>` TRƯỚC khi strip HTML (strip sẽ xoá
 * thẻ); (2) bóc URL ảnh từ markdown `![alt](url)`; (3) strip HTML Tiptap
 * (`stripCommentHtml`: `<video>`, `<mark>`, `<span>` — `5bf501e`); (4) bỏ cú pháp
 * markdown ảnh khỏi text; (5) gỡ mention bot (`stripBotMentions`); (6) escape
 * theo parse mode (`40f7062`).
 */
export function renderTrackerToTelegram(
  body: string | null | undefined,
  options: RenderTrackerOptions = {},
): TrackerToTelegram {
  const { parseMode = DEFAULT_PARSE_MODE, extraBotHandles = [], keepImageMarkdown = false } = options;
  const src = typeof body === "string" ? body : "";

  const videos = dedupe(matchAll(src, HTML_VIDEO_SRC));
  const images = dedupe(matchAll(src, MD_IMAGE));

  let text = stripCommentHtml(src);
  if (!keepImageMarkdown) text = text.replace(MD_IMAGE, "");
  text = stripBotMentions(text, extraBotHandles);
  // Gộp dòng trống thừa do xoá ảnh/thẻ để lại, giữ tối đa một dòng trống.
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  text = escapeForParseMode(text, parseMode);

  return { text, images, videos };
}

export interface RenderTelegramOptions {
  /** Handle bot thêm cần gỡ. */
  extraBotHandles?: string[];
  /** Cũng gỡ mention bot khỏi lời người dùng (mặc định KHÔNG — giữ nguyên văn). */
  stripMentions?: boolean;
}

/**
 * Telegram → tracker.
 *
 * Người dùng gõ gì, tracker nhận NGUYÊN VĂN đúng vậy (`7323bc7`: mô tả = lời
 * người báo), CHỈ bỏ hai thứ rác máy sinh: (1) phong bì kênh OpenClaw gắn vào
 * (`stripChannelEnvelope` — `d0d1ed9` lọc theo nội dung, bắt cả `chat_id`,
 * `username`, lịch sử hội thoại, payload nút máy); (2) thẻ media nội bộ
 * `[media attached: …]`/`<media:…>` (`cleanMediaTags`). GIỮ xuống dòng — tracker
 * là markdown nên `\n` có nghĩa.
 *
 * KHÔNG escape gì: tracker không phải Telegram, markdown của nó khác và lời
 * người báo phải nguyên văn.
 */
export function renderTelegramToTracker(
  message: string | null | undefined,
  options: RenderTelegramOptions = {},
): string {
  const { extraBotHandles = [], stripMentions = false } = options;
  const src = typeof message === "string" ? message : "";

  let out = stripChannelEnvelope(src);
  out = cleanMediaTags(out);
  if (stripMentions) out = stripBotMentions(out, extraBotHandles);

  // Giữ xuống dòng; chỉ gộp 3+ dòng trống thành một dòng trống, cắt khoảng
  // trắng hai đầu. KHÔNG đụng tới nội dung giữa.
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Nhãn link ticket, nhãn là THAM SỐ.
 *
 * `label` là chữ hiển thị (nơi gọi truyền vào — không chuỗi tiếng Việt cố định
 * ở đây), `url` là link ticket. Legacy Markdown: `[label](url)`; nhãn được
 * escape để `_`/`*`/`[` trong nhãn không làm hỏng link, URL để nguyên. `"plain"`
 * trả `"label: url"`.
 */
export function renderTicketLink(label: string, url: string, mode: ParseMode = DEFAULT_PARSE_MODE): string {
  const safeLabel = escapeForParseMode(label, mode);
  if (mode === "plain") return `${label}: ${url}`;
  return `[${safeLabel}](${url})`;
}

/**
 * Dòng `prefix: value` cho tin, cả hai là THAM SỐ (prefix do nơi gọi truyền —
 * không literal tiếng Việt). `value` được escape; `boldPrefix` bọc prefix bằng
 * `**` (legacy Markdown in đậm). `"plain"` trả `"prefix: value"` không định dạng.
 */
export function renderLabeledValue(
  prefix: string,
  value: string,
  mode: ParseMode = DEFAULT_PARSE_MODE,
  boldPrefix = false,
): string {
  if (mode === "plain") return `${prefix}: ${value}`;
  const p = boldPrefix ? `**${escapeMarkdown(prefix)}**` : escapeMarkdown(prefix);
  return `${p}: ${escapeMarkdown(value)}`;
}

function matchAll(src: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const v = (m[1] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
