/**
 * Nhận diện báo cáo nhiều sự cố/học sinh + chốt chặn tiêu đề (W29-SPLIT — Vòng 2, 19/10/2026).
 *
 * Nguyên tắc Vòng 2: CHÍNH XÁC TRƯỚC, MỘT LẦN NGẮT OAN TỆ HƠN MỘT LẦN BỎ SÓT.
 * Bản Vòng 1 (commit c4d5881) bị đánh giá DO-NOT-SHIP: 85.7% báo động giả offline,
 * 88.6% trên 1.495 lượt server. Ba luật sinh ra gần hết số đó:
 *   1. "Mọi cụm Title Case là tên người" (`|| allCapitalized` + dải Unicode
 *      `[A-ZÀ-Ỹ]` ăn luôn chữ thường có dấu) → chặn họng câu trả lời "Sale ạ",
 *      "Zalo PC ạ", "MỨC ĐỘ CAO" và xoá sổ tiêu đề "Đổi Lịch Học".
 *   2. Xung đột TÊN so với `rawText` cũ → park mỗi lần người báo bổ sung tên ở
 *      lượt sau (12 ca trên server).
 *   3. Bóc định danh không nhãn: `?cid=670` trong URL, SĐT, TK/MK, mã phiếu thu
 *      TNX…, số tiền, ngày → xung đột giả.
 * Vòng 2 chỉ còn nhận xung đột từ định danh CÓ NHÃN (Code:, Mã KH/Mã khách hàng:,
 * Mã học sinh/Mã HS:, UID/SID/CID: đứng riêng) và mã CRM 7-10 chữ số nằm TRỌN một
 * dòng (đúng dữ liệu thật TECH-1248/1249). Tên người KHÔNG BAO GIỜ tạo xung đột.
 */

import { identifiersConflict } from "../identifier-grounding";
import { VALID_REPORTING_DEPTS, VALID_SYSTEMS } from "../../mcp/tieulinh/domain/taxonomy";

export interface IncidentBlock {
  text: string;
  studentName?: string;
  customerId?: string;
  studentAccount?: string;
  reportingDept?: string;
  symptoms?: string[];
  title?: string;
  mediaPaths?: string[];
}

/** Định danh CÓ NHÃN bóc được từ một đoạn văn bản — các lớp so khớp độc lập nhau. */
export interface LabelledIdentifiers {
  /** Code: / Mã KH: / Mã khách hàng: / CID: / mã CRM 7-10 chữ số đứng riêng một dòng. */
  customer?: string;
  /** Mã học sinh: / Mã HS: / UID: / SID:. */
  student?: string;
  /**
   * SĐT di động (0[35789]xxxxxxxx) — giữ lại ĐÚNG MỘT lớp riêng cho bảo vệ TECH-928
   * (hai sự cố khác nhau chỉ phân biệt được bằng SĐT, đã gộp lặng lẽ một lần rồi).
   * Số nằm trong mã có chữ (TNX…, DH…) và dòng TK:/MK: KHÔNG tính — đó là nguồn
   * báo động giả FP-05/FP-10 của REVIEW.md §3.
   */
  phone?: string;
}

const VIETNAMESE_FAMILY_NAMES: Record<string, true> = {
  nguyen: true,
  nguyễn: true,
  tran: true,
  trần: true,
  le: true,
  lê: true,
  pham: true,
  phạm: true,
  hoang: true,
  hoàng: true,
  huynh: true,
  huỳnh: true,
  phan: true,
  vu: true,
  vũ: true,
  vo: true,
  võ: true,
  dang: true,
  đặng: true,
  bui: true,
  bùi: true,
  do: true,
  đỗ: true,
  ho: true,
  hồ: true,
  ngo: true,
  ngô: true,
  duong: true,
  dương: true,
  ly: true,
  lý: true,
  dao: true,
  đào: true,
  dinh: true,
  đinh: true,
  doan: true,
  đoàn: true,
  mai: true,
  trinh: true,
  trịnh: true,
  ha: true,
  hà: true,
  luong: true,
  lương: true,
  thai: true,
  thái: true,
  cao: true,
  chau: true,
  châu: true,
  lam: true,
  lâm: true,
  đàm: true,
  trương: true,
  tạ: true,
  phùng: true,
  vương: true,
  tống: true,
  triệu: true,
  quách: true,
};

