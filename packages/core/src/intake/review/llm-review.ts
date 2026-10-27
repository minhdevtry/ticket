/**
 * Soát tờ khai bằng con mắt kỹ thuật viên TRƯỚC khi xin xác nhận: lời báo đã đủ
 * dữ kiện để bắt tay kiểm tra chưa? Thiếu thì hỏi người báo MỘT lượt.
 *
 * Không hỏi nguyên nhân (người báo: "biết lý do thì bọn em đã không báo tech").
 * Lỗi LLM / hết giờ → coi như đủ, không chặn tạo ticket.
 */
import { parseJsonLoose } from "../../llm/extract";
import { defaultComplete, type CompleteFn, type LlmConfig } from "../extractor/llm-extractor";
import type { TechReviewInput, TechReviewOutput, TechReviewerPort } from "../ports";

const SYSTEM_PROMPT = (
  guide: string,
  project: string,
) => `Bạn là kỹ thuật viên ${project} sẽ nhận ticket này. Trước khi ticket được tạo, bạn soát xem lời báo đã đủ DỮ KIỆN để bắt tay kiểm tra ngay chưa, theo hướng dẫn dưới đây (chắt từ những lần kỹ thuật phải hỏi lại người báo).

${guide}

Quy tắc trả lời:
- Chỉ hỏi dữ kiện người báo CÓ THỂ cung cấp (mã, ảnh, thao tác, cái đang hiện so với cái đúng phải là…). KHÔNG hỏi nguyên nhân lỗi.
- Tối đa 3 dữ kiện quan trọng nhất. Thứ đã có trong lời báo, trong trường đã có hoặc trong ảnh đính kèm thì KHÔNG hỏi lại.
- Không hỏi bộ phận, hệ thống, sản phẩm, mức ưu tiên (đã hỏi ở bước khác).
- Đủ để kỹ thuật bắt tay kiểm tra thì "missing" rỗng. Đừng hỏi cho có.
- "question": MỘT tin nhắn lịch sự gửi người báo (xưng em, gọi anh/chị), nêu rõ từng dữ kiện cần, có ví dụ ngắn nếu giúp dễ hiểu; kết bằng: không có thì nhắn "không có", em tạo ticket luôn.
Trả về ĐÚNG một object JSON: {"missing": ["…"], "question": "…"}`;

function userPrompt(input: TechReviewInput): string {
  const known = Object.entries(input.known ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return [
    input.title ? `Tiêu đề: ${input.title}` : "",
    input.product ? `Sản phẩm: ${input.product}` : "",
    input.system ? `Hệ thống: ${input.system}` : "",
    known ? `Trường đã có:\n${known}` : "",
    `Ảnh/tệp đính kèm: ${input.attachments}`,
    `Lời báo (nguyên văn):\n${input.description.slice(0, 4000)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class LlmTechReviewer implements TechReviewerPort {
  constructor(
    private readonly llm: LlmConfig,
    private readonly guide: string,
    private readonly completeFn: CompleteFn = defaultComplete,
    private readonly timeoutMs = 15_000,
    /** Mã dự án (ví dụ "TECH") — tên của app, không hardcode trong core. */
    private readonly project: string = "",
  ) {}

  async review(input: TechReviewInput): Promise<TechReviewOutput> {
    const call = this.completeFn(
      this.llm,
      SYSTEM_PROMPT(this.guide, this.project),
      userPrompt(input),
    );
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error("tech-review timeout")), this.timeoutMs);
    const raw = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
    const parsed = parseJsonLoose(raw) as { missing?: unknown; question?: unknown } | undefined;
    const rawMissing = parsed?.missing;
    const missing = Array.isArray(rawMissing)
      ? rawMissing.filter((m): m is string => typeof m === "string" && m.trim() !== "").slice(0, 3)
      : [];
    const question =
      typeof parsed?.question === "string" && parsed.question.trim()
        ? parsed.question.trim()
        : undefined;
    return missing.length > 0 && question ? { missing, question } : { missing: [] };
  }
}
