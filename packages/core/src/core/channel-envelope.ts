/**
 * Bỏ "phong bì" kênh mà OpenClaw gắn quanh tin nhắn (Conversation info / Sender /
 * Conversation context ... "(untrusted metadata)") trước khi chữ vào xử lý.
 *
 * 26/09: model chuyển nguyên phong bì vào intake_step → mô tả TECH-922/924 lộ
 * chat_id, username, cả lịch sử hội thoại. Chặn ở lớp lõi để model nào cũng ra
 * cùng kết quả, không trông vào prompt.
 *
 * 27/09: TECH-946 lộ theo 2 dạng mới — header có tiền tố mốc giờ "[…]", và phong
 * bì bị "làm phẳng" chung một dòng. Cả hai có thể kèm tiền tố quote "> ".
 *
 * MERGED (0.1.0): lấy bản CM — nó là SIÊU TẬP của bản intake:
 *  - thêm chốt `?? ""` an toàn khi chỉ số lệch (intake truyền `undefined` vào
 *    `RegExp.test`, bị JS ép thành `"undefined"` → header giả có thể khớp);
 *  - thêm xử lý khối ``` ``` do người dùng DÁN (giữ nếu không chứa khoá kênh);
 *  - thêm bảo toàn phần `tail` sau khối JSON và không nuốt lời người dùng khi
 *    khối chiếm trọn tin (đo thật: CM `docs/qa/r5A-FIXBLIND.md` N-8);
 *  - thêm `extractChannelEnvelope` để lấy metadata kênh phục vụ xác thực danh tính.
 * Mọi case test của intake vẫn xanh với bản này.
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
  if (
    !/\(untrusted/i.test(src) &&
    !/^\s*>?\s*callback_data\s*:/im.test(src) &&
    !ENVELOPE_KEYS.test(src) &&
    !SENDER_LINE.test(src) &&
    !/^\s*>?\s*#(\d+|session:)/m.test(src)
  ) {
    return src;
  }

  // Khoan dung tiền tố quote "> " (ticket trích dẫn lại phong bì) ở đầu mỗi dòng.
  const lines = src.split("\n").map((line) => line.replace(/^\s*>\s?/, ""));
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // `?? ""` là CHỐT an toàn thật, không phải lách kiểu: nếu chỉ số lệch, biểu
    // thức cũ truyền `undefined` vào `RegExp.test` — JS ép thành chuỗi `"undefined"`,
    // nên header/fence giả có thể khớp. Chuỗi rỗng thì không khớp gì.
    const line = lines[i] ?? "";

    if (HEADER.test(line)) {
      i++;
      // Header và block có thể cách nhau dòng trống
      while (i < lines.length && !(lines[i] ?? "").trim()) i++;
      const next = lines[i] ?? "";
      if (/^\s*```/.test(next)) {
        // ```json … ```
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) i++;
        i++;
      } else if (/^\s*\{\s*$/.test(next)) {
        // JSON trần: tới khi đóng ngoặc
        let depth = 0;
        do {
          depth += ((lines[i] ?? "").match(/\{/g) ?? []).length - ((lines[i] ?? "").match(/\}/g) ?? []).length;
          i++;
        } while (i < lines.length && depth > 0);
      } else {
        // Ngữ cảnh hội thoại: các dòng "#10917 …", "#session:… …" tới dòng trống
        while (i < lines.length && /^\s*#/.test(lines[i] ?? "")) i++;
      }
      continue;
    }

    // Khối JSON chứa khoá định danh kênh là phong bì dù không có header.
    if (/^\s*\{/.test(line)) {
      let j = i;
      let depth = 0;
      const block: string[] = [];
      do {
        const l = (lines[j] ?? "").replace(/\\\s*$/, "");
        block.push(l);
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        j++;
      } while (j < lines.length && depth > 0);
      if (ENVELOPE_KEYS.test(block.join("\n"))) {
        // Người dùng có thể DÁN kết quả lỗi từ trình duyệt ngay đầu dòng: phong
        // bì hệ thống nằm cùng dòng với lời họ. Chỉ cắt đúng khối JSON, giữ phần
        // chữ đứng sau `}` cuối. Khi `}` cuối nằm riêng dòng, `tail` rỗng.
        const closeAt = (lines[j - 1] ?? "").lastIndexOf("}");
        const tail = closeAt >= 0 ? lines[j - 1]!.slice(closeAt + 1).trim() : "";
        // Khối chiếm TRỌN tin và không chừa chữ nào khác ⇒ bỏ khối đi thì tin
        // thành rỗng, tức nuốt mất lời người dùng. Giữ nguyên khối JSON.
        if (!tail && out.length === 0 && j >= lines.length) {
          out.push(lines.slice(i, j).join("\n"));
        } else if (tail) {
          out.push(tail);
        }
        i = j;
        continue;
      }
    }

    // Khối mã ``` … ``` do người dùng dán (không có header hệ thống đi kèm): nếu
    // bên trong có khoá phong bì, bỏ nguyên cả rào + nội dung, giữ lời ngoài rào.
    // Nếu bên trong KHÔNG có khoá phong bì, giữ nguyên để bot đọc được mã người
    // dùng dán (không nuốt dữ liệu thật của họ).
    if (/^\s*```/.test(line ?? "")) {
      const opener = line?.match(/^\s*```[A-Za-z0-9_-]*\s*$/);
      if (opener) {
        const body: string[] = [];
        let k = i + 1;
        while (k < lines.length && !/^\s*```\s*$/.test(lines[k] ?? "")) {
          body.push(lines[k] ?? "");
          k++;
        }
        if (k < lines.length && ENVELOPE_KEYS.test(body.join("\n"))) {
          i = k + 1;
          continue;
        }
      }
    }

    // callback_data: <nhãn nút> — người dùng BẤM NÚT: giữ lại nhãn, đó là câu trả lời của họ.
    const callback = line.match(CALLBACK_LINE);
    if (callback) {
      // Payload máy ("reporter_ok:481", "confirm_done:12") thì bỏ.
      const label = (callback[1] ?? "").trim();
      if (label && !MACHINE_PAYLOAD.test(label)) out.push(label);
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

export interface ChannelEnvelopeInfo {
  sender_id?: string;
  chat_id?: string;
  username?: string;
  sender_name?: string;
}

/**
 * Lấy metadata kênh đã được OpenClaw/Telegram gắn (để xác thực danh tính phía
 * server, chống giả mạo). NGUỒN: CM `extractChannelEnvelope` (bản intake không có).
 */