/** Các từ chỉ lỗi/sự cố/vấn đề kỹ thuật (mở rộng thêm các trường hợp số buổi, hiển thị, sai lệch). */
export const EXPANDED_PROBLEM_WORDS =
  /(?:lỗi|không|ko\b|bị|sập|treo|đơ|hỏng|error|mất|chậm|văng|sai|lệch|thiếu|nhầm|chưa|lỡ|đang hiện|đang hiển thị|đúng phải là|sửa lại|không vào được|không hiện|không thấy)/iu;

const POLITE_OR_GREETING_PREFIXES =
  /^(?:em chào|chào|alo|nhờ tech|nhờ anh chị|nhờ ad|hỗ trợ em với|cho em hỏi|ad ơi|check giúp|e cảm ơn)\b/iu;

/** Chữ HOA thật theo Unicode (`\p{Lu}` + cờ u). Dải `[A-ZÀ-Ỹ]` của Vòng 1 ăn cả chữ thường có dấu (Bug 1). */
const UPPERCASE_START = /^\p{Lu}/u;

/**
 * Cụm MỨC ƯU TIÊN trần ("MỨC ĐỘ CAO", "gấp", "trung bình") — câu trả lời cho câu hỏi mức ưu
 * tiên của bot, không bao giờ là mô tả sự cố (P4, Vòng 3 / REVIEW2 §5).
 */
const BARE_PRIORITY_RE =
  /^(?:mức\s*độ\s*(?:cao|trung\s*bình|thấp)|cao|trung\s*bình|thấp|gấp|khẩn\s*cấp|urgent|high|medium|low)$/iu;

const normalizeLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*#\\]/g, "")
    .replace(/[_\s]+/g, "")
    .trim();
/** Nhãn danh mục (phòng ban + hệ thống) — bảng tra tĩnh theo nhãn chuẩn hoá. */
const TAXONOMY_LABELS: Record<string, true> = Object.fromEntries(
  [...VALID_REPORTING_DEPTS, ...VALID_SYSTEMS].map((v) => [normalizeLabel(v), true]),
) as Record<string, true>;

/**
 * Câu trả lời TRẦN cho một câu hỏi của bot: chỉ là mức ưu tiên ("MỨC ĐỘ CAO") hoặc đúng một
 * nhãn phòng ban / hệ thống trong danh mục ("Sale ạ", "Quản lý lớp", "LMS_Vuihoc").
 *
 * Tiêu đề ticket phải là CÂU MÔ TẢ LỖI; gặp câu trả lời trần thì nơi gọi rơi về DÒNG MÔ TẢ
 * LỖI trong báo cáo (P4, Vòng 3 / REVIEW2 §5).
 */
