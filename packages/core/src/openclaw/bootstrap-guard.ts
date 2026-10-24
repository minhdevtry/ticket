/**
 * `bootstrap-guard` — chặn một lỗ hổng quy trình: bot OpenClaw dựng từ template
 * gateway, nếu CHƯA seed persona + CHƯA xóa `BOOTSTRAP.md`, sẽ chạy "onboarding"
 * mặc định với NGƯỜI DÙNG THẬT — hỏi tên/bản chất/giọng/emoji và lộ cơ chế nội
 * bộ (file IDENTITY/SOUL) ra ngoài. Đã xảy ra thật với `@vhops_bot` (OP, 18/10):
 * ai nhắn bot cũng gặp màn "vừa thức dậy…". Bot thật (Tiểu Linh/Iris) không dính
 * vì persona đã điền sẵn và không còn BOOTSTRAP.md.
 *
 * Đây là hàm THUẦN: nhận NỘI DUNG các file (bot tự đọc đĩa bằng công cụ của nó
 * rồi đưa vào), trả danh sách phát hiện. Không đọc đĩa, không phụ thuộc runtime
 * — nên test được và dùng ở bất kỳ host nào. Một bot gọi nó lúc khởi động và
 * TỪ CHỐI phục vụ (hoặc cảnh báo to) khi chưa sẵn sàng, thay vì phơi onboarding.
 */

export type BootstrapSeverity = "block" | "warn";

export interface BootstrapFinding {
  /** `block` = bot KHÔNG nên nhận tin người thật; `warn` = nên sửa nhưng không chặn. */
  severity: BootstrapSeverity;
  /** Mã ngắn để nơi gọi phân nhánh: "bootstrap-present", "identity-empty", … */
  code: string;
  /** Mô tả người đọc hiểu. */
  message: string;
}

export interface WorkspaceFiles {
  /** Nội dung BOOTSTRAP.md nếu CÒN tồn tại (undefined = đã xóa, tốt). */
  bootstrap?: string;
  /** Nội dung IDENTITY.md. */
  identity?: string;
  /** Nội dung SOUL.md. */
  soul?: string;
  /** Nội dung AGENTS.md. */
  agents?: string;
}

/**
 * Dấu hiệu một file persona vẫn là TEMPLATE rỗng (chưa ai điền). Lấy từ chính
 * template gateway: các câu gợi ý "pick something you like", placeholder ngoặc
 * nhọn, hoặc file quá ngắn/không có nội dung thật.
 */
const TEMPLATE_MARKERS = [
  /pick something you like/i,
  /vừa thức dậy/i,
  /first run/i,
  /\bTODO\b/,
  /<[^>\n]{0,40}(tên|name|persona|bản chất|đặt tên)[^>\n]{0,40}>/i,
  /\(.*(điền|fill in|chọn).*\)/i,
];

/** AGENTS.md còn kiểu template "this folder is home / first run / BOOTSTRAP". */
const AGENTS_TEMPLATE_MARKERS = [
  /this folder is (your )?home/i,
  /first run/i,
  /BOOTSTRAP/,
];

function looksLikeTemplate(content: string | undefined, markers: RegExp[]): boolean {
  const text = (content ?? "").trim();
  if (text.length < 40) return true; // gần như rỗng
  return markers.some((re) => re.test(text));
}

/**
 * Soát workspace một bot OpenClaw mới. Trả về mọi phát hiện; rỗng = sẵn sàng
 * phục vụ. Thứ tự ưu tiên nghiêm trọng nhất trước.
 */
export function auditBootstrapReadiness(files: WorkspaceFiles): BootstrapFinding[] {
  const findings: BootstrapFinding[] = [];

  // 1. BOOTSTRAP.md còn ⇒ bot sẽ chạy onboarding. Nghiêm trọng nhất.
  if (files.bootstrap !== undefined && files.bootstrap.trim().length > 0) {
    findings.push({
      severity: "block",
      code: "bootstrap-present",
      message:
        "BOOTSTRAP.md vẫn còn — bot sẽ chạy onboarding mặc định (hỏi tên/bản chất/emoji) với người dùng thật và lộ cơ chế nội bộ. Xóa BOOTSTRAP.md sau khi đã điền persona.",
    });
  }

  // 2. IDENTITY/SOUL vẫn là template rỗng ⇒ chưa có persona.
  if (looksLikeTemplate(files.identity, TEMPLATE_MARKERS)) {
    findings.push({
      severity: "block",
      code: "identity-empty",
      message: "IDENTITY.md còn là template rỗng (chưa điền persona) — bot chưa biết nó là ai. Điền trước khi cho ai nhắn.",
    });
  }
  if (looksLikeTemplate(files.soul, TEMPLATE_MARKERS)) {
    findings.push({
      severity: "warn",
      code: "soul-empty",
      message: "SOUL.md còn là template rỗng — nên điền giọng điệu/nguyên tắc để bot không trả lời chung chung.",
    });
  }

  // 3. AGENTS.md còn kiểu "home/first run" ⇒ bot chưa có quy trình vận hành.
  if (looksLikeTemplate(files.agents, AGENTS_TEMPLATE_MARKERS)) {
    findings.push({
      severity: "block",
      code: "agents-template",
      message:
        "AGENTS.md vẫn là template gateway (\"this folder is home\"/first run/BOOTSTRAP) — bot chưa có quy trình tiếp nhận. Viết AGENTS.md quy trình thật trước khi phục vụ.",
    });
  }

  return findings;
}

/**
 * Bot có SẴN SÀNG nhận tin người thật không? False khi còn bất kỳ phát hiện
 * `block`. Dùng ở khởi động: nếu chưa sẵn sàng thì từ chối phục vụ + log, thay
 * vì phơi onboarding ra ngoài.
 */
export function isBootstrapSafe(files: WorkspaceFiles): boolean {
  return !auditBootstrapReadiness(files).some((f) => f.severity === "block");
}
