/**
 * Bỏ "phong bì" kênh mà OpenClaw gắn quanh tin nhắn (Conversation info / Sender /
 * Conversation context ... "(untrusted metadata)") trước khi chữ vào tờ khai.
 *
 * 26/09: model chuyển nguyên phong bì vào intake_step → mô tả TECH-922, TECH-924
 * lộ chat_id, username, cả lịch sử hội thoại (tech lead: "lộ quá"). Chặn ở MCP
 * để model nào cũng ra cùng kết quả, không trông vào prompt.
 *
 * 27/09: TECH-946 lộ theo 2 dạng mới mà bản trên không bắt được:
 * - Header có tiền tố mốc giờ trong ngoặc vuông, vd
 *   "[Sun 2026-09-27 09:20 GMT+7] Conversation info (untrusted metadata):".
 * - Phong bì bị model "làm phẳng" chung một dòng, vd
 *   "Conversation info (untrusted metadata): chat_id: …, callback_data: Sale".
 * Cả hai đều có thể tới kèm tiền tố quote "> " (khi ticket cũ trích dẫn lại) —
 * xử lý khoan dung với "> " ở đầu mỗi dòng trước khi nhận diện.
 * Đồng thời "callback_data: …" (payload nút bấm) không phải nội dung người báo,
 * bỏ luôn khi nó đứng riêng một dòng.
 */
const HEADER_NAMES =
  "(conversation info|sender|conversation context|replied message|reply context|forwarded message|chat history|message context)";
// Cả dòng chỉ là header (có thể có tiền tố "[…mốc giờ…]"), theo sau là block JSON/ngữ cảnh riêng dòng khác.
const HEADER = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]\\s*)?${HEADER_NAMES}\\b[^\\n]*\\(untrusted[^)]*\\)\\s*:?\\s*$`,
  "i",
);
// Phong bì bị làm phẳng chung dòng với chữ khác: từ tên header (untrusted…) tới hết dòng là rác, bỏ.
const INLINE_ENVELOPE = new RegExp(`${HEADER_NAMES}\\b[^\\n]*\\(untrusted[^)]*\\)[^\\n]*$`, "i");
// callback_data đứng riêng một dòng là payload nút bấm, không phải lời người báo.
const CALLBACK_LINE = /^\s*callback_data\s*:\s*([^\n]*)$/i;
// Payload nút dạng mã máy "tên_lệnh:đối_số" (không phải nhãn chữ người đọc).
const MACHINE_PAYLOAD = /^[a-z][a-z0-9_]*:[\w:.-]+$/i;
/** Token payload nút nội bộ (như "noop" của nút đã khoá) — TECH-1148. */
export const INTERNAL_CALLBACK_TOKENS: Record<string, true> = {
  noop: true,
  none: true,
  ignore: true,
  nil: true,
};

/** Kiểm tra token có phải là payload nút nội bộ hoặc mã máy không phải nhãn chữ người đọc. */
export function isInternalCallbackToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const clean = token.trim().toLowerCase();
  return Boolean(INTERNAL_CALLBACK_TOKENS[clean]) || MACHINE_PAYLOAD.test(clean);
}
// Khoá định danh kênh trong JSON phong bì.
const ENVELOPE_KEYS = /"(chat_id|sender_id|message_id|inbound_event_kind|username)"\s*:/i;
// "Sender: Tên (id), username: xxx" — bản phẳng của khối Sender.
const SENDER_LINE = /^\s*sender\s*:[^\n]*\busername\s*:/i;
// Dòng lịch sử chat OpenClaw: "#11354 Sun 2026-09-27 09:20:04 GMT+7 Tên: …", "#session:ab12 Sat 2026-…".
const HISTORY_LINE = /^\s*#(\d+|session:[0-9a-f]+)\s+\w{3}\s+\d{4}-/i;
// Header ngữ cảnh mà model đã cắt mất đuôi "(untrusted …)".
const BARE_CONTEXT_HEADER = /^\s*(conversation context|chat history[^:\n]*)\s*:\s*$/i;

export function stripChannelEnvelope(text: string | null | undefined): string {
  const src = String(text ?? "");
  if (!/\(untrusted/i.test(src) && !/^\s*>?\s*callback_data\s*:/im.test(src) && !ENVELOPE_KEYS.test(src) && !SENDER_LINE.test(src) && !/^\s*>?\s*#(\d+|session:)/m.test(src)) return src;
  // Khoan dung tiền tố quote "> " (ticket trích dẫn lại phong bì) ở đầu mỗi dòng.
  const lines = src.split("\n").map((line) => line.replace(/^\s*>\s?/, ""));
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (HEADER.test(line)) {
      i++;
      // Header và block có thể cách nhau dòng trống (TECH-928: "Conversation info…:" / ">" / ```json).
      while (i < lines.length && !lines[i].trim()) i++;
      const next = lines[i] ?? "";
      if (/^\s*```/.test(next)) {
        // ```json … ```
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
        i++;
      } else if (/^\s*\{\s*$/.test(next)) {
        // JSON trần: tới khi đóng ngoặc
        let depth = 0;
        do {
          depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
          i++;
        } while (i < lines.length && depth > 0);
      } else {
        // Ngữ cảnh hội thoại: các dòng "#10917 …", "#session:… …" tới dòng trống
        while (i < lines.length && /^\s*#/.test(lines[i])) i++;
      }
      continue;
    }
    // Khối JSON (một hay nhiều dòng, kể cả dòng kết thúc "\" của markdown) chứa khoá
    // định danh kênh là phong bì dù không có header (TECH-930, TECH-946).
    if (/^\s*\{/.test(line)) {
      let j = i;
      let depth = 0;
      const block: string[] = [];
      do {
        const l = lines[j].replace(/\\\s*$/, "");
        block.push(l);
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        j++;
      } while (j < lines.length && depth > 0);
      if (ENVELOPE_KEYS.test(block.join("\n"))) {
        i = j;
        continue;
      }
    }
    // callback_data: <nhãn nút> — người dùng BẤM NÚT: giữ lại nhãn, đó là câu trả lời của họ
    // (28/09: bỏ hẳn dòng này làm "Sự cố mới" bấm xong thành rỗng, bot hỏi lại "chưa rõ ý").
    const callback = line.match(CALLBACK_LINE);
    if (callback) {
      // Payload máy ("reporter_ok:481", "confirm_done:12") hoặc token nội bộ ("noop") thì bỏ — TECH-940, TECH-1148.
      const label = callback[1].trim();
      if (label && !isInternalCallbackToken(label)) out.push(label);
      i++;
      continue;
    }
    if (SENDER_LINE.test(line) || HISTORY_LINE.test(line) || BARE_CONTEXT_HEADER.test(line)) {
      i++;
      continue;
    }
    const inlineMatch = line.match(INLINE_ENVELOPE);
    if (inlineMatch && inlineMatch.index !== undefined) {
      const prefix = line.slice(0, inlineMatch.index).trim();
      if (prefix) out.push(prefix);
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
