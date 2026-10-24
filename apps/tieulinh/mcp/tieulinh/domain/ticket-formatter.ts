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

import {
  cleanMediaTags,
  formatIctTimestamp,
  appendTicketUpdateDescription,
  escapeItsaplanMarkdown,
} from "../../../lib/formatting";
import { getLogger } from "../../../lib/logger";
import {
  IDENTIFIER_FIELD_KEYS,
  isGroundedInDigits,
  normalizeDigits,
  recoverAccountFromText,
} from "../../../lib/identifier-grounding";
export { cleanMediaTags, formatIctTimestamp, appendTicketUpdateDescription };

/**
 * Chốt chặn DUY NHẤT trước khi dựng mô tả/tóm tắt ticket: bỏ các trường định
 * danh model điền mà không thấy trong lời kể của chính người báo, thay vì ghi
 * bừa lên ticket. Áp dụng bất kể trường đến từ đường `create_issue` (model tự
 * gọi tool kèm customerId/studentId) hay `intake_step` (LLM extractor điền
 * studentAccount) — cả hai đều dựng ticket qua hai hàm trong file này.
 *
 * Đo được ở TECH-928 (26/09/2026): người báo cáo "90000003 - 0900000003
 * DH900003 UID: 900017", Tiểu Linh lại ghi "Tài khoản HS / SĐT: 0900000004"
 * lên ticket — con số đó không nằm ở đâu trong lời kể của cuộc hội thoại đó.
 * (Nguyên nhân sâu hơn — `intake_step` gộp nhầm sự cố khác vào cùng tờ khai —
 * đã vá riêng ở `lib/intake-step/pipeline.ts`; hàm này là lưới an toàn cuối
 * cùng, phòng khi model/LLM vẫn tự bịa dù không có xung đột nào để hỏi lại.)
 *
 * `studentAccount` bị bỏ thì thử moi lại SĐT thật từ chính lời kể trước khi
 * để trống — người báo thường CÓ cho số, chỉ là model ghi nhầm số khác.
 *
 * Đo được ở TECH-956 (28/09/2026): `describe()` ở `lib/intake-step/pipeline.ts`
 * dựng incident KHÔNG kèm `rawText`, nên hàm này từng đối chiếu tạm bằng
 * `incident.symptoms` — bản LLM paraphrase, không còn chữ số gốc — và xoá mất
 * `customerId = "9100001"` có thật. Chốt lại: CHỈ đối chiếu bằng `rawText`
 * (lời kể gốc của người báo), không bao giờ dùng `symptoms` để thay thế; nếu
 * không có `rawText` thì GIỮ NGUYÊN mọi giá trị (không đối chiếu được không có
 * nghĩa là bịa), chỉ ghi log để biết caller nào còn thiếu rawText.
 */