export function isBareAnswerLabel(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const cleaned = text
    .replace(/[*#\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,.!?;:]+$/u, "")
    .replace(/\s+(?:ạ|a|nhé|nha|vâng|dạ|đó)$/u, "")
    .trim();
  if (!cleaned) return false;
  if (BARE_PRIORITY_RE.test(cleaned)) return true;
  return TAXONOMY_LABELS[normalizeLabel(cleaned)] === true;
}

/**
 * Kiểm tra xem một chuỗi có phải chỉ là tên người (tên học sinh / phụ huynh).
 *
 * Vòng 2: bắt buộc từ ĐẦU TIÊN là họ người Việt VÀ mọi từ đều bắt đầu bằng chữ
 * HOA Unicode thật. Nhờ vậy "Trần Thị B" là tên người, còn "Đổi Lịch Học",
 * "Sale ạ", "Zalo PC ạ", "MỨC ĐỘ CAO" thì không (Bug 1 + Bug 2 của REVIEW.md §4).
 */
export function isPersonNameOnly(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const cleaned = text
    .replace(/[*_#\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;
  // Có từ chỉ lỗi kỹ thuật, chữ số, hoặc dấu gán nhãn → không phải chỉ là tên người
  if (EXPANDED_PROBLEM_WORDS.test(cleaned) || /[\d:=]/.test(cleaned)) return false;
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (VIETNAMESE_FAMILY_NAMES[words[0].toLowerCase()] !== true) return false;
  return words.every((w) => UPPERCASE_START.test(w));
}

/** Tên này có thật sự xuất hiện như MỘT DÒNG tên riêng trong báo cáo không (dòng trước "Code:")? */
export function appearsAsNameLine(reportText: string, title: string): boolean {
  if (!reportText) return false;
  const target = title
    .replace(/[*_#\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!target) return false;
  return reportText
    .split("\n")
    .map((l) =>
      l
        .replace(/[*_#\\]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    )
    .some((l) => l === target);
}

/**
 * Chốt chặn tiêu đề: từ chối tiêu đề rỗng, chỉ chữ số, chỉ dòng khai mã, chỉ lời
 * chào, hoặc chỉ là tên người.
 *
 * Khi có `reportText`, tên người chỉ bị từ chối nếu nó THẬT SỰ là một dòng tên
 * trong chính báo cáo đó — không từ chối oan cụm Title-Case (Bug 2).
 */
export function isInvalidTitle(title: string | null | undefined, reportText?: string): boolean {
  if (!title || typeof title !== "string") return true;
  const trimmed = title
    .replace(/[*_#\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length < 4) return true;
  // Toàn là chữ số
  if (/^\d+$/.test(trimmed)) return true;
  // Chỉ là dòng khai báo mã: "Code: 9100003", "Mã học sinh: 90106"
  if (
    /^(?:code|mã\s*(?:kh|khách\s*hàng|học\s*sinh|hs|lớp|đơn|crm)|cid|uid|sid|sđt|phone)\s*[:=]?\s*[\w-]+$/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Chỉ là câu trả lời TRẦN cho câu hỏi của bot: mức ưu tiên ("MỨC ĐỘ CAO") hoặc một nhãn
  // phòng ban / hệ thống ("Sale ạ", "LMS_Vuihoc") — tiêu đề phải là câu mô tả lỗi (P4, Vòng 3).
  if (isBareAnswerLabel(trimmed)) return true;
  // Chỉ là câu chào/nhờ vả trần
  if (POLITE_OR_GREETING_PREFIXES.test(trimmed) && !EXPANDED_PROBLEM_WORDS.test(trimmed)) {
    return true;
  }
  if (isPersonNameOnly(trimmed)) {
    if (!reportText) return true;
    return appearsAsNameLine(reportText, trimmed);
  }
  return false;
}

const POLITE_PHRASES_CLEANUP =
  /(?:nhờ\s*(?:tech|anh\s*chị|ad)[^,\n]*|check\s*giúp[^,\n]*|hỗ\s*trợ\s*(?:em|mình)[^,\n]*|e\s*cảm\s*ơn[^,\n]*|giúp\s*e\s*ạ[^,\n]*)/giu;

/** Bỏ nhãn định danh, mã đơn/phiếu (DH…, TNX…), chuỗi số, dấu câu — còn lại là chữ "văn xuôi". */
function residualProse(text: string): string {
  return text
    .replace(
      /(?:code|mã\s*(?:kh|khách\s*hàng|học\s*sinh|hs|crm)|cid|uid|sid|sđt|tk|mk|phone)\s*[:=]?/giu,
      " ",
    )
    .replace(/[A-Z]{2,5}[-_]?\d{3,}/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
}

/** Khối chỉ gồm định danh/mã/số, không có câu chữ nào (vd "90000003 - 0900000003 DH900003 UID: 900017"). */
function isBareIdentifierBlock(block: string): boolean {
  return residualProse(block).length === 0;
}

/**
 * Tìm tiêu đề tóm tắt sự cố từ nội dung văn bản khi tiêu đề cũ là tên người hoặc không hợp lệ.
 * Fallback = DÒNG MÔ TẢ LỖI ĐẦU TIÊN, tuyệt đối không lấy tên người (TECH-1146).
 */
export function deriveFallbackTitle(
  text: string,
  symptoms?: string[],
  studentNames?: string[],
): string {
  const sources = [
    ...(symptoms ?? []),
    ...text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  ];

  const candidates: string[] = [];
  for (const line of sources) {
    // Bỏ gạch đầu dòng / số thứ tự ("=> ", "1. ", "- ") nhưng giữ nguyên phần chữ
    const rawClean = line
      .replace(/^\s*(?:\d+[.)]\s+)?[\s*=>•\-#]+/, "")
      .replace(/[*_#\\]/g, "")
      .trim();
    // Bỏ tiền tố định danh nếu dòng bắt đầu bằng "Mã học sinh: ... lỗi ..."
    const strippedId = rawClean
      .replace(
        /^(?:(?:code|mã\s*(?:kh|khách\s*hàng|học\s*sinh|hs|crm)|cid|uid|sid|sđt|tk|mk)\s*[:=]?\s*[A-Za-z]{0,4}\d+\s*)+/iu,
        "",
      )
      .trim();

    if (!strippedId) continue;
    if (isPersonNameOnly(strippedId)) continue;
    if (/^\d+$/.test(strippedId)) continue;
    if (isBareIdentifierBlock(strippedId)) continue;
    // Câu trả lời trần cho câu hỏi của bot (mức ưu tiên / nhãn phòng ban / hệ thống)
    // KHÔNG phải mô tả lỗi — bỏ qua để rơi xuống dòng mô tả lỗi thật (P4, Vòng 3).
    if (isBareAnswerLabel(strippedId)) continue;
    candidates.push(strippedId);
  }

  const best =
    candidates.find((c) => EXPANDED_PROBLEM_WORDS.test(c)) ??
    candidates.find((c) => c.length >= 12) ??
    candidates[0];
  if (best) {
    const cleaned =
      best
        .replace(POLITE_PHRASES_CLEANUP, "")
        .replace(/[\s,.-]+$/, "")
        .trim() || best;
    if (cleaned.length >= 8) {
      return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 77) + "...";
    }
  }

  if (studentNames && studentNames.length > 1) {
    return `Sự cố của ${studentNames.length} học sinh (${studentNames.join(", ")})`;
  }
  if (studentNames && studentNames.length === 1) {
    return `Sự cố học sinh ${studentNames[0]}`;
  }

  return "Sự cố kỹ thuật";
}

// ---------------------------------------------------------------------------
// Định danh CÓ NHÃN
// ---------------------------------------------------------------------------

/**
 * Nhãn định danh khách hàng (mã CRM / mã khách hàng). Nhãn phải đứng RIÊNG (trước
 * nó không phải chữ/số/`?`/`&`/`=`/`.`/`-`) và cách giá trị bằng `:` / `=` hoặc
 * khoảng trắng — nhờ vậy `?cid=670` trong link LMS không tính (ký tự trước `cid`
 * là `?`), còn "Code 9100004" / "Code: 9100002" thì tính.
 */
const CUSTOMER_CODE_RE =
  /(?:^|[^\p{L}\p{N}_?&=/.-])(?:code|mã\s*(?:kh|khách\s*hàng|crm)|cid)(?:\s*[:=]\s*|\s+)([A-Za-z]{0,4}\d{4,12})/iu;
/** Nhãn định danh học sinh. `TK:`/`MK:` (tài khoản đăng nhập) KHÔNG nằm trong đây. */
const STUDENT_CODE_RE =
  /(?:^|[^\p{L}\p{N}_?&=/.-])(?:mã\s*(?:học\s*sinh|hs)|uid|sid)(?:\s*[:=]\s*|\s+)([A-Za-z]{0,4}\d{3,12})/iu;
/** Mã CRM 7-10 chữ số nằm TRỌN một dòng, không bắt đầu bằng 0 (loại SĐT). */
const STANDALONE_CRM_LINE_RE = /^(\d{7,10})$/;
/** SĐT di động Việt Nam đứng RIÊNG (không dính chữ/số hai bên → loại ruột mã TNX…, DH…). */
const MOBILE_PHONE_RE = /(?<![\p{L}\p{N}])(?:\+?84|0)[35789]\d{8}(?![\p{L}\p{N}])/u;
/** SĐT CÓ NHÃN ("SĐT phụ huynh 0900000004") — bằng chứng rõ ràng mới đủ để ngắt lời người báo. */
const LABELLED_PHONE_RE =
  /(?:sđt|số\s*điện\s*thoại|điện\s*thoại|phone)\s*(?:[:=]\s*|\s+)[^\d\n]{0,20}?((?:\+?84|0)[35789]\d{8})/iu;
/** Dòng đăng nhập (TK/MK/tài khoản) — SĐT trong đó là tài khoản demo, không phải định danh người báo. */
const LOGIN_FRAGMENT_RE = /\b(?:tk|mk|tài\s*khoản|mật\s*khẩu)\s*[:=]?\s*[^\s,;()]{1,25}/giu;

/**
 * Bóc định danh CÓ NHÃN từ một đoạn văn bản (tin nhắn mới hoặc `rawText` của tờ
 * khai đang mở). Không bao giờ bóc: tham số URL (`?cid=670`), mã phiếu thu/đơn
 * (TNX…, DH…), SĐT nằm trong dòng TK/MK, tiền, ngày.
 */
export function extractLabelledIdentifiers(
  text: string | undefined,
  options: {
    /**
     * true = dùng cho `rawText` của tờ khai ĐANG MỞ (trạng thái đã có): SĐT trần
     * trong lời kể cũng tính. false = dùng cho tin nhắn MỚI: chỉ SĐT có nhãn
     * ("SĐT …", "số điện thoại …") mới đủ để ngắt lời người báo (Vòng 2 — 3/7
     * lần ngắt oan trên server đến từ SĐT trần).
     */
    allowBarePhone?: boolean;
  } = {},
): LabelledIdentifiers {
  const out: LabelledIdentifiers = {};
  if (!text) return out;

  out.customer = text.match(CUSTOMER_CODE_RE)?.[1];
  out.student = text.match(STUDENT_CODE_RE)?.[1];

  if (!out.customer) {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || /[?&=]|http/i.test(line)) continue;
      const m = STANDALONE_CRM_LINE_RE.exec(line);
      if (m && !m[1].startsWith("0")) {
        out.customer = m[1];
        break;
      }
    }
  }

  const scrubbed = text.replace(LOGIN_FRAGMENT_RE, " ");
  out.phone = scrubbed.match(LABELLED_PHONE_RE)?.[1];
  if (!out.phone && options.allowBarePhone) {
    for (const rawLine of scrubbed.split("\n")) {
      const m = rawLine.match(MOBILE_PHONE_RE);
      if (m) {
        out.phone = m[0];
        break;
      }
    }
  }
  return out;
}

/**
 * Hai bộ định danh có XUNG ĐỘT không? Chỉ so CÙNG LỚP (khách hàng với khách hàng,
 * học sinh với học sinh, SĐT với SĐT) và chỉ khi CẢ HAI bên đều có giá trị — "giá
 * trị mới mà tờ khai chưa từng có" KHÔNG phải xung đột. Tên người không tham gia.
 */
export function identityConflict(
  existing: LabelledIdentifiers,
  incoming: LabelledIdentifiers,
): "customer" | "student" | "phone" | undefined {
  for (const kind of ["customer", "student", "phone"] as const) {
    const a = existing[kind];
    const b = incoming[kind];
    if (a && b && identifiersConflict(a, b)) return kind;
  }
  return undefined;
}

/**
 * Trích xuất thông tin định danh và tên học sinh từ một khối văn bản.
 * `studentName` chỉ để mô tả/nhãn khối — KHÔNG dùng để chặn hay tách ticket.
 */
export function extractBlockInfo(block: string): {
  studentName?: string;
  customerId?: string;
  studentAccount?: string;
  reportingDept?: string;
} {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const identifiers = extractLabelledIdentifiers(block);
  let studentName: string | undefined;
  let reportingDept: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.replace(/\*\*/g, "").trim();

    // Quản lý lớp / QLL
    if (/quản\s*lý\s*lớp|\bqll\b|bộ\s*phận\s*qll/i.test(l)) {
      reportingDept = reportingDept ?? "Quản lý lớp";
    }

    // Tên học sinh: **Tên** hoặc dòng đầu dạng tên riêng
    const nameMatch = raw.match(/^\*\*([^*]+)\*\*$/);
    if (nameMatch && !studentName && isPersonNameOnly(nameMatch[1])) {
      studentName = nameMatch[1].trim();
    } else if (
      i === 0 &&
      !studentName &&
      !/[:=]/.test(l) &&
      !/^\d+$/.test(l) &&
      isPersonNameOnly(l)
    ) {
      studentName = l;
    }
  }

  return {
    studentName,
    customerId: identifiers.customer,
    studentAccount: identifiers.student,
    reportingDept,
  };
}

/** Dấu hiệu "danh sách ví dụ" — một sự cố hệ thống kèm vài HS làm chứng cứ, KHÔNG được tách. */
const EXAMPLE_LIST_MARKER =
  /(?:\bvdu\b|\bví\s*dụ\b|\bvd\b|dưới\s*đây|các\s+hs\b|các\s+học\s*sinh\b|một\s*số\s+hs\b|một\s*số\s+học\s*sinh\b|kèm\s+(?:các\s+)?hs)/iu;

/**
 * Nhận diện tin nhắn chứa ≥ 2 sự cố/học sinh ĐỘC LẬP đáng hỏi người báo.
 *
 * Vòng 2 yêu cầu mỗi khối phải có định danh CÓ NHÃN riêng, có câu mô tả lỗi
 * riêng (hoặc chỉ toàn định danh như "90000001"), và hai khối phải mang hai giá
 * trị CÙNG LỚP khác nhau. Danh sách HS ví dụ dưới một sự cố hệ thống bị loại.
 */
export function splitMultiIncidentReport(text: string): IncidentBlock[] | null {
  if (!text || text.length < 30) return null;
  // "Vdu:", "ví dụ", "dưới đây là 2 HS", "các HS" → một sự cố hệ thống kèm ví dụ
  if (EXAMPLE_LIST_MARKER.test(text)) return null;
  // Không có mô tả lỗi nào thì không có chuyện tách nhiều sự cố
  if (!EXPANDED_PROBLEM_WORDS.test(text)) return null;

  // Tách theo 2 dấu xuống dòng trở lên
  let rawBlocks = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  // Nếu không có 2 dòng trống, thử tách theo mẫu mở đầu khối mới (số thứ tự 1./2., **Tên**, Code:, mã CRM trần)
  if (rawBlocks.length < 2) {
    const headerSplit = text.split(
      /(?=\n(?:\d+[.)]|\*\*[^*]+\*\*|[Bb]ạn\s+\d+|[Hh][Ss]\s+\d+|[Hh]ọc\s+sinh\s+\d+|Code:\s*\d+|\b\d{7,10}\b))/,
    );
    if (headerSplit.length >= 2) {
      rawBlocks = headerSplit.map((b) => b.trim()).filter(Boolean);
    }
  }

  if (rawBlocks.length < 2) return null;

  const validBlocks: IncidentBlock[] = [];
  for (const block of rawBlocks) {
    const info = extractBlockInfo(block);
    // Chỉ tách theo định danh KHÁCH HÀNG / HỌC SINH có nhãn — SĐT không tạo việc tách
    // (hai HS ví dụ của một lỗi hệ thống thường chỉ khác SĐT, xem TECH-603).
    if ((!info.customerId && !info.studentAccount) || block.length < 15) continue;
    // Khối phải có câu chữ riêng KHÔNG phải chỉ là dòng tên người ("Phạm Thị E (SID: 900012)").
    // Khối KHÔNG có câu chữ nào chỉ được tính khi nó là "đầu ca" thật: có mã khách
    // hàng hoặc mã đơn (DH…, TNX…) — dòng chỉ ghi mỗi mã học sinh (TECH-391: hai anh
    // em cùng một mã khách hàng, cùng một lỗi hệ thống) không đủ để tách.
    const prose = residualProse(block);
    if (prose.length > 0) {
      if (isPersonNameOnly(prose)) continue;
    } else if (!info.customerId && !/[A-Z]{2,5}[-_]?\d{4,}/.test(block)) {
      continue;
    }
    const title = deriveFallbackTitle(
      block,
      undefined,
      info.studentName ? [info.studentName] : undefined,
    );
    validBlocks.push({
      text: block,
      studentName: info.studentName,
      customerId: info.customerId,
      studentAccount: info.studentAccount,
      reportingDept: info.reportingDept,
      title,
    });
  }

  if (validBlocks.length < 2) return null;

  // Chỉ tách khi có ≥ 2 giá trị CÙNG LỚP khác nhau (Bug 9: không so `!== undefined`)
  const customers = new Set(validBlocks.map((b) => b.customerId).filter(Boolean) as string[]);
  const students = new Set(validBlocks.map((b) => b.studentAccount).filter(Boolean) as string[]);
  if (customers.size >= 2 || students.size >= 2) {
    return validBlocks;
  }

  return null;
}
