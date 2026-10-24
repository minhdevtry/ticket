import {
  decodeHtmlEntities,
  escapeItsaplanMarkdown,
  escapeTelegramHtml,
  escapeHtml,
} from "./html-entities";

export { decodeHtmlEntities, escapeItsaplanMarkdown, escapeTelegramHtml, escapeHtml };

/**
 * Shared string and date formatting utilities for intake bots.
 */

/**
 * Dấu vô hình gắn vào mọi bình luận do chính bot ghi lên tracker.
 *
 * Bot ghi comment (`update_issue`) → Itsaplan bắn `comment.created` → worker
 * thấy comment mới và đẩy ngược về Telegram → người dùng nhận lại đúng câu
 * mình vừa nhắn. Từ khi bật chế độ đẩy-tất-cả (17/09/2026) vòng này có thật,
 * nên comment của bot phải tự nhận diện được. Markdown không hiện thẻ chú thích
 * HTML, nên người đọc trên tracker không thấy gì.
 */
export const BOT_COMMENT_MARKER = "<!-- intake-bot -->";

/** Gắn dấu vào một bình luận bot sắp ghi lên tracker. */
export function markBotComment(body: string): string {
  return body.includes(BOT_COMMENT_MARKER) ? body : `${body}\n\n${BOT_COMMENT_MARKER}`;
}

/** Bình luận này do chính bot ghi ra? */
export function isBotComment(body?: string | null): boolean {
  return typeof body === "string" && body.includes(BOT_COMMENT_MARKER);
}

/**
 * Strips Telegram/chat media markers so they never leak into tracker descriptions or briefs.
 * Matches both `[media attached: ...]` and `<media:...>`.
 */
export function cleanMediaTags(str?: string | null): string {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/\[media attached:\s*[^\]]+\]/gi, "")
    .replace(/<media:\w+[^>]*>/gi, "")
    .trim();
}

/**
 * Gỡ các thẻ HTML nhúng trong bình luận Itsaplan (`<video>`, `<mark>`, `<span>`
 * tô màu/highlight của Tiptap) trước khi gửi cho người báo qua Telegram hoặc
 * đưa vào LLM / Knowledge Graph.
 *
 * - `<video ...>...</video>` và `<video ...>` bị bỏ hẳn (link video đã được bóc riêng).
 * - `<mark ...>chữ</mark>` và `<span ...>chữ</span>` chỉ bỏ thẻ, giữ nguyên chữ bên trong.
 */
export function stripCommentHtml(text?: string | null): string {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, "")
    .replace(/<\/?video\b[^>]*>/gi, "")
    .replace(/<\/?(?:mark|span)\b[^>]*>/gi, "");
}

/**
 * Trích xuất các đường dẫn file ảnh đính kèm từ tin nhắn chat (e.g. [media attached: ...])
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
 * Formats a Date in ICT (Indochina Time - UTC+7) as `YYYY-MM-DD HH:mm`.
 * Used for stamping ticket creation, updates, and post-mortems in local office time.
 */
