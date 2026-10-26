import type {
  IncidentDetails,
  ReporterInfo,
  SimilarIssue,
  UploadedAttachmentResult,
} from "./types";

export interface FormatTicketDescriptionOptions {
  incident: IncidentDetails;
  reporter?: ReporterInfo | null;
  uploadedAttachments?: UploadedAttachmentResult[];
  similarIssues?: SimilarIssue[];
  sourceName?: string;
}

export interface FormatConfirmationOptions {
  issueIdentifier: string;
  issueUrl: string;
  incident: IncidentDetails;
  runbookAdvice?: string | null;
  uploadedAttachments?: UploadedAttachmentResult[];
  similarIssues?: SimilarIssue[];
  missingSoftFields?: string[];
}

import {
  cleanMediaTags,
  escapeItsaplanMarkdown,
  formatIctTimestamp,
  getLogger,
} from "@vuihoc/bot-core/core";
import {
  isGroundedInDigits,
  normalizeDigits,
  recoverAccountFromText,
} from "@vuihoc/bot-core/intake";

export { cleanMediaTags, formatIctTimestamp };

/**
 * Bọc trích dẫn cho khối xem trước lời người báo.
 */
export function quoteForPreview(text: string, maxChars = 600): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
  return clipped
    .replace(/([\\`*_{}[\]()#+|>-])/g, "\\$1")
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

export const IDENTIFIER_FIELD_KEYS = ["studentAccount", "customerId"] as const;

/**
 * Chốt chặn DUY NHẤT trước khi dựng mô tả/tóm tắt ticket: bỏ các trường định
 * danh model điền mà không thấy trong lời kể của chính người báo, thay vì ghi
 * bừa lên ticket.
 */
export function groundIdentifierFields(incident: IncidentDetails): IncidentDetails {
  const reporterText = incident.reporterText || incident.rawText || "";
  if (!reporterText) {
    getLogger().warn(
      "[ticket-formatter] Không có lời kể của người báo để đối chiếu — giữ nguyên các trường định danh, không lọc theo symptoms (xem TECH-956).",
    );
    return incident;
  }
  const reporterDigits = normalizeDigits(reporterText);
  let grounded: IncidentDetails | undefined;
  for (const key of IDENTIFIER_FIELD_KEYS) {
    const raw = incident[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (isGroundedInDigits(raw, reporterDigits)) continue;
    grounded = grounded ?? { ...incident };
    const recovered = key === "studentAccount" ? recoverAccountFromText(reporterText) : undefined;
    getLogger().warn(
      recovered
        ? `[ticket-formatter] Trường "${key}"="${raw}" không thấy trong lời kể của người báo (nghi model tự bịa, xem TECH-928) — thay bằng giá trị moi từ lời kể: "${recovered}".`
        : `[ticket-formatter] Bỏ trường "${key}"="${raw}" — không thấy trong lời kể của người báo (nghi model tự bịa, xem TECH-928).`,
    );
    if (recovered) {
      (grounded as unknown as Record<string, string | undefined>)[key] = recovered;
    } else {
      delete grounded[key];
    }
  }
  return grounded ?? incident;
}

/**
 * Split diagnosis / runbook text into clean bullet points, stripping redundant H2/H3 headers
 */
export function splitDiagnosis(rawText: string): string[] {
  if (!rawText) return [];

  const lines = rawText.split("\n");
  const bullets: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip redundant markdown headings from RAG responses
    if (/^#+\s+/.test(trimmed)) continue;

    let point = "";
    // If it's a bullet point or numbered item (e.g. -, *, •, 1., 2))
    const match = trimmed.match(/^(?:[-*•]|\d+[.)])\s*(.*)$/);
    if (match) {
      const content = match[1].trim();
      if (content && content.length > 5) {
        point = content;
      }
    } else if (trimmed.length >= 25 && !trimmed.startsWith(">")) {
      // Normal sentence with substantial content
      point = trimmed;
    }

    if (point) {
      const norm = point.toLowerCase().replace(/\s+/g, " ");
      if (!seen.has(norm)) {
        seen.add(norm);
        bullets.push(point);
      }
    }
  }

  return bullets.length > 0 ? bullets.slice(0, 6) : [cleanMediaTags(rawText).slice(0, 300)];
}

/**
 * Dựng nội dung COMMENT riêng của bot: gợi ý nguyên nhân đã biết từ KG/Onyx và
 * câu hỏi phân biệt khi sự cố mơ hồ.
 */
export function buildAdviceComment(
  diagnosis?: string | null,
  runbookAdvice?: string | null,
): string | null {
  const combined = [diagnosis, runbookAdvice].filter(Boolean).join("\n");
  if (!combined.trim()) return null;
  const points = splitDiagnosis(combined).filter(
    (p) =>
      !p.toLowerCase().includes("chưa xác định được đây là lỗi đã biết") &&
      !p.toLowerCase().includes("không trả về tài liệu"),
  );
  if (points.length === 0) return null;
  return [
    "**Gợi ý chuyên môn & nguyên nhân đã biết**",
    "",
    ...points.map((p) => `- ${escapeItsaplanMarkdown(p)}`),
  ].join("\n");
}

/**
 * Trích xuất đoạn văn bản thuộc mục "### Mô tả" trong description của ticket.
 */
export function symptomsOfDescription(description: string | null | undefined): string {
  const m = String(description ?? "").match(/###\s*Mô tả\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/);
  if (!m) return "";
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^>\s*/, "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Build rich, structured Markdown description for Itsaplan issue,
 * following the standard VuiHoc TMS layout.
 */
export function formatTicketDescription(options: FormatTicketDescriptionOptions): string {
  const { reporter, uploadedAttachments = [], sourceName = "ticket-intake" } = options;
  const incident = groundIdentifierFields(options.incident);

  const metadataLines: string[] = [];

  // 1. Reporter info: prioritize username (@name_code) and telegramId
  if (reporter) {
    const cleanName = (reporter.name ?? "").trim();
    const cleanU = (reporter.username ?? "").trim().replace(/^@+/, "");
    const tgId = reporter.telegramId ? String(reporter.telegramId).trim() : "";
    const parts: string[] = [];

    if (cleanName && cleanU) {
      if (
        cleanName.toLowerCase() === cleanU.toLowerCase() ||
        cleanName.toLowerCase().includes(cleanU.toLowerCase())
      ) {
        parts.push(cleanName);
      } else {
        parts.push(`${cleanName} (@${cleanU})`);
      }
    } else if (cleanU) {
      parts.push(`@${cleanU}`);
    } else if (cleanName) {
      parts.push(cleanName);
    }

    if (tgId && !parts.some((p) => p.includes(tgId))) {
      parts.push(`- ${tgId}`);
    }

    if (parts.length > 0) {
      metadataLines.push(`- Người báo: ${parts.join(" ")}`);
    }
  }

  // 2. Incident metadata (standard taxonomy) - NEVER output "null" or "undefined"
  const isMeaningful = (val?: string | null) =>
    val &&
    val.trim() !== "" &&
    val.trim().toLowerCase() !== "null" &&
    val.trim().toLowerCase() !== "undefined";

  if (isMeaningful(incident.product))
    metadataLines.push(`- Sản phẩm: ${escapeItsaplanMarkdown(incident.product)}`);
  if (isMeaningful(incident.system))
    metadataLines.push(`- Hệ thống: ${escapeItsaplanMarkdown(incident.system)}`);
  if (isMeaningful(incident.customerId) && incident.customerId !== incident.studentAccount) {
    metadataLines.push(`- Mã khách hàng: ${escapeItsaplanMarkdown(incident.customerId)}`);
  }
  if (isMeaningful(incident.studentAccount)) {
    metadataLines.push(`- Tài khoản HS / SĐT: ${escapeItsaplanMarkdown(incident.studentAccount)}`);
  }
  if (isMeaningful(incident.reportingDept))
    metadataLines.push(`- Bộ phận: ${escapeItsaplanMarkdown(incident.reportingDept)}`);
  if (isMeaningful(incident.priorityReason))
    metadataLines.push(
      `- Lý do ưu tiên (người báo): ${escapeItsaplanMarkdown(incident.priorityReason)}`,
    );

  if (
    incident.suggestedPriority &&
    incident.priority &&
    incident.suggestedPriority.toLowerCase() !== incident.priority.toLowerCase()
  ) {
    metadataLines.push(
      `- Ưu tiên: ${incident.priority.toUpperCase()} (người báo đề xuất: ${incident.suggestedPriority.toUpperCase()})`,
    );
  }

  // Soft/additional fields
  if (isMeaningful(incident.roomCode))
    metadataLines.push(`- Phòng học / Lớp: ${escapeItsaplanMarkdown(incident.roomCode)}`);
  if (isMeaningful(incident.deviceType))
    metadataLines.push(`- Thiết bị: ${escapeItsaplanMarkdown(incident.deviceType)}`);
  if (isMeaningful(incident.deviceOs))
    metadataLines.push(`- Hệ điều hành: ${escapeItsaplanMarkdown(incident.deviceOs)}`);
  if (isMeaningful(incident.appVersion))
    metadataLines.push(`- Phiên bản app: ${escapeItsaplanMarkdown(incident.appVersion)}`);
  if (isMeaningful(incident.browser))
    metadataLines.push(`- Trình duyệt: ${escapeItsaplanMarkdown(incident.browser)}`);
  if (isMeaningful(incident.transactionId))
    metadataLines.push(`- Mã giao dịch: ${escapeItsaplanMarkdown(incident.transactionId)}`);
  if (isMeaningful(incident.assignmentId))
    metadataLines.push(`- Mã bài tập: ${escapeItsaplanMarkdown(incident.assignmentId)}`);

  const sections: string[] = [];

  if (metadataLines.length > 0) {
    sections.push("## Thông tin sự cố", "", ...metadataLines, "");
  }

  // 3. Lời kể NGUYÊN VĂN của người báo, trích dẫn.
  const cleanDescription = cleanMediaTags(incident.rawText || incident.symptoms || "");
  sections.push("### Mô tả", "");
  for (const line of cleanDescription.split("\n")) {
    sections.push(`> ${escapeItsaplanMarkdown(line)}`);
  }
  sections.push("");

  // 4. Embedded screenshots
  if (uploadedAttachments.length > 0) {
    sections.push("### 📸 Ảnh đính kèm", "");
    if (incident.mediaAmbiguous) {
      sections.push("*(Ảnh đính kèm chung cho các sự cố trong cùng lượt báo)*", "");
    }
    for (const att of uploadedAttachments) {
      sections.push(`![${att.filename}](${att.url})`);
    }
    sections.push("");
  } else if (incident.mediaAmbiguous) {
    sections.push(
      "### 📸 Ảnh đính kèm",
      "",
      "*(Ảnh đính kèm chung cho các sự cố trong cùng lượt báo)*",
      "",
    );
  }

  // 5. Structured metadata comment (hidden in markdown, used for reliable updates)
  const metaObj: Record<string, unknown> = {
    reporter: reporter ? reporter.name : undefined,
    product: incident.product,
    system: incident.system,
    roomCode: incident.roomCode,
    customerId: incident.customerId,
    studentAccount: incident.studentAccount,
    deviceOs: incident.deviceOs,
    deviceType: incident.deviceType,
    appVersion: incident.appVersion,
    browser: incident.browser,
    transactionId: incident.transactionId,
    assignmentId: incident.assignmentId,
    reportingDept: incident.reportingDept,
    category: incident.category,
    priority: incident.priority,
  };
  for (const k of Object.keys(metaObj)) {
    if (
      !isMeaningful(
        typeof metaObj[k] === "string" ? (metaObj[k] as string) : String(metaObj[k] ?? ""),
      )
    ) {
      delete metaObj[k];
    }
  }
  const metaComment = `<!-- vuihoc-meta: ${JSON.stringify(metaObj)} -->`;

  // 6. ICT timestamp footer
  sections.push(
    "---",
    "",
    `*Nguồn: ${sourceName} (Telegram) · ${formatIctTimestamp()}*`,
    "",
    metaComment,
  );

  return sections.join("\n");
}

/**
 * Format concise, high-clarity response to Telegram user (following VuiHoc TMS Model B)
 */
export function formatConfirmationMessage(options: FormatConfirmationOptions): string {
  const { issueIdentifier, missingSoftFields = [] } = options;
  const incident = groundIdentifierFields(options.incident);

  const prio = incident.priority
    ? incident.priority.charAt(0).toUpperCase() + incident.priority.slice(1).toLowerCase()
    : "Medium";

  const lines: string[] = [`Đã tạo ticket ${issueIdentifier}`, "", `- Tiêu đề: ${incident.title}`];

  if (incident.product) lines.push(`- Sản phẩm: ${incident.product}`);
  if (incident.system) lines.push(`- Hệ thống: ${incident.system}`);
  if (incident.customerId && incident.customerId !== incident.studentAccount) {
    lines.push(`- Mã khách hàng: ${incident.customerId}`);
  }
  if (incident.studentAccount) lines.push(`- Tài khoản HS / SĐT: ${incident.studentAccount}`);
  if (incident.reportingDept) lines.push(`- Bộ phận: ${incident.reportingDept}`);
  const errCategory = incident.errorCategory || incident.category;
  if (errCategory) lines.push(`- Phân loại lỗi: ${errCategory}`);
  lines.push(`- Ưu tiên: ${prio}`);

  if (missingSoftFields.length > 0) {
    lines.push("", `Anh/chị cho em xin thêm ${missingSoftFields.join(", ")} với ạ.`);
  }

  return lines.join("\n").trim();
}

/**
 * Cập nhật bổ sung vào mô tả ticket hiện có của Tiểu Linh.
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
    if (desc.includes("---")) {
      const parts = desc.split("---");
      const footer = parts.pop();
      desc = `${parts.join("---").trim()}\n${logContent}\n\n---\n${(footer || "").trim()}`;
    } else {
      desc = `${desc.trim()}\n${logContent}`;
    }
  } else {
    const newSection = `### ➕ Bổ sung\n\n${logContent}\n\n`;
    if (desc.includes("---")) {
      const parts = desc.split("---");
      const footer = parts.pop();
      desc = `${parts.join("---").trim()}\n\n${newSection}---\n${(footer || "").trim()}`;
    } else {
      desc = `${desc.trim()}\n\n${newSection}`;
    }
  }

  return desc.trim();
}
