import { complete, extractJson, isLlmConfigured, type LlmConfig } from "../../worker/llm";
import {
  VALID_PRODUCTS,
  VALID_SYSTEMS,
  VALID_ERROR_CATEGORIES,
  VALID_REPORTING_DEPTS,
  VALID_DEVICE_TYPES,
} from "../../mcp/tieulinh/domain/taxonomy";
import {
  describeExtractedKeys,
  extractedFieldsSchema,
  type ExtractedFields,
} from "./extractor-schema";
import { getLogger } from "@vuihoc/bot-core/core";
import {
  extractBlockInfo,
  isInvalidTitle,
  deriveFallbackTitle,
  EXPANDED_PROBLEM_WORDS,
} from "./multi-incident";

/** Rút thông điệp từ lỗi mà không ép kiểu `any` — lỗi tới từ nhiều nguồn. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

export const SYSTEM_SYNONYMS: Record<string, string> = {
  crm: "CRM_Vuihoc",
  "crm vuihoc": "CRM_Vuihoc",
  lms: "LMS_Vuihoc",
  "app vuihoc": "VH_Tự học",
  "web vuihoc": "VH_Tự học",
  app: "VH_Tự học",
  web: "VH_Tự học",
  duo: "DUO_Vuihoc",
  "erp duo": "DUO_Vuihoc",
  bitu: "DUO_Vuihoc",
  "bitu chat": "DUO_Vuihoc",
  tutor: "TUTOR_Vuihoc",
  "gia sư": "TUTOR_Vuihoc",
  "tutor vuihoc": "TUTOR_Vuihoc",
  classin: "ClassIn",
  care: "CARE_Vuihoc",
  "care vuihoc": "CARE_Vuihoc",
  oms: "CRM_Vuihoc", // rule tech lead: OMS chỉ setup sản phẩm/CTKM; lỗi đơn là CRM
  vneschool: "VNESCHOOL",
  "tự học": "VH_Tự học",
  "tự ôn luyện": "VH_Tự học",
  "hạ tầng": "Khác_Hạ tầng_IT",
  khác: "Khác_Hạ tầng_IT",
  // Công cụ liên lạc bên thứ 3 (Zalo, Viber, Messenger…) — data TECH thật phân
  // loại các lỗi này vào Khác_Hạ tầng_IT (soi TECH-876..887).
  zalo: "Khác_Hạ tầng_IT",
  "zalo pc": "Khác_Hạ tầng_IT",
  viber: "Khác_Hạ tầng_IT",
  messenger: "Khác_Hạ tầng_IT",
  telegram: "Khác_Hạ tầng_IT",
};

/** Từ khoá quá chung để tự suy hệ thống từ câu chữ (chỉ dùng khi model/nút trả đúng từ đó). */
const GENERIC_SYSTEM_KEYS = new Set(["app", "web", "khác"]);

export const DEPT_SYNONYMS: Record<string, string> = {
  vh: "Vận hành",
  cskh: "CSKH",
  "chăm sóc khách hàng": "CSKH",
  cshv: "CSHV",
  "chăm sóc học viên": "CSHV",
  cm: "Chuyên môn",
  sale: "Sale",
  sales: "Sale",
  qll: "Quản lý lớp",
  vd: "Vận đơn",
};

/** Giới hạn độ dài tin nhắn gửi LLM — tin dán log dài hàng chục nghìn ký tự không được làm nổ prompt. */
export const MAX_LLM_MESSAGE_CHARS = 4000;
/** Giới hạn ngữ cảnh sự cố cũ gửi kèm LLM. */
export const MAX_LLM_CONTEXT_CHARS = 1500;

const INTENTS = ["report_issue", "provide_info", "confirm", "cancel", "chitchat"] as const;
type Intent = (typeof INTENTS)[number];

