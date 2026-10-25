import {
  KNOWN_BOT_HANDLES,
  formatIctTimestamp,
  stripBotMentions as stripBotMentionsWith,
} from "@vuihoc/bot-core/core";
import { escapeItsaplanMarkdown } from "./html-entities";

/**
 * Phần định dạng RIÊNG của Tiểu Linh — gắn layout ticket ("### Mô tả / Thông tin
 * sự cố", mục "### ➕ Bổ sung") và trạng thái toàn cục của worker, nên không nằm
 * trong `@vuihoc/bot-core/core`. Phần chung (marker bot, stripCommentHtml, ...)
 * import thẳng từ thư viện.
 */

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

/**
 * Handle bot của Tiểu Linh = `KNOWN_BOT_HANDLES` của thư viện trừ `cmsupport` (handle
 * của bot CM, Tiểu Linh chưa từng lọc).
 */
export const TIEULINH_BOT_HANDLES = KNOWN_BOT_HANDLES.filter((h) => h !== "cmsupport");

/**
 * `stripBotMentions` đúng như bản cũ: chỉ lọc theo danh sách handle, KHÔNG xoá mọi
 * `@<tên>_bot` (luật mới của thư viện có thể nuốt mention người thật cuối dòng
 * dạng `@xxx_bot`).
 */
export function stripBotMentions(text?: string | null, extraHandles: string[] = []): string {
  return stripBotMentionsWith(text, extraHandles, {
    knownHandles: TIEULINH_BOT_HANDLES,
    stripBotSuffixHandles: false,
  });
}
