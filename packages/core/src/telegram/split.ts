/**
 * Split a long message into Telegram-sized chunks WITHOUT breaking formatting.
 *
 * NGUỒN: CM `lib/formatting.ts` — the `TELEGRAM_TEXT_LIMIT = 4096` constant and
 * the UTF-16/code-point counting rule (`catKyTu`, R7E-B1): Telegram counts a
 * message in UTF-16 units, so a split by `.length` can still overflow on
 * astral-plane characters and a split by byte can cut a Vietnamese character in
 * half. CM's single-message cut REPLACES overflow with a truncation marker; here
 * we instead SPLIT into several messages (the notifier case), reusing the same
 * boundary-safety rule so neither path can emit a half character or an orphaned
 * combining mark.
 *
 * Rule R7E-B1: overflow is not a soft limit — `sendMessage` returns
 * `400 message is too long`, which `interpret()` files as non-retryable, so the
 * recipient never sees the message. Splitting correctly is the only safe path.
 */

/** Telegram Bot API `sendMessage` ceiling: 1–4096 UTF-16 units. (CM) */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Trailing fragments that must not be left dangling after a cut (CM `DUOI_TO_HOP`):
 * ZWJ, variation selectors, skin-tone modifiers, combining marks. */
const TRAILING_COMBINER = /[\u200d\ufe0f\u{1F3FB}-\u{1F3FF}\p{Mn}]+$/u;

/** UTF-16 unit length — what Telegram actually counts against the limit. */
function u16len(s: string): number {
  return s.length;
}

/**
 * Split `text` into chunks each within `limit` UTF-16 units, preferring the
 * latest safe boundary (paragraph break, then line break, then whitespace) so a
 * chunk never ends mid-word, mid-surrogate, or on an orphaned combining mark.
 *
 * A single token longer than the limit (a giant URL, a base64 blob) is hard-cut
 * on a code-point boundary — correctness over prettiness, because an un-split
 * over-limit chunk is the R7E-B1 lost message.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (limit <= 0) return [text];
  if (u16len(text) <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (u16len(rest) > limit) {
    const window = sliceU16(rest, limit);
    let cut = bestBoundary(window);
    // No safe boundary inside the window ⇒ hard-cut on a code-point boundary.
    if (cut <= 0) cut = codePointSafeCut(rest, limit);

    let head = rest.slice(0, cut).replace(/\s+$/u, "");
    // Never strand a combining mark / ZWJ at the end of a chunk.
    head = head.replace(TRAILING_COMBINER, "");
    if (head.length === 0) head = sliceU16(rest, codePointSafeCut(rest, limit));

    chunks.push(head);
    rest = rest.slice(head.length).replace(/^\s+/u, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** The first `limit` UTF-16 units, not splitting a surrogate pair. */
function sliceU16(s: string, limit: number): string {
  if (s.length <= limit) return s;
  let end = limit;
  // Do not cut between the halves of a surrogate pair.
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Largest cut on a code-point boundary within `limit` UTF-16 units. */
function codePointSafeCut(s: string, limit: number): number {
  let cut = 0;
  for (const ch of s) {
    if (cut + ch.length > limit) break;
    cut += ch.length;
  }
  return cut || Math.min(limit, s.length);
}

/**
 * Prefer the latest paragraph break, else the latest line break, else the latest
 * whitespace, inside the window. Returns 0 when the window has no safe boundary.
 */
function bestBoundary(window: string): number {
  const para = window.lastIndexOf("\n\n");
  if (para > 0) return para + 2;
  const line = window.lastIndexOf("\n");
  if (line > 0) return line + 1;
  const space = window.search(/\s(?=\S*$)/u);
  if (space > 0) return space + 1;
  return 0;
}
