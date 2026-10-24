/**
 * Soát tờ khai bằng con mắt kỹ thuật viên TRƯỚC khi xin xác nhận: lời báo đã đủ
 * dữ kiện để bắt tay kiểm tra chưa? Thiếu thì hỏi người báo MỘT lượt.
 *
 * 28/09 (tech lead chuyển phản hồi): TECH-759 kỹ thuật phải hỏi lại "Theo đơn hàng
 * nào, ngữ cảnh như thế nào? Làm sao để biết là bị sai?"; TECH-722 thiếu hạn đúng
 * mong muốn; TECH-907/913 thiếu link se-care; TECH-670/676 thiếu tên khoá cần mở.
 * Bảng trường cố định (required_fields.json) chỉ hỏi bộ phận/hệ thống/thiết bị nên
 * không bắt được những thứ này. Dữ kiện cần theo từng loại sự cố được chắt từ lịch
 * sử hỏi lại thật (mcp/tieulinh/domain/tech-info-needs.md), LLM đối chiếu với lời báo.
 *
 * Không hỏi nguyên nhân (người báo: "biết lý do thì bọn em đã không báo tech").
 * Lỗi LLM / hết giờ → coi như đủ, không chặn tạo ticket.
 */
import { complete as defaultComplete, extractJson, type LlmConfig } from "../../worker/llm";

export interface TechReviewInput {
  title?: string;
  description: string;
  system?: string;
  product?: string;
  attachments: number;
  /** Trường cấu trúc đã có (SĐT, mã KH, mã đơn…) — để khỏi hỏi lại. */
  known: Record<string, string>;
}

export interface TechReviewResult {
  /** Dữ kiện còn thiếu, ngắn (vd "mã đơn hàng"). Rỗng = đủ. */
  missing: string[];
  /** Câu hỏi gửi người báo (một tin). */
  question?: string;
}

export interface TechReviewer {
  review(input: TechReviewInput): Promise<TechReviewResult>;
}

type CompleteFn = (config: LlmConfig, system: string, user: string) => Promise<string>;

const SYSTEM_PROMPT = (
  guide: string,
) => `Bạn là kỹ thuật viên TECH sẽ nhận ticket này. Trước khi ticket được tạo, bạn soát xem lời báo đã đủ DỮ KIỆN để bắt tay kiểm tra ngay chưa, theo hướng dẫn dưới đây (chắt từ những lần kỹ thuật phải hỏi lại người báo).

${guide}

Quy tắc trả lời:
- Chỉ hỏi dữ kiện người báo CÓ THỂ cung cấp (mã, ảnh, thao tác, cái đang hiện so với cái đúng phải là…). KHÔNG hỏi nguyên nhân lỗi.
- Tối đa 3 dữ kiện quan trọng nhất. Thứ đã có trong lời báo, trong trường đã có hoặc trong ảnh đính kèm thì KHÔNG hỏi lại.
- Không hỏi bộ phận, hệ thống, sản phẩm, mức ưu tiên (đã hỏi ở bước khác).
- Đủ để kỹ thuật bắt tay kiểm tra thì "missing" rỗng. Đừng hỏi cho có.
- "question": MỘT tin nhắn lịch sự gửi người báo (xưng em, gọi anh/chị), nêu rõ từng dữ kiện cần, có ví dụ ngắn nếu giúp dễ hiểu; kết bằng: không có thì nhắn "không có", em tạo ticket luôn.
Trả về ĐÚNG một object JSON: {"missing": ["…"], "question": "…"}`;

function userPrompt(input: TechReviewInput): string {
  const known = Object.entries(input.known)
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

export class LlmTechReviewer implements TechReviewer {
  constructor(
    private readonly llm: LlmConfig,
    private readonly guide: string,
    private readonly completeFn: CompleteFn = defaultComplete,
    private readonly timeoutMs = 15_000,
  ) {}

  async review(input: TechReviewInput): Promise<TechReviewResult> {
    const call = this.completeFn(this.llm, SYSTEM_PROMPT(this.guide), userPrompt(input));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("tech-review timeout")), this.timeoutMs);
    });
    const raw = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
    const parsed = extractJson<{ missing?: unknown; question?: unknown }>(raw);
    const missing = Array.isArray(parsed?.missing)
      ? parsed!.missing
          .filter((m): m is string => typeof m === "string" && m.trim() !== "")
          .slice(0, 3)
      : [];
    const question =
      typeof parsed?.question === "string" && parsed.question.trim()
        ? parsed.question.trim()
        : undefined;
    return missing.length > 0 && question ? { missing, question } : { missing: [] };
  }
}