export type CompleteFn = (
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

export interface ExtractOptions {
  /** Ticket đã tạo cho tài liệu hiện tại — để LLM phân biệt bổ sung / việc mới / cảm ơn. */
  createdTicket?: { identifier: string; title?: string };
}

/**
 * Chuẩn hóa giá trị Out-of-Vocabulary (OOV) về từ vựng đóng của taxonomy
 */
export function normalizeWithSynonyms<T extends string>(
  val: string | null | undefined,
  validList: readonly T[],
  synonyms: Record<string, string>,
): T | undefined {
  if (!val || typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  if ((validList as readonly string[]).includes(trimmed)) {
    return trimmed as T;
  }
  const lower = trimmed.toLowerCase();
  const exact = validList.find((v) => v.toLowerCase() === lower);
  if (exact) return exact;
  for (const [k, v] of Object.entries(synonyms)) {
    if (lower === k || lower.includes(k) || k.includes(lower)) {
      if ((validList as readonly string[]).includes(v)) {
        return v as T;
      }
    }
  }
  return undefined;
}

/**
 * Kiểm tra xem chuỗi có phải số điện thoại Việt Nam (10 chữ số) không
 */
export function isVietnamesePhone(val?: string | null): boolean {
  if (!val) return false;
  return /^(?:\+84|0)[35789]\d{8}$/.test(val.replace(/[\s.-]+/g, ""));
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Tách tin nhắn thành từ (chữ thường, bỏ dấu câu/emoji) để so khớp NGUYÊN câu. */
function tokenize(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const CONFIRM_CORE = new Set([
  "ok",
  "oke",
  "okay",
  "okie",
  "oki",
  "đúng",
  "chuẩn",
  "xác",
  "tạo",
  "gửi",
  "đồng",
  "yes",
  "y",
  "được",
  "chính",
]);
const CONFIRM_WORDS = new Set([
  ...CONFIRM_CORE,
  "nhận",
  "ý",
  "xác",
  "rồi",
  "đi",
  "luôn",
  "giúp",
  "em",
  "chị",
  "anh",
  "mình",
  "nhé",
  "nha",
  "ạ",
  "dạ",
  "vâng",
  "ticket",
  "vé",
  "cho",
  "với",
  "vậy",
  "thế",
  "là",
  "nhận",
  "e",
  "c",
  "a",
]);

/**
 * Câu đồng ý NGẮN — cả tin nhắn chỉ gồm từ đồng ý và từ đệm.
 *
 * Bản cũ là `/^(?:ok|…|y|…)/i`: không có ranh giới từ, nên "Yêu cầu hỗ trợ: …"
 * khớp "y", "ok app Duo lỗi…" khớp "ok" — và ticket bị tạo ngay từ tin đầu.
 */
export function isShortConfirmation(text: string): boolean {
  if (!text || text.length > 60) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0 || tokens.length > 8) return false;
  return tokens.every((t) => CONFIRM_WORDS.has(t)) && tokens.some((t) => CONFIRM_CORE.has(t));
}

const CANCEL_WORDS = new Set([
  "hủy",
  "huỷ",
  "cancel",
  "dừng",
  "bỏ",
  "qua",
  "thôi",
  "không",
  "cần",
  "đi",
  "nhé",
  "nha",
  "ạ",
  "giúp",
  "em",
  "chị",
  "anh",
  "mình",
  "ticket",
  "vé",
  "yêu",
  "cầu",
  "này",
  "luôn",
  "tạo",
  "nữa",
  "đâu",
  "rồi",
  "dạ",
  "vâng",
  "cho",
  "với",
  "báo",
  "cáo",
  "lại",
  "e",
  "c",
  "a",
]);

/**
 * Huỷ TƯỜNG MINH: cả tin nhắn là một câu huỷ ("hủy", "thôi không cần nữa", "bỏ qua").
 * Bản cũ `/^(?:…|không|…)/` biến "không vào được lớp…" thành lệnh huỷ.
 */
export function isExplicitCancel(text: string): boolean {
  if (!text || text.length > 60) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0 || !tokens.every((t) => CANCEL_WORDS.has(t))) return false;
  // "không" chỉ hợp lệ trong "không cần"
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "không" && tokens[i + 1] !== "cần") return false;
  }
  const joined = ` ${tokens.join(" ")} `;
  return (
    /\s(?:hủy|huỷ|cancel|dừng)\s/.test(joined) ||
    joined.includes(" bỏ qua ") ||
    joined.includes(" không cần ") ||
    tokens[0] === "thôi"
  );
}

const DECLINE_WORDS = new Set([
  "không",
  "ko",
  "k",
  "hông",
  "chưa",
  "biết",
  "rõ",
  "có",
  "nhớ",
  "dạ",
  "em",
  "chị",
  "anh",
  "mình",
  "ạ",
  "nhé",
  "nha",
  "luôn",
  "thông",
  "tin",
  "cái",
  "này",
  "đâu",
  "rồi",
  "cũng",
  "e",
  "c",
  "a",
  "thì",
  "chịu",
]);

/** "không biết", "em không rõ ạ", "chưa có" — người dùng nói rõ là không trả lời được câu vừa hỏi. */
export function isDeclineAnswer(text: string): boolean {
  if (!text || text.length > 40) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0 || !tokens.every((t) => DECLINE_WORDS.has(t))) return false;
  if (tokens.includes("chịu")) return true;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^(?:không|ko|k|hông|chưa)$/.test(tokens[i]) && /^(?:biết|rõ|có|nhớ)$/.test(tokens[i + 1]))
      return true;
  }
  return false;
}

