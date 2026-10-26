/**
 * Pure Vietnamese heuristics for receptionist extraction (RFC 0002 §1.5 E2-E4, A14).
 *
 * All functions here are deterministic and model-free:
 * - Intent heuristics: short confirmation, explicit cancel, decline, chitchat (E3)
 * - Evidence inference: inferEvidence (E4)
 * - Synonym normalization & department mentions (E2)
 * - Fallback title derivation & invalid title guards (E2 / TECH-1146)
 * - Explicit edit commands (A14)
 */

import {
  DEPT_SYNONYMS,
  GENERIC_SYSTEM_KEYS,
  SYSTEM_SYNONYMS,
  VALID_REPORTING_DEPTS,
  VALID_SYSTEMS,
} from "./taxonomy";

export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function tokenize(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function foldVietnamese(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

export function isVietnamesePhone(val?: string | null): boolean {
  if (!val) return false;
  return /^(?:\+84|0)[35789]\d{8}$/.test(val.replace(/[\s.-]+/g, ""));
}

const CONFIRM_CORE: Record<string, true> = {
  ok: true,
  oke: true,
  okay: true,
  okie: true,
  oki: true,
  đúng: true,
  chuẩn: true,
  xác: true,
  tạo: true,
  gửi: true,
  đồng: true,
  yes: true,
  y: true,
  được: true,
  chính: true,
};

const CONFIRM_WORDS: Record<string, true> = {
  ...CONFIRM_CORE,
  nhận: true,
  ý: true,
  rồi: true,
  đi: true,
  luôn: true,
  giúp: true,
  em: true,
  chị: true,
  anh: true,
  mình: true,
  nhé: true,
  nha: true,
  ạ: true,
  dạ: true,
  vâng: true,
  ticket: true,
  vé: true,
  cho: true,
  với: true,
  vậy: true,
  thế: true,
  là: true,
  e: true,
  c: true,
  a: true,
};

/**
 * Short confirmation: whole message contains only agreement words and particles.
 */
export function isShortConfirmation(text: string): boolean {
  if (!text || text.length > 60) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0 || tokens.length > 8) return false;
  return (
    tokens.every((t) => CONFIRM_WORDS[t] === true) && tokens.some((t) => CONFIRM_CORE[t] === true)
  );
}

const CANCEL_WORDS: Record<string, true> = {
  hủy: true,
  huỷ: true,
  cancel: true,
  dừng: true,
  bỏ: true,
  qua: true,
  thôi: true,
  không: true,
  cần: true,
  đi: true,
  nhé: true,
  nha: true,
  ạ: true,
  giúp: true,
  em: true,
  chị: true,
  anh: true,
  mình: true,
  ticket: true,
  vé: true,
  yêu: true,
  cầu: true,
  này: true,
  luôn: true,
  tạo: true,
  nữa: true,
  đâu: true,
  rồi: true,
  dạ: true,
  vâng: true,
  cho: true,
  với: true,
  báo: true,
  cáo: true,
  lại: true,
  e: true,
  c: true,
  a: true,
};

/**
 * Explicit cancel: whole message is a cancellation sentence ("hủy", "thôi không cần nữa", "bỏ qua").
 * "không vào được lớp..." is NOT a cancel.
 */
export function isExplicitCancel(text: string): boolean {
  if (!text || text.length > 60) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0 || !tokens.every((t) => CANCEL_WORDS[t] === true)) return false;
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

const DECLINE_WORDS: Record<string, true> = {
  không: true,
  ko: true,
  k: true,
  hông: true,
  chưa: true,
  biết: true,
  rõ: true,
  có: true,
  nhớ: true,
  dạ: true,
  em: true,
  chị: true,
  anh: true,
  mình: true,
  ạ: true,
  nhé: true,
  nha: true,
  luôn: true,
  thông: true,
  tin: true,
  cái: true,
  này: true,
  đâu: true,
  rồi: true,
  cũng: true,
  e: true,
  c: true,
  a: true,
  thì: true,
  chịu: true,
};

/**
 * User explicitly states they don't have the answer to a question ("không biết", "em không rõ ạ", "chưa có").
 */
export function isDeclineAnswer(text: string): boolean {
  if (!text || text.length > 40) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0 || !tokens.every((t) => DECLINE_WORDS[t] === true)) return false;
  if (tokens.includes("chịu")) return true;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (
      /^(?:không|ko|k|hông|chưa)$/.test(tokens[i] ?? "") &&
      /^(?:biết|rõ|có|nhớ)$/.test(tokens[i + 1] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

const CHITCHAT_CORE: Record<string, true> = {
  cảm: true,
  cám: true,
  thanks: true,
  thank: true,
  tks: true,
  thx: true,
  chào: true,
  hi: true,
  hello: true,
};

const CHITCHAT_WORDS: Record<string, true> = {
  ...CHITCHAT_CORE,
  ơn: true,
  you: true,
  ok: true,
  oke: true,
  vâng: true,
  dạ: true,
  em: true,
  chị: true,
  anh: true,
  bạn: true,
  nhé: true,
  nha: true,
  ạ: true,
  nhiều: true,
  rất: true,
  bot: true,
  linh: true,
  tiểu: true,
  mình: true,
  ạh: true,
  luôn: true,
  nhá: true,
  e: true,
  c: true,
  a: true,
  much: true,
  so: true,
};

/**
 * Chitchat / pure greeting / gratitude without incident info.
 */
export function isChitchat(text: string): boolean {
  if (!text || text.length > 60) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0) return true;
  if (!tokens.every((t) => CHITCHAT_WORDS[t] === true)) return false;
  return (
    tokens.some((t) => CHITCHAT_CORE[t] === true) ||
    tokens.every((t) => t === "dạ" || t === "vâng" || t === "ạ")
  );
}

const TITLE_EDIT =
  /^(?:(?:em|chị|anh|mình|cho em|nhờ em)\s+)?(?:sửa|đổi|thay)\s+(?:lại\s+)?tiêu\s*đề\s*(?:thành|là|sang)?\s*[:\-–]?\s*["“'«]?(.+?)["”'»]?\s*$/iu;
const SYMPTOM_REMOVE =
  /^(?:(?:em|chị|anh|mình)\s+)?(?:bỏ|xoá|xóa|gỡ)\s+(?:ý|triệu\s*chứng|dòng|phần)\s*(?:là|:)?\s*["“'«]?(.+?)["”'»]?\s*$/iu;

/**
 * Explicit edit command ("sửa tiêu đề thành …", "bỏ ý …") — deterministic, no LLM needed (A14).
 */
export function parseEditCommand(
  text: string,
): { title?: string; removeSymptoms?: string[] } | null {
  const trimmed = text.trim();
  const t = TITLE_EDIT.exec(trimmed);
  if (t?.[1]?.trim()) return { title: capText(t[1].trim(), 120) };
  const r = SYMPTOM_REMOVE.exec(trimmed);
  if (r?.[1]?.trim()) return { removeSymptoms: [r[1].trim()] };
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
 * Infer system from text: standard names first, then synonyms ordered longest first.
 */
export function detectSystem(
  text: string,
  synonyms: Record<string, string> = SYSTEM_SYNONYMS,
  validSystems: readonly string[] = VALID_SYSTEMS,
): string | undefined {
  const lower = text.toLowerCase();
  for (const s of validSystems) {
    if (lower.includes(s.toLowerCase())) return s;
  }
  const entries = Object.entries(synonyms)
    .filter(([k]) => GENERIC_SYSTEM_KEYS[k] !== true)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [k, v] of entries) {
    if (
      new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(k)}(?:$|[^\\p{L}\\p{N}])`, "u").test(lower)
    ) {
      return v;
    }
  }
  return undefined;
}

/**
 * Checks if the text explicitly mentions department `dept` (name without diacritics or synonym alias).
 */
export function deptMentioned(
  text: string,
  dept: string,
  synonyms: Record<string, string> = DEPT_SYNONYMS,
): boolean {
  const folded = foldVietnamese(text);
  if (folded.includes(foldVietnamese(dept))) return true;
  return Object.entries(synonyms).some(
    ([alias, target]) =>
      target === dept &&
      new RegExp(`(^|[^a-z0-9])${foldVietnamese(alias)}([^a-z0-9]|$)`).test(folded),
  );
}

const DEPT_PREFIX_WORDS = "bộ phận|bophan|bên|phòng|khối|đội";
const DEPT_MENTION_RE = new RegExp(
  `(?:${DEPT_PREFIX_WORDS})\\s+([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ\\s]{0,30}?)` +
    `(?=[,.;!?]|$|\\s+(?:ạ|nhé|nha|ah|à|đang|đã|bị|không|cần|báo|mong|gặp)(?=$|[^A-Za-zÀ-ỹ0-9])|\\s+(?:${DEPT_PREFIX_WORDS})(?=$|[^A-Za-zÀ-ỹ0-9]))`,
  "iu",
);

/**
 * Department mentioned by reporter but not in the closed taxonomy.
 */
export function detectUnrecognizedDept(
  text: string,
  matchedDept?: string,
  validDepts: readonly string[] = VALID_REPORTING_DEPTS,
  synonyms: Record<string, string> = DEPT_SYNONYMS,
): string | undefined {
  if (matchedDept) return undefined;
  const m = DEPT_MENTION_RE.exec(text);
  if (!m?.[1]) return undefined;
  const name = m[1]
    .replace(new RegExp(`^(?:${DEPT_PREFIX_WORDS})\\s+`, "iu"), "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return undefined;
  const foldedName = foldVietnamese(name);
  const known = [
    ...validDepts.map((d) => foldVietnamese(d)),
    ...Object.keys(synonyms).map((a) => foldVietnamese(a)),
  ];
  if (known.some((k) => foldedName === k || foldedName.includes(k))) return undefined;
  return capText(name, 60);
}

const GREETING_PREFIX_RE =
  /^\s*(?:(?:em|chị|anh|con|tôi|mình)\s+(?:chào\s+(?:anh|chị|em|ad|mọi người)[^,.!]*[,.;]!?|là\s+\S+(?:\s+(?:bên|thuộc)\s+bộ phận[^,.!]*)?[,.;]!?|chào\s+anh[^,.!]*[,.;]!?))\s*/iu;

/**
 * Strips greeting prefixes from title candidates ("Em chào anh, em là HueDT...").
 */
export function stripGreeting(line: string): string {
  let out = line;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(GREETING_PREFIX_RE, "");
    if (next === out) break;
    out = next;
  }
  return out.trim() || line.trim();
}

const BLOCKS_LEARNING_RE =
  /không\s+(?:vào|tham gia|học|mở)\s*(?:được)?\s*(?:vào\s*)?(?:lớp|phòng học|buổi học|bài học|học)|chưa\s+(?:được\s+)?xếp lớp|không có khoá|khoá (?:học )?không active/i;
const GROUP_SCOPE_RE =
  /cả lớp|nhiều (?:học sinh|hs|bạn|phụ huynh|lớp)|\b\d{2,}\s*(?:học sinh|hs|bạn|phụ huynh)|tất cả học sinh|hàng loạt/i;
const SYSTEM_SCOPE_RE =
  /toàn (?:bộ )?hệ thống|toàn bộ (?:người dùng|học sinh)|hệ thống (?:sập|chết)|tất cả mọi người/i;
const BLOCKS_PAYMENT_RE =
  /không\s+(?:thể\s+)?thanh toán|thanh toán\s+(?:bị\s+)?(?:lỗi|không được)|không\s+(?:tạo|lên|lập|chốt)\s+(?:được\s+)?đơn/i;

/**
 * Priority evidence heuristics: compensates when LLM is silent (E4).
 */
export function inferEvidence(text: string): {
  scope?: "single_user" | "group" | "entire_system";
  blocksLearning?: boolean;
  blocksPayment?: boolean;
} {
  const out: {
    scope?: "single_user" | "group" | "entire_system";
    blocksLearning?: boolean;
    blocksPayment?: boolean;
  } = {};
  if (BLOCKS_LEARNING_RE.test(text)) out.blocksLearning = true;
  if (BLOCKS_PAYMENT_RE.test(text)) out.blocksPayment = true;
  if (SYSTEM_SCOPE_RE.test(text)) out.scope = "entire_system";
  else if (GROUP_SCOPE_RE.test(text)) out.scope = "group";
  else if (out.blocksLearning || out.blocksPayment) out.scope = "single_user";
  return out;
}

export const VIETNAMESE_FAMILY_NAMES: Record<string, true> = {
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

export const EXPANDED_PROBLEM_WORDS =
  /(?:lỗi|không|ko\b|bị|sập|treo|đơ|hỏng|error|mất|chậm|văng|sai|lệch|thiếu|nhầm|chưa|lỡ|đang hiện|đang hiển thị|đúng phải là|sửa lại|không vào được|không hiện|không thấy)/iu;

export const PROBLEM_WORDS = /(?:lỗi|không|ko\b|bị|sập|treo|hỏng|error|mất|chậm|văng)/iu;

const POLITE_OR_GREETING_PREFIXES =
  /^(?:em chào|chào|alo|nhờ tech|nhờ anh chị|nhờ ad|hỗ trợ em với|cho em hỏi|ad ơi|check giúp|e cảm ơn)\b/iu;

const UPPERCASE_START = /^\p{Lu}/u;

const BARE_PRIORITY_RE =
  /^(?:mức\s*độ\s*(?:cao|trung\s*bình|thấp)|cao|trung\s*bình|thấp|gấp|khẩn\s*cấp|urgent|high|medium|low)$/iu;

const normalizeLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*#\\]/g, "")
    .replace(/[_\s]+/g, "")
    .trim();

const TAXONOMY_LABELS: Record<string, true> = Object.fromEntries(
  [...VALID_REPORTING_DEPTS, ...VALID_SYSTEMS].map((v) => [normalizeLabel(v), true as const]),
);

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

export function isPersonNameOnly(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  const cleaned = text
    .replace(/[*_#\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;
  if (EXPANDED_PROBLEM_WORDS.test(cleaned) || /[\d:=]/.test(cleaned)) return false;
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  const firstWord = words[0]?.toLowerCase() ?? "";
  if (VIETNAMESE_FAMILY_NAMES[firstWord] !== true) return false;
  return words.every((w) => UPPERCASE_START.test(w));
}

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

export function isInvalidTitle(title: string | null | undefined, reportText?: string): boolean {
  if (!title || typeof title !== "string") return true;
  const trimmed = title
    .replace(/[*_#\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length < 4) return true;
  if (/^\d+$/.test(trimmed)) return true;
  if (
    /^(?:code|mã\s*(?:kh|khách\s*hàng|học\s*sinh|hs|lớp|đơn|crm)|cid|uid|sid|sđt|phone)\s*[:=]?\s*[\w-]+$/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (isBareAnswerLabel(trimmed)) return true;
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

function isBareIdentifierBlock(block: string): boolean {
  return residualProse(block).length === 0;
}

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
    const rawClean = line
      .replace(/^\s*(?:\d+[.)]\s+)?[\s*=>•\-#]+/, "")
      .replace(/[*_#\\]/g, "")
      .trim();
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
      return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 77)}...`;
    }
  }

  if (studentNames && studentNames.length > 1) {
    return `Sự cố của ${studentNames.length} học sinh (${studentNames.join(", ")})`;
  }
  if (studentNames && studentNames.length === 1 && studentNames[0]) {
    return `Sự cố học sinh ${studentNames[0]}`;
  }

  return "";
}

const CUSTOMER_CODE_RE =
  /(?:^|[^\p{L}\p{N}_?&=/.-])(?:code|mã\s*(?:kh|khách\s*hàng|crm)|cid)(?:\s*[:=]\s*|\s+)([A-Za-z]{0,4}\d{4,12})/iu;
const STUDENT_CODE_RE =
  /(?:^|[^\p{L}\p{N}_?&=/.-])(?:mã\s*(?:học\s*sinh|hs)|uid|sid)(?:\s*[:=]\s*|\s+)([A-Za-z]{0,4}\d{3,12})/iu;
const STANDALONE_CRM_LINE_RE = /^(\d{7,10})$/;
const MOBILE_PHONE_RE = /(?<![\p{L}\p{N}])(?:\+?84|0)[35789]\d{8}(?![\p{L}\p{N}])/u;
const LABELLED_PHONE_RE =
  /(?:sđt|số\s*điện\s*thoại|điện\s*thoại|phone)\s*(?:[:=]\s*|\s+)[^\d\n]{0,20}?((?:\+?84|0)[35789]\d{8})/iu;
const LOGIN_FRAGMENT_RE = /\b(?:tk|mk|tài\s*khoản|mật\s*khẩu)\s*[:=]?\s*[^\s,;()]{1,25}/giu;

export interface LabelledIdentifiers {
  customer?: string;
  student?: string;
  phone?: string;
}

export function extractLabelledIdentifiers(
  text: string | undefined,
  options: { allowBarePhone?: boolean } = {},
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
      if (m?.[1] && !m[1].startsWith("0")) {
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
    const raw = lines[i] ?? "";
    const l = raw.replace(/\*\*/g, "").trim();

    if (/quản\s*lý\s*lớp|\bqll\b|bộ\s*phận\s*qll/i.test(l)) {
      reportingDept = reportingDept ?? "Quản lý lớp";
    }

    const nameMatch = raw.match(/^\*\*([^*]+)\*\*$/);
    if (nameMatch?.[1] && !studentName && isPersonNameOnly(nameMatch[1])) {
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