export function extractChannelEnvelope(text: string | null | undefined): ChannelEnvelopeInfo {
  const src = String(text ?? "");
  const info: ChannelEnvelopeInfo = {};

  if (!src) return info;

  // 1. Look for JSON blocks inside markdown or braces
  const jsonBlocks = src.match(/```(?:json)?\s*([\s\S]*?)\s*```/gi) ?? [];
  const rawBlocks = src.match(/\{[\s\S]*?\}/g) ?? [];
  const allBlocks = [
    ...jsonBlocks.map((b) => b.replace(/```(?:json)?/gi, "").replace(/```/g, "")),
    ...rawBlocks,
  ];

  for (const block of allBlocks) {
    try {
      const parsed = JSON.parse(block.trim());
      if (typeof parsed === "object" && parsed !== null) {
        if (parsed.sender_id && !info.sender_id) {
          info.sender_id = String(parsed.sender_id).replace(/^telegram:/i, "");
        }
        if (parsed.chat_id && !info.chat_id) {
          info.chat_id = String(parsed.chat_id).replace(/^telegram:/i, "");
        }
        if (parsed.username && !info.username) {
          info.username = String(parsed.username);
        }
        if (parsed.sender && !info.sender_name) {
          info.sender_name = String(parsed.sender);
        }
        if (parsed.label && !info.sender_id) {
          const m = String(parsed.label).match(/\((?:telegram:)?(\d+)\)/i);
          if (m?.[1]) info.sender_id = m[1];
          if (!info.sender_name) {
            const nameMatch = String(parsed.label).match(/^(.*?)\s*\(/);
            if (nameMatch?.[1]) info.sender_name = nameMatch[1].trim();
          }
        }
      }
    } catch {
      // Ignore non-json blocks
    }
  }

  // 2. Inline patterns: sender_id, Sender: Name (id), chat_id, username
  if (!info.sender_id) {
    const senderIdMatch = src.match(/sender_id\s*[:=]\s*(?:telegram:)?(\d+)/i);
    if (senderIdMatch?.[1]) info.sender_id = senderIdMatch[1];
  }

  if (!info.sender_id) {
    const senderLineMatch = src.match(/Sender:\s*([^(]+)\s*\((?:telegram:)?(\d+)\)/i);
    if (senderLineMatch?.[2]) {
      if (!info.sender_name && senderLineMatch[1]) info.sender_name = senderLineMatch[1].trim();
      info.sender_id = senderLineMatch[2];
    }
  }

  if (!info.chat_id) {
    const chatIdMatch = src.match(/chat_id\s*[:=]\s*["']?(?:telegram:)?(\d+)/i);
    if (chatIdMatch?.[1]) info.chat_id = chatIdMatch[1];
  }

  if (!info.username) {
    const usernameMatch = src.match(/username\s*[:=]\s*["']?([\w_]+)/i);
    if (usernameMatch?.[1]) info.username = usernameMatch[1];
  }

  if (!info.sender_name) {
    const senderMatch = src.match(/sender\s*[:=]\s*["']?([^,\n\r"}]+)/i);
    const senderName = senderMatch?.[1];
    if (senderName && !senderName.includes("(") && !senderName.includes(":")) {
      info.sender_name = senderName.trim();
    }
  }

  return info;
}