const CHITCHAT_CORE = new Set([
  "cảm",
  "cám",
  "thanks",
  "thank",
  "tks",
  "thx",
  "chào",
  "hi",
  "hello",
]);
const CHITCHAT_WORDS = new Set([
  ...CHITCHAT_CORE,
  "ơn",
  "you",
  "ok",
  "oke",
  "vâng",
  "dạ",
  "em",
  "chị",
  "anh",
  "nhé",
  "nha",
  "ạ",
  "nhiều",
  "rất",
  "bot",
  "linh",
  "tiểu",
  "mình",
  "ạh",
  "luôn",
  "nhá",
  "e",
  "c",
  "a",
  "much",
  "so",
]);

/** Lời cảm ơn / chào hỏi thuần tuý — không mang thông tin sự cố. */
export function isChitchat(text: string): boolean {
  if (!text || text.length > 60) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0) return true;
  if (!tokens.every((t) => CHITCHAT_WORDS.has(t))) return false;
  return (
    tokens.some((t) => CHITCHAT_CORE.has(t)) ||
    tokens.every((t) => t === "dạ" || t === "vâng" || t === "ạ")
  );
}

const TITLE_EDIT =
  /^(?:(?:em|chị|anh|mình|cho em|nhờ em)\s+)?(?:sửa|đổi|thay)\s+(?:lại\s+)?tiêu\s*đề\s*(?:thành|là|sang)?\s*[:\-–]?\s*["“'«]?(.+?)["”'»]?\s*$/iu;
const SYMPTOM_REMOVE =
  /^(?:(?:em|chị|anh|mình)\s+)?(?:bỏ|xoá|xóa|gỡ)\s+(?:ý|triệu\s*chứng|dòng|phần)\s*(?:là|:)?\s*["“'«]?(.+?)["”'»]?\s*$/iu;

/** Lệnh sửa tờ khai tường minh ("sửa tiêu đề thành …", "bỏ ý …") — tất định, không cần LLM. */
export function parseEditCommand(
  text: string,
): { title?: string; removeSymptoms?: string[] } | null {
  const trimmed = text.trim();
  const t = TITLE_EDIT.exec(trimmed);
  if (t && t[1].trim()) return { title: capText(t[1].trim(), 120) };
  const r = SYMPTOM_REMOVE.exec(trimmed);
  if (r && r[1].trim()) return { removeSymptoms: [r[1].trim()] };
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Suy hệ thống từ câu chữ: tên chuẩn trước, rồi từ đồng nghĩa dài trước ngắn sau (bỏ từ quá chung). */
export function detectSystem(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const s of VALID_SYSTEMS) {
    if (lower.includes(s.toLowerCase())) return s;
  }
  const entries = Object.entries(SYSTEM_SYNONYMS)
    .filter(([k]) => !GENERIC_SYSTEM_KEYS.has(k))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [k, v] of entries) {
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(k)}(?:$|[^\\p{L}\\p{N}])`, "u").test(lower))
      return v;
  }
  return undefined;
}

const PHONE_RE = /(?:\+?84|0)[35789]\d{8}\b/;
const FOLLOW_UP_PREFIX =
  /^(?:bổ sung|thêm|à|à quên|quên|ngoài ra|cập nhật|update|thông tin thêm|gửi thêm)\b/iu;
const PROBLEM_WORDS = /(?:lỗi|không|ko\b|bị|sập|treo|hỏng|error|mất|chậm|văng)/iu;

function pickEnum<T extends string>(value: unknown, list: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  return list.find((v) => v.toLowerCase() === lower);
}

function pickString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined")
    return undefined;
  return trimmed;
}

const BLOCKS_LEARNING_RE =
  /không\s+(?:vào|tham gia|học|mở)\s*(?:được)?\s*(?:vào\s*)?(?:lớp|phòng học|buổi học|bài học|học)|chưa\s+(?:được\s+)?xếp lớp|không có khoá|khoá (?:học )?không active/i;
const GROUP_SCOPE_RE =
  /cả lớp|nhiều (?:học sinh|hs|bạn|phụ huynh|lớp)|\b\d{2,}\s*(?:học sinh|hs|bạn|phụ huynh)|tất cả học sinh|hàng loạt/i;
const SYSTEM_SCOPE_RE =
  /toàn (?:bộ )?hệ thống|toàn bộ (?:người dùng|học sinh)|hệ thống (?:sập|chết)|tất cả mọi người/i;
const BLOCKS_PAYMENT_RE =
  /không\s+(?:thể\s+)?thanh toán|thanh toán\s+(?:bị\s+)?(?:lỗi|không được)|không\s+(?:tạo|lên|lập|chốt)\s+(?:được\s+)?đơn/i;

function foldVietnamese(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

/** Tin nhắn có nhắc bộ phận `dept` không — theo tên (bỏ dấu) hoặc viết tắt trong DEPT_SYNONYMS. */
export function deptMentioned(text: string, dept: string): boolean {
  const folded = foldVietnamese(text);
  if (folded.includes(foldVietnamese(dept))) return true;
  return Object.entries(DEPT_SYNONYMS).some(
    ([alias, target]) =>
      target === dept &&
      new RegExp(`(^|[^a-z0-9])${foldVietnamese(alias)}([^a-z0-9]|$)`).test(folded),
  );
}

/** Cụm người dùng tự gọi bộ phận mình: "bộ phận Kế toán", "bên kinh doanh", "phòng Vận đơn"… */
/** Các từ dẫn nghĩa "bộ phận" trong văn nói — dùng trong DEPT_MENTION_RE. */
const DEPT_PREFIX_WORDS = "bộ phận|bophan|bên|phòng|khối|đội";
// Chú ý: \b trong JS chỉ tính ký tự ASCII từ, "ạ"/"álido" không phải \w —
// biên sau từ phải viết là (?=$|[^A-Za-zÀ-ỹ0-9]) thay vì \b.
const DEPT_MENTION_RE = new RegExp(
  `(?:${DEPT_PREFIX_WORDS})\\s+([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ\\s]{0,30}?)` +
    `(?=[,.;!?]|$|\\s+(?:ạ|nhé|nha|ah|à|đang|đã|bị|không|cần|báo|mong|gặp)(?=$|[^A-Za-zÀ-ỹ0-9])|\\s+(?:${DEPT_PREFIX_WORDS})(?=$|[^A-Za-zÀ-ỹ0-9]))`,
  "iu",
);

/**
 * Bộ phận người dùng tự nêu nhưng không nằm trong danh mục đóng — để hỏi lại
 * đúng một lần với câu nói rõ "không có trong danh mục" kèm nút chọn, thay vì
 * hỏi lại y nguyên câu cũ như thể chưa đọc tin nhắn.
 * Trả undefined khi tin không nêu bộ phận nào, hoặc cái nêu đã khớp danh mục.
 */
export function detectUnrecognizedDept(text: string, matchedDept?: string): string | undefined {
  if (matchedDept) return undefined;
  const m = DEPT_MENTION_RE.exec(text);
  if (!m) return undefined;
  // Prefix khớp sớm (vd "bên" trong "bên bộ phận Kế toán") lọt từ prefix vào tên — bỏ đi.
  const name = m[1]
    .replace(new RegExp(`^(?:${DEPT_PREFIX_WORDS})\\s+`, "iu"), "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return undefined;
  // Cụm khớp danh mục (kể cả viết tắt) thì không phải unrecognized
  const foldedName = foldVietnamese(name);
  const known = [
    ...VALID_REPORTING_DEPTS.map((d) => foldVietnamese(d)),
    ...Object.keys(DEPT_SYNONYMS).map((a) => foldVietnamese(a)),
  ];
  if (known.some((k) => foldedName === k || foldedName.includes(k))) return undefined;
  return capText(name, 60);
}

/** Cụm đầu tin chỉ là chào hỏi / giới thiệu bản thân — không đưa vào tiêu đề. */
const GREETING_PREFIX_RE =
  /^\s*(?:(?:em|chị|anh|con|tôi|mình)\s+(?:chào\s+(?:anh|chị|em|ad|mọi người)[^,.!]*[,.;]!?|là\s+\S+(?:\s+(?:bên|thuộc)\s+bộ phận[^,.!]*)?[,.;]!?|chào\s+anh[^,.!]*[,.;]!?))\s*/iu;

/** Bỏ lời chào/giới thiệu đầu câu tiêu đề dự phòng; "Zalo PC bị đơ…" giữ nguyên. */
export function stripGreeting(line: string): string {
  let out = line;
  // Lặp để bắt "Em chào anh, em là HueDT bên bộ phận Sale. Zalo bị đơ…" (2 cụm liên tiếp)
  for (let i = 0; i < 3; i++) {
    const next = out.replace(GREETING_PREFIX_RE, "");
    if (next === out) break;
    out = next;
  }
  return out.trim() || line.trim();
}

/** Luật nhận diện bằng chứng ưu tiên — chỉ bù khi LLM không trả (hoặc không có LLM). */
export function inferEvidence(
  text: string,
): Pick<ExtractedFields, "scope" | "blocksLearning" | "blocksPayment"> {
  const out: Pick<ExtractedFields, "scope" | "blocksLearning" | "blocksPayment"> = {};
  if (BLOCKS_LEARNING_RE.test(text)) out.blocksLearning = true;
  if (BLOCKS_PAYMENT_RE.test(text)) out.blocksPayment = true;
  if (SYSTEM_SCOPE_RE.test(text)) out.scope = "entire_system";
  else if (GROUP_SCOPE_RE.test(text)) out.scope = "group";
  else if (out.blocksLearning || out.blocksPayment) out.scope = "single_user";
  return out;
}

function pickBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export class FieldExtractor {
  constructor(
    private readonly llmConfig?: LlmConfig,
    private readonly completeFn: CompleteFn = complete,
  ) {}

  async extract(
    message: string,
    contextDescription?: string,
    opts: ExtractOptions = {},
  ): Promise<ExtractedFields> {
    if (!message || !message.trim()) {
      return { userIntent: "chitchat", symptoms: [] };
    }
    const text = message.trim();

    let parsedResult: Record<string, any> | null = null;
    /** LLM có cấu hình nhưng đã thử hết chuỗi model vẫn lỗi (vd 429 hết hạn mức). */
    let llmExhausted = false;

    if (isLlmConfigured(this.llmConfig)) {
      const systemPrompt = `Bạn là Trợ lý phân tích sự cố kỹ thuật của VuiHoc.
Nhiệm vụ của bạn là đọc tin nhắn của người dùng và trích xuất các thông tin có cấu trúc dưới dạng JSON chuẩn.
BẮT BUỘC chỉ chọn các giá trị nằm trong danh mục sau (nếu không rõ, hãy trả về null):
- Products: ${JSON.stringify(VALID_PRODUCTS)}
- Systems: ${JSON.stringify(VALID_SYSTEMS)}
- Error Categories: ${JSON.stringify(VALID_ERROR_CATEGORIES)}
- Reporting Depts: ${JSON.stringify(VALID_REPORTING_DEPTS)}
- Device Types: ${JSON.stringify(VALID_DEVICE_TYPES)}

QUY TẮC QUAN TRỌNG:
1. Số điện thoại (10 chữ số) LUÔN LUÔN là studentAccount, KHÔNG ĐƯỢC gán vào customerId. customerId chỉ là mã số định danh riêng.
2. userIntent (một trong ${JSON.stringify(INTENTS)}):
   - "confirm": CẢ tin nhắn chỉ là lời đồng ý tạo vé (ok, đúng rồi, tạo đi, chuẩn). Tin có kèm mô tả lỗi thì KHÔNG phải confirm.
   - "provide_info": bổ sung chi tiết cho sự cố đang trao đổi.
   - "report_issue": báo một sự cố (mới).
   - "cancel": người dùng nói rõ muốn huỷ/không cần tạo nữa. Chữ "không" trong mô tả lỗi KHÔNG phải huỷ.
   - "chitchat": cảm ơn, chào hỏi, không có thông tin sự cố; cả lời phản hồi về một ticket ĐÃ CÓ (vd "Ticket TECH-722 đã ổn rồi", "722 xong rồi nhé") — đó không phải sự cố mới.
3. title: tiêu đề ngắn (≤ 80 ký tự) TÓM TẮT LỖI của cả sự cố (ngữ cảnh trước đó + tin mới), kiểu "Không lên được đơn do trùng tài khoản con". KHÔNG dùng tên học sinh/phụ huynh, SĐT, mã HS/đơn/UID, lời chào hay câu nhờ vả ("hỗ trợ em với ạ") làm tiêu đề; chưa rõ lỗi gì thì để null. titleExplicit = true CHỈ khi người dùng yêu cầu đổi tiêu đề.
4. removeSymptoms: các triệu chứng người dùng bảo bỏ / nói là không đúng.
5. Các trường bằng chứng (scope, blocksLearning, blocksPayment, …) quyết định mức ưu tiên: điền true/false/enum khi tin nhắn cho biết, không rõ thì null.
6. Trả về ĐÚNG một object JSON (không kèm markdown \`\`\`json) với các khoá sau:
${describeExtractedKeys()}`;

      const ticketNote = opts.createdTicket
        ? `\nLƯU Ý: sự cố trên ĐÃ được tạo ticket ${opts.createdTicket.identifier}. Tin mới là bổ sung cho ticket đó → "provide_info"; một sự cố KHÁC → "report_issue"; cảm ơn/chào → "chitchat"; bấm xác nhận lại → "confirm".`
        : "";

      const userPrompt = `Ngữ cảnh sự cố trước đó (nếu có):
${contextDescription ? capText(contextDescription, MAX_LLM_CONTEXT_CHARS) : "(Chưa có)"}${ticketNote}

Tin nhắn mới của người dùng:
"${capText(text, MAX_LLM_MESSAGE_CHARS)}"`;

      try {
        const raw = await this.completeFn(this.llmConfig, systemPrompt, userPrompt);
        parsedResult = extractJson<Record<string, any>>(raw);
      } catch (err: unknown) {
        // LLM đã cấu hình nhưng hết cả chuỗi dự phòng (thường là hết hạn mức
        // 429) → không được bịa tiêu đề, xử lý ngay dưới đây.
        llmExhausted = true;
        getLogger().warn(
          `[llm] Không gọi được model nào, tạm bỏ tiêu đề: ${errorMessage(err).slice(0, 120)}`,
        );
      }
    }

    const fromLlm = parsedResult !== null;
    if (!parsedResult) {
      parsedResult = this.heuristicExtract(text);
      // heuristicExtract tự chế tiêu đề từ dòng đầi có "tả lỗi" — thực tế là tên
      // người, SĐT, mã học sinh, câu chào, nên đó là nội dung BỊA chứ không phải
      // tóm tắt lỗi. Khi LLM chết vì hết hạn mức, nó làm nhiễu hàng loạt ticket
      // (07/10/2026: TECH-1146 "Trần Thị B", TECH-1152 "Mức Cấp thiết").
      // Bỏ tiêu đề đi: pipeline rơi về nhãn trung tính, còn mô tả vẫn giữ
      // nguyên văn lời người báo nên không mất thông tin gì.
      if (llmExhausted) delete parsedResult.title;
    }

    // Lệnh sửa tờ khai tường minh luôn thắng — tất định, không phụ thuộc model
    const edit = parseEditCommand(text);

    let userIntent: Intent =
      pickEnum(parsedResult.userIntent, INTENTS) ?? this.heuristicIntent(text);
    if (edit && (userIntent === "report_issue" || userIntent === "chitchat"))
      userIntent = "provide_info";

    // Khi đã có ticket (opts.createdTicket):
    // - Nếu tin nhắn KHÔNG chứa từ chỉ lỗi/sự cố (chỉ là tên con, mã học sinh, mã đơn,
    //   chi tiết bổ sung...) thì đây là bổ sung thông tin cho ticket cũ (provide_info).
    // - Nếu tin nhắn có từ chỉ lỗi rõ ràng (PROBLEM_WORDS) hoặc nói rõ báo lỗi mới
    //   thì mới coi là sự cố mới (report_issue).
    if (opts.createdTicket && userIntent === "report_issue") {
      const describesNewProblem =
        PROBLEM_WORDS.test(text) ||
        /báo (?:thêm )?lỗi khác|sự cố (?:mới|khác)|ticket khác/i.test(text);
      if (!describesNewProblem) {
        userIntent = "provide_info";
      }
    }

    // Chuẩn hóa taxonomy & OOV
    const system = normalizeWithSynonyms(
      pickString(parsedResult.system),
      VALID_SYSTEMS,
      SYSTEM_SYNONYMS,
    );
    const deptCandidate = normalizeWithSynonyms(
      pickString(parsedResult.reportingDept),
      VALID_REPORTING_DEPTS,
      DEPT_SYNONYMS,
    );
    // Model hay tự đoán bộ phận khi tin nhắn không nói (M3 gán "Vận hành" cho mọi tin) —
    // chỉ nhận khi chính tin nhắn nhắc tới bộ phận đó.
    const reportingDept =
      deptCandidate && deptMentioned(text, deptCandidate) ? deptCandidate : undefined;
    // Người dùng nêu bộ phận ngoài danh mục (vd "Kế toán"): giữ nguyên tên để pipeline
    // hỏi lại ĐÚNG MỘT LẦN kèm danh sách, thay vì hỏi lại y nguyên câu cũ như chưa đọc.
    const reportingDeptUnrecognized = reportingDept
      ? undefined
      : detectUnrecognizedDept(text, deptCandidate);

    // Cưỡng chế quy tắc SĐT
    let customerId = pickString(parsedResult.customerId);
    let studentAccount = pickString(parsedResult.studentAccount);

    if (isVietnamesePhone(customerId)) {
      if (!studentAccount) studentAccount = customerId;
      customerId = undefined;
    }

    // Chỉ tin báo lỗi / bổ sung mới sinh triệu chứng. Câu xác nhận, huỷ, cảm ơn,
    // "không biết" hay lệnh sửa tờ khai mà ghi thành triệu chứng thì ticket ra
    // một mục "ok em" / "cảm ơn" nằm giữa mô tả lỗi.
    const carriesContent =
      (userIntent === "report_issue" || userIntent === "provide_info") &&
      !edit &&
      !isDeclineAnswer(text);
    let symptoms: string[] = [];
    if (carriesContent) {
      symptoms = Array.isArray(parsedResult.symptoms)
        ? parsedResult.symptoms
            .filter((s: unknown): s is string => typeof s === "string" && s.trim() !== "")
            .map((s: string) => s.trim())
        : [text];
    }

    const removeSymptoms = [
      ...(edit?.removeSymptoms ?? []),
      ...(Array.isArray(parsedResult.removeSymptoms)
        ? parsedResult.removeSymptoms.filter(
            (s: unknown): s is string => typeof s === "string" && s.trim() !== "",
          )
        : []),
    ];

    let title = edit?.title ?? (carriesContent ? pickString(parsedResult.title) : undefined);
    // Chốt chặn: KHÔNG BAO GIỜ chấp nhận tên học sinh hoặc mã định danh làm tiêu đề (TECH-1146)
    if (title && isInvalidTitle(title, text)) {
      title = deriveFallbackTitle(text, symptoms);
      if (isInvalidTitle(title)) title = undefined;
    }
    const titleExplicit =
      Boolean(edit?.title) || (fromLlm && parsedResult.titleExplicit === true && Boolean(title));
    // LLM không nói gì về bằng chứng thì dùng luật nhận diện bù — không có nó,
    // bảng luật sàn (cả lớp không vào học → Urgent) không bao giờ khớp.
    const inferred = carriesContent ? inferEvidence(text) : {};
    const llmScope = pickEnum(parsedResult.scope, [
      "single_user",
      "group",
      "entire_system",
    ] as const);

    const safeObj: ExtractedFields = {
      userIntent,
      title: title ? capText(title, 120) : undefined,
      titleExplicit: titleExplicit || undefined,
      symptoms,
      removeSymptoms: removeSymptoms.length > 0 ? removeSymptoms : undefined,
      product: pickEnum(parsedResult.product, VALID_PRODUCTS),
      system,
      errorCategory: pickEnum(parsedResult.errorCategory, VALID_ERROR_CATEGORIES),
      reportingDept,
      reportingDeptUnrecognized,
      deviceType: pickEnum(parsedResult.deviceType, VALID_DEVICE_TYPES),
      deviceOs: pickString(parsedResult.deviceOs),
      appVersion: pickString(parsedResult.appVersion),
      browser: pickString(parsedResult.browser),
      customerId,
      studentAccount,
      roomCode: pickString(parsedResult.roomCode),
      transactionId: pickString(parsedResult.transactionId),
      assignmentId: pickString(parsedResult.assignmentId),
      scope: llmScope ?? inferred.scope,
      // Cụm rõ ràng trong tin thắng cả false — model hay điền false mặc định cho mọi cờ.
      blocksPayment: inferred.blocksPayment || pickBool(parsedResult.blocksPayment),
      reconciliationMismatch: pickBool(parsedResult.reconciliationMismatch),
      blocksLearning: inferred.blocksLearning || pickBool(parsedResult.blocksLearning),
      dataLoss: pickBool(parsedResult.dataLoss),
      hasWorkaround: pickBool(parsedResult.hasWorkaround),
      singleDeviceOnly: pickBool(parsedResult.singleDeviceOnly),
      requestedPriority: pickEnum(parsedResult.requestedPriority, ["high", "urgent"] as const),
      requestedPriorityReason: pickString(parsedResult.requestedPriorityReason),
    };

    return extractedFieldsSchema.parse(safeObj);
  }

  /** Ý định suy tĩnh — thứ tự: xác nhận, huỷ, cảm ơn, từ chối trả lời, bổ sung, báo lỗi. */
  private heuristicIntent(text: string): Intent {
    if (isShortConfirmation(text)) return "confirm";
    if (isExplicitCancel(text)) return "cancel";
    if (isChitchat(text)) return "chitchat";
    if (isDeclineAnswer(text) || parseEditCommand(text)) return "provide_info";
    if (FOLLOW_UP_PREFIX.test(text)) return "provide_info";
    return "report_issue";
  }

  /**
   * Phương pháp bóc tách tĩnh dự phòng khi không có LLM
   */
  private heuristicExtract(text: string): Record<string, any> {
    let intent = this.heuristicIntent(text);

    const blockInfo = extractBlockInfo(text);
    const phoneMatch = text.match(PHONE_RE);
    const studentAccount = phoneMatch ? phoneMatch[0] : blockInfo.studentAccount;
    const customerId = blockInfo.customerId;
    const lower = text.toLowerCase();

    // Bóc tách nhanh taxonomy cơ bản bằng từ khóa
    let product: string | undefined;
    for (const p of VALID_PRODUCTS) {
      if (lower.includes(p.toLowerCase())) {
        product = p;
        break;
      }
    }

    let reportingDept: string | undefined = blockInfo.reportingDept;
    if (!reportingDept) {
      for (const d of VALID_REPORTING_DEPTS) {
        if (lower.includes(d.toLowerCase())) {
          reportingDept = d;
          break;
        }
      }
    }
    if (!reportingDept) {
      for (const [alias, target] of Object.entries(DEPT_SYNONYMS)) {
        if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${alias}(?:$|[^\\p{L}\\p{N}])`, "iu").test(lower)) {
          reportingDept = target;
          break;
        }
      }
    }
    const system = detectSystem(text);

    // Bóc tách thiết bị & OS nếu có
    let deviceType: string | undefined;
    if (/ipad|tablet|máy tính bảng/i.test(text)) deviceType = "Máy tính bảng";
    else if (/iphone|điện thoại|samsung|oppo|xiaomi/i.test(text)) deviceType = "Điện thoại";
    else if (/laptop/i.test(text)) deviceType = "Laptop";
    else if (/\bpc\b|máy tính/i.test(text)) deviceType = "PC";

    let deviceOs: string | undefined;
    const osMatch = text.match(/(?:ios|android|windows|macos)\s*\d*(?:\.\d+)?/i);
    if (osMatch) deviceOs = osMatch[0].trim();

    let assignmentId: string | undefined;
    const assMatch = text.match(/(?:bài tập|mã bài|kt-)\s*([A-Za-z0-9_-]+)/i);
    if (assMatch) assignmentId = assMatch[1];

    // Tin ngắn chỉ mang thông tin cấu trúc (phòng ban, SĐT, thiết bị…) mà không tả lỗi là bổ sung
    const hasStructured = Boolean(
      studentAccount ||
        reportingDept ||
        deviceType ||
        deviceOs ||
        assignmentId ||
        product ||
        system,
    );
    let structuredOnly = false;
    if (
      intent === "report_issue" &&
      text.length <= 80 &&
      hasStructured &&
      !PROBLEM_WORDS.test(text)
    ) {
      intent = "provide_info";
      structuredOnly = true;
    }

    const carriesContent =
      (intent === "report_issue" || intent === "provide_info") && !structuredOnly;
    // Tiêu đề dự phòng từ câu chữ: bỏ lời chào / giới thiệu bản thân để không ra
    // tiêu đề kiểu "Em chào anh, em là HueDT bên bộ phận Sale…" (đã xảy ra khi
    // LLM chết và fallback heuristic thay thế sinh tiêu đề).
    // Dòng đầu hay chỉ là tên học sinh / mã / SĐT (TECH-941, 952) → lấy dòng đầu tiên có tả lỗi.
    // Dòng đầu hay chỉ là tên học sinh / mã / SĐT (TECH-941, 952, TECH-1146) → không lấy làm tiêu đề.
    const lines = text
      .split("\n")
      .map((l) => stripGreeting(l.replace(/\*\*/g, "").trim()))
      .filter(Boolean);
    let titleCandidate = lines.find((l) => EXPANDED_PROBLEM_WORDS.test(l));
    if (titleCandidate && isInvalidTitle(titleCandidate, text)) {
      titleCandidate = undefined;
    }
    if (!titleCandidate && carriesContent) {
      const derived = deriveFallbackTitle(text, carriesContent ? [text] : []);
      if (!isInvalidTitle(derived)) titleCandidate = derived;
    }

    return {
      userIntent: intent,
      title:
        carriesContent && titleCandidate
          ? titleCandidate.length <= 80
            ? titleCandidate
            : titleCandidate.slice(0, 77) + "..."
          : undefined,
      symptoms: carriesContent ? [text] : [],
      product,
      system,
      reportingDept,
      customerId,
      studentAccount,
      deviceType,
      deviceOs,
      assignmentId,
    };
  }
}
