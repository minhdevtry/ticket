/**
 * Phân loại MỘT bình luận của kỹ thuật viên: có đang đòi NGƯỜI BÁO bổ sung hay làm rõ
 * thông tin không, và đòi mục nào (theo bộ mục chuẩn trong items.ts).
 */
import { parseJsonLoose } from "../../llm/extract";
import { defaultComplete, type CompleteFn, type LlmConfig } from "../extractor/llm-extractor";
import { isCanonItem, type CanonItem } from "./items";

export const KINDS = [
  "ask",
  "supplement_request",
  "clarify",
  "correction",
  "lesson_next_time",
  "inform",
  "routing",
  "remote_access",
  "verify_after_fix",
  "other",
] as const;
export type Kind = (typeof KINDS)[number];

/** Các loại mà bình luận được tính là "đòi người báo bổ sung". */
export const NEEDS_KINDS: ReadonlySet<string> = new Set([
  "ask",
  "supplement_request",
  "clarify",
  "correction",
  "lesson_next_time",
]);

export interface ClassifyComment {
  actor: string;
  createdAt: string;
  text: string;
}

export interface ClassifyInput {
  /** Tiêu đề + mô tả đã bỏ phần bot sinh (dùng buildReport). */
  report: string;
  /** Tối đa 2 bình luận trước đó, cũ trước. */
  prev: ClassifyComment[];
  comment: ClassifyComment;
}

export interface ClassifyResult {
  needsInfo: boolean;
  kind: Kind;
  items: CanonItem[];
  alreadyInReport: boolean;
  evidence: string;
  model: string;
}