function groundIdentifierFields(incident: IncidentDetails): IncidentDetails {
  // Đối chiếu bằng `reporterText` (lời kể ĐẦY ĐỦ của cuộc hội thoại), KHÔNG phải
  // `rawText` — `rawText` chỉ là tin vừa gửi, dùng nó ở đây sẽ xoá SĐT/mã HS mà
  // người báo đã nói ở lượt trước (TECH-1084). Khi caller cũ chỉ truyền `rawText`
  // (đường `intake_step`, merger đã gộp hết lượt) thì vẫn dùng được như cũ.
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
 *
 * Tách khỏi mô tả theo TECH-1084 (02/10/2026): mô tả ticket là của NGƯỜI BÁO —
 * nguyên văn lời kể. Mọi suy luận của bot ("Cần đối chiếu…", "Triệu chứng khớp
 * với nhóm…") để lộ ra đó là lẫn lộn giữa lời người và ý người, khiến đội kỹ
 * thuật phải đoán đâu là nguyên văn, đâu là AI đoán.
 *
 * Trả về `null` khi không có gì đáng nói — nhiều câu trả lời KG chỉ là câu "không
 * tìm thấy", để trống thì không tạo comment rác.
 *
 * `_Tránh_`: viết lại mục này thành comment mới của người dùng (đây là comment
 * của bot), hoặc bỏ câu hỏi phân biệt vì "đã bỏ khỏi mô tả" — xem CONTEXT.md.
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
 * Build rich, structured Markdown description for Itsaplan issue,
 * following the standard VuiHoc TMS layout:
 * - Clean metadata block without redundant bolding/backticks
 * - Original reporter quote in blockquote
 * - Embedded attachments and source footer
 *
 * Mô tả KHÔNG chứa suy luận của bot — phần đó nằm ở `buildAdviceComment`.
 */
export function formatTicketDescription(options: FormatTicketDescriptionOptions): string {
  const {
    reporter,
    uploadedAttachments = [],
    similarIssues = [],
    sourceName = "ticket-intake",
  } = options;
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

  // Ticket tương tự được quản lý native qua Links của Itsaplan (client.addLink), không ghi lặp trong mô tả text
  // Phân loại lỗi -> đã lên labelIds (client.addLink) và Ưu tiên -> đã lên trường priority native,
  // cả hai đều hiện sẵn trên thanh properties của Itsaplan nên không ghi lặp ở đây.

  // Ngoại lệ: khi bot chỉnh ưu tiên khác với đề xuất của người báo, ghi lại sự chênh lệch này —
  // properties bar chỉ hiện mức cuối cùng, không hiện mức người báo từng đề xuất.
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
  //
  // Chỉ dùng `rawText`, KHÔNG trộn `reporterText` (bản gộp thêm tóm tắt của
  // model) — trộn vào thì lại lộ "Cần đối chiếu dữ liệu…" ra mô tả như lời
  // người, đúng lỗi TECH-1084. `reporterText` chỉ phục vụ đối chiếu nội bộ.
  //
  // Khối này vừa là thứ người đọc thấy, vừa là văn bản nguồn cho BM25 qua
  // `symptomsOfDescription` (kg-sync, duplicate-merger, related-curator), nên
  // `rawText` phải là TOÀN BỘ lượt tròi chuyện chứ không chỉ tin vừa gửi — mô
  // tả zod yêu cầu đúng như vậy. Ở đường `intake_step`, merger.ts đã gộp sẵn
  // mọi lượt nên vốn đã đầy đủ.
  //
  // KHÔNG gói thêm bản sao lời kẻ vào HTML comment ẩn: `cleanIncidentDescription`
  // xoá mọi comment, `applyEditOps` đếm số lần xuất hiện để quyết định sửa được
  // không, `appendTicketUpdateDescription` cắt theo `---` — bản sao thứ hai làm
  // hỏng cả ba.
  const cleanDescription = cleanMediaTags(incident.rawText || incident.symptoms || "");
  sections.push("### Mô tả", "");
  for (const line of cleanDescription.split("\n")) {
    sections.push(`> ${escapeItsaplanMarkdown(line)}`);
  }
  sections.push("");

  // 4. Gợi ý chuyên môn KHÔNG nằm trong mô tả (xem `buildAdviceComment`).

  // 5. Embedded screenshots
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

  // 6. Structured metadata comment (hidden in markdown, used for reliable updates)
  const metaObj: Record<string, any> = {
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
    if (!isMeaningful(typeof metaObj[k] === "string" ? metaObj[k] : String(metaObj[k] ?? ""))) {
      delete metaObj[k];
    }
  }
  const metaComment = `<!-- vuihoc-meta: ${JSON.stringify(metaObj)} -->`;

  // 7. ICT timestamp footer
  sections.push(
    "---",
    "",
    `*Nguồn: ${sourceName} (Telegram) · ${formatIctTimestamp()}*`,
    "",
    metaComment,
  );

  return sections.join("\n");
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

  // If there are soft fields that would be helpful to have
  if (missingSoftFields.length > 0) {
    lines.push("", `Anh/chị cho em xin thêm ${missingSoftFields.join(", ")} với ạ.`);
  }

  return lines.join("\n").trim();
}