export function formatIctTimestamp(date: Date = new Date()): string {
  const ict = new Date(date.getTime() + 7 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${ict.getUTCFullYear()}-${pad(ict.getUTCMonth() + 1)}-${pad(ict.getUTCDate())} ` +
    `${pad(ict.getUTCHours())}:${pad(ict.getUTCMinutes())}`
  );
}

export function appendTicketUpdateDescription(
  existingDescription: string,
  update: {
    additionalNotes: string;
    studentAccount?: string;
    device?: string;
    appVersion?: string;
    roomId?: string;
    timestamp?: string;
  },
): string {
  let desc = existingDescription || "";

  // 1. Clean any existing ': null' or ': undefined' lines
  desc = desc
    .split("\n")
    .filter((line) => !/:\s*(null|undefined)\s*$/i.test(line))
    .join("\n");

  // 2. Extract potential phone numbers if studentAccount is not given directly
  let studentAccount = update.studentAccount;
  if (!studentAccount && update.additionalNotes) {
    const phones = update.additionalNotes.match(/(0\d{9,10}|\b\d{9,11}\b)/g);
    if (phones && phones.length > 0) {
      studentAccount = Array.from(new Set(phones)).join(", ");
    }
  }

  // 3. Update or insert in metadata section
  if (studentAccount) {
    if (/- Tài khoản HS/i.test(desc)) {
      desc = desc.replace(/- Tài khoản HS.*:.*$/im, `- Tài khoản HS / SĐT: ${studentAccount}`);
    } else if (desc.includes("## Thông tin sự cố")) {
      desc = desc.replace(
        "## Thông tin sự cố\n",
        `## Thông tin sự cố\n\n- Tài khoản HS / SĐT: ${studentAccount}\n`,
      );
    }
  }

  if (update.device) {
    if (/- Thiết bị:/i.test(desc)) {
      desc = desc.replace(/- Thiết bị:.*$/im, `- Thiết bị: ${update.device}`);
    } else if (desc.includes("## Thông tin sự cố")) {
      desc = desc.replace(
        "## Thông tin sự cố\n",
        `## Thông tin sự cố\n\n- Thiết bị: ${update.device}\n`,
      );
    }
  }

  if (update.appVersion) {
    if (/- Phiên bản app:/i.test(desc)) {
      desc = desc.replace(/- Phiên bản app:.*$/im, `- Phiên bản app: ${update.appVersion}`);
    } else if (desc.includes("## Thông tin sự cố")) {
      desc = desc.replace(
        "## Thông tin sự cố\n",
        `## Thông tin sự cố\n\n- Phiên bản app: ${update.appVersion}\n`,
      );
    }
  }

  if (update.roomId) {
    if (/- Phòng học \/ Lớp:/i.test(desc)) {
      desc = desc.replace(/- Phòng học \/ Lớp:.*$/im, `- Phòng học / Lớp: ${update.roomId}`);
    } else if (desc.includes("## Thông tin sự cố")) {
      desc = desc.replace(
        "## Thông tin sự cố\n",
        `## Thông tin sự cố\n\n- Phòng học / Lớp: ${update.roomId}\n`,
      );
    }
  }

  // 3b. Làm sạch nếu có đính chính SĐT không phải mã khách hàng, hoặc nếu customerId trùng với studentAccount
  const isCustIdCorrection =
    /không phải mã khách hàng|ko phải mã kh|không phải mã kh|chưa có mã khách hàng|ko check đc mã kh|không check được mã kh/i.test(
      update.additionalNotes || "",
    ) || Boolean(studentAccount && desc.includes(`- Mã khách hàng: ${studentAccount}`));

  if (isCustIdCorrection) {
    desc = desc.replace(/[-*•]?\s*Mã khách hàng:.*(?:\r?\n|$)/gi, "");
  }

  // 4. Update embedded JSON metadata comment if present
  const metaMatch = desc.match(/<!-- vuihoc-meta: (.*?) -->/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      if (studentAccount) meta.studentAccount = studentAccount;
      if (isCustIdCorrection || (studentAccount && meta.customerId === studentAccount)) {
        delete meta.customerId;
      }
      if (update.device) meta.deviceType = update.device;
      if (update.appVersion) meta.appVersion = update.appVersion;
      if (update.roomId) meta.roomCode = update.roomId;
      desc = desc.replace(metaMatch[0], `<!-- vuihoc-meta: ${JSON.stringify(meta)} -->`);
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 5. Append log to a SINGLE '### ➕ Bổ sung' section, each line tagged with timestamp
  const timeStr = update.timestamp || formatIctTimestamp();
  const logLines: string[] = [];
  if (update.additionalNotes) {
    logLines.push(`- **${timeStr}:** ${escapeItsaplanMarkdown(update.additionalNotes)}`);
  }
  if (studentAccount) {
    logLines.push(
      `- **${timeStr} · Tài khoản HS / SĐT:** ${escapeItsaplanMarkdown(studentAccount)}`,
    );
  }
  if (update.device) {
    logLines.push(`- **${timeStr} · Thiết bị:** ${escapeItsaplanMarkdown(update.device)}`);
  }
  if (update.appVersion) {
    logLines.push(`- **${timeStr} · Phiên bản app:** ${escapeItsaplanMarkdown(update.appVersion)}`);
  }
  if (update.roomId) {
    logLines.push(`- **${timeStr} · Phòng học / Lớp:** ${escapeItsaplanMarkdown(update.roomId)}`);
  }

  if (logLines.length === 0) return desc.trim();

  const logContent = logLines.join("\n");
  const supplementaryHeaderMatch = desc.match(
    /###\s*(?:➕\s*)?Bổ sung|###\s*📝\s*Thông tin bổ sung/i,
  );

  if (supplementaryHeaderMatch) {
    // Already has a "Bổ sung" section: append log lines before footer ---
    if (desc.includes("---")) {
      const parts = desc.split("---");
      const footer = parts.pop();
      desc = parts.join("---").trim() + "\n" + logContent + "\n\n---\n" + (footer || "").trim();
    } else {
      desc = desc.trim() + "\n" + logContent;
    }
  } else {
    // First time adding "Bổ sung" section
    const newSection = `### ➕ Bổ sung\n\n${logContent}\n\n`;
    if (desc.includes("---")) {
      const parts = desc.split("---");
      const footer = parts.pop();
      desc = parts.join("---").trim() + "\n\n" + newSection + "---\n" + (footer || "").trim();
    } else {
      desc = desc.trim() + "\n\n" + newSection;
    }
  }

  return desc.trim();
}

/**
 * Danh sách tên handle của bot trên các hệ thống để lọc bỏ khỏi câu trao đổi.
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
];

/**
 * Gỡ bỏ toàn bộ mention tới bot (ví dụ: @iris, @bot-iris-intake, @tieulinh) khỏi bình luận
 * trước khi gửi về Telegram, giúp nội dung tự nhiên và không thừa thãi handle.
 */
export function stripBotMentions(text?: string | null, extraHandles: string[] = []): string {
  if (!text || typeof text !== "string") return "";
  const allHandles = Array.from(new Set([...KNOWN_BOT_HANDLES, ...extraHandles])).filter(Boolean);
  const sorted = allHandles.sort((a, b) => b.length - a.length);
  const escaped = sorted.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<=^|\\s)@(${escaped})(?![a-zA-Z0-9_-])\\s*(?:[:,-]\\s*)?`, "gi");
  return text.replace(pattern, "").trim();
}

/**
 * Bộ nhớ đệm ngắn hạn chống gửi lặp bình luận giữa Webhook và AgentRunner
 * khi cả hai cùng nhận được một comment có tag agent.
 */
const recentCommentForwards = new Map<string, number>();

export function isCommentRecentlyForwarded(issueId: number, text: string, ttlMs = 60_000): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const key = `${issueId}:${normalized}`;
  const now = Date.now();
  const lastTime = recentCommentForwards.get(key);
  if (lastTime && now - lastTime < ttlMs) {
    return true;
  }
  recentCommentForwards.set(key, now);
  if (recentCommentForwards.size > 500) {
    for (const [k, t] of recentCommentForwards.entries()) {
      if (now - t > 120_000) recentCommentForwards.delete(k);
    }
  }
  return false;
}