/** Báo cáo ban đầu để đưa vào prompt: bỏ khối bot sinh "Chẩn đoán" và "Bổ sung" trở đi. */
export function buildReport(title: string | undefined, description: string | undefined): string {
  const desc = (description ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n?###\s*➕\s*Bổ sung[\s\S]*$/, "")
    .replace(/(?:^|\n)###\s*(?:Chẩn đoán|Gợi ý)[^\n]*\n?([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/g, "")
    .trim();
  return `Tiêu đề: ${title ?? ""}\nMô tả:\n${desc}`.slice(0, 1500);
}

const CANON_DEF = `- SCREENSHOT: ảnh/video màn hình lỗi (xin ảnh chụp, quay màn hình, video lỗi)
- ERROR_TEXT: nội dung thông báo lỗi chính xác (xin copy/chụp lỗi hiện nguyên văn)
- STEPS: thao tác/bước, ở màn hình nào (làm gì thì ra lỗi, bấm gì, vào mục nào)
- EXPECTED_VS_ACTUAL: đang hiện gì / đúng phải là gì, hạn đúng, giá trị mong muốn
- TIME: thời điểm xảy ra lỗi (ngày giờ, mới hay lâu rồi)
- DEVICE_APP: thiết bị, hệ điều hành, phiên bản app, trình duyệt, mạng
- STUDENT_ID: định danh chung: UID/CID/SID, SĐT, tài khoản, tên học sinh/phụ huynh
- CARE_STUDENT_LINK: link trang chi tiết học sinh trên se-care
- CRM_CONTACT_LINK: link contact trên se-crm
- LMS_UID_LINK: link se-lms hoặc UID trên LMS
- ORDER_CODE: mã đơn hàng DHxxxx, mã phiếu thu / receipt
- COURSE_CLASS_SCOPE: khoá / lớp / buổi / môn / bài / đề cụ thể bị ảnh hưởng
- OTHER_LINK: link trang, bài, đề khác (không phải se-care/se-crm/se-lms)
- EXTENT: một người hay nhiều người / tất cả bị lỗi
- OTHER: không khớp mục nào ở trên`;

export const SYSTEM_PROMPT = `Bạn đọc MỘT bình luận của kỹ thuật viên trên ticket lỗi của Vuihoc, cùng báo cáo ban đầu của người báo và tối đa hai bình luận trước đó.
Nhiệm vụ: xác định bình luận này có yêu cầu NGƯỜI BÁO bổ sung hoặc làm rõ thông tin mà chính người báo có thể đưa ra không.

Phân loại "kind" (chọn đúng một):
- ask: hỏi người báo một điều cụ thể (có câu hỏi hoặc yêu cầu trả lời)
- supplement_request: yêu cầu gửi thêm thông tin còn thiếu (ảnh, video, link, mã, ID, thời điểm, thông báo lỗi nguyên văn, các thao tác)
- clarify: yêu cầu làm rõ thông tin người báo đã đưa (cái nào, ở đâu, lấy từ đâu, nghĩa là gì)
- correction: yêu cầu người báo sửa hoặc gửi lại thông tin đã báo sai hoặc nhầm (mã, ID, học sinh, link)
- lesson_next_time: dặn người báo lần sau khi báo lỗi dạng này phải kèm thông tin gì
- inform: thông báo kết quả, trạng thái, hướng xử lý, cảm ơn; không yêu cầu gì từ người báo
- routing: chuyển sang bộ phận khác, hoặc nói vấn đề thuộc phòng ban khác
- remote_access: xin TeamViewer/UltraViewer, quyền điều khiển từ xa, mật khẩu hay tài khoản đăng nhập
- verify_after_fix: nhờ người báo kiểm tra lại, thử lại hoặc xác nhận sau khi đã sửa; đề nghị đóng ticket
- other: giải thích nguyên nhân, cách sửa, hoặc nội dung khác

needs_info = true chỉ khi kind thuộc: ask, supplement_request, clarify, correction, lesson_next_time, VÀ thông tin được đòi là dữ liệu người báo có thể đưa ngay khi báo lỗi.
Không tính: thông báo kết quả hay đóng ticket, giải thích nguyên nhân, chuyển phòng ban, xin điều khiển từ xa hay mật khẩu, và yêu cầu thử lại sau khi sửa.

items: các mục thông tin mà yêu cầu này đòi người báo cung cấp (0 đến 3 mục). Nếu needs_info = false thì để [].
Danh sách mục chuẩn:
${CANON_DEF}

already_in_report: true nếu thông tin được hỏi đã có sẵn trong báo cáo ban đầu, false nếu chưa có.
evidence: chép NGUYÊN VĂN, đúng từng ký tự, một đoạn ngắn (tối đa 120 ký tự) từ bình luận được phân loại làm căn cứ.

Trả về ĐÚNG một object JSON, không kèm chữ nào khác:
{"needs_info": true|false, "kind": "<một trong các kind>", "items": ["MÃ"], "already_in_report": true|false, "evidence": "..."}`;

export function userPrompt(input: ClassifyInput): string {
  const lines = [
    "Báo cáo ban đầu của người báo:",
    input.report,
    "",
    "Bình luận trước đó (cũ trước):",
  ];
  if (input.prev.length === 0) lines.push("(không có)");
  for (const p of input.prev.slice(-2)) {
    lines.push(`- ${p.actor} (${p.createdAt.slice(0, 16)}): ${p.text.slice(0, 500)}`);
  }
  lines.push(
    "",
    `BÌNH LUẬN CẦN PHÂN LOẠI (của ${input.comment.actor}, ${input.comment.createdAt.slice(0, 16)}):`,
    "<<<",
    input.comment.text.slice(0, 1500),
    ">>>",
  );
  return lines.join("\n");
}

/** Chuẩn hoá đầu ra của model: kind lạ → other; mục lạ bỏ đi; chỉ NEEDS_KINDS mới có mục. */
export function sanitize(parsed: Record<string, unknown>, model: string): ClassifyResult {
  const rawKind = typeof parsed.kind === "string" ? parsed.kind.trim().toLowerCase() : "";
  const kind: Kind = (KINDS as readonly string[]).includes(rawKind) ? (rawKind as Kind) : "other";
  const needsInfo = NEEDS_KINDS.has(kind);
  const items: CanonItem[] = [];
  if (Array.isArray(parsed.items)) {
    for (const it of parsed.items) {
      const code = typeof it === "string" ? it.trim().toUpperCase() : "";
      if (isCanonItem(code) && code !== "OTHER" && !items.includes(code)) items.push(code);
    }
  }
  const alreadyInReport =
    parsed.already_in_report === true ||
    String(parsed.already_in_report).trim().toLowerCase() === "true";
  const evidence = typeof parsed.evidence === "string" ? parsed.evidence.slice(0, 300) : "";
  return {
    needsInfo,
    kind,
    items: needsInfo ? items.slice(0, 3) : [],
    alreadyInReport,
    evidence,
    model,
  };
}

export async function classifyComment(
  cfg: LlmConfig,
  input: ClassifyInput,
  completeFn: CompleteFn = defaultComplete,
  timeoutMs = 30_000,
): Promise<ClassifyResult> {
  const call = completeFn(cfg, SYSTEM_PROMPT, userPrompt(input));
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error("ask-learning timeout")), timeoutMs);
  const raw = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  const parsed = parseJsonLoose(raw) as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `ask-learning: model không trả JSON (${raw.slice(0, 80).replace(/\s+/g, " ")})`,
    );
  }
  return sanitize(parsed, cfg.model ?? "unknown");
}
