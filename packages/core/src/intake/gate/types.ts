/**
 * Types for the data-driven field gate.
 *
 * The gate knows nothing about incidents, product briefs, or any other domain.
 * It is handed a normalized `FieldCatalog` and an `IntakeRecord`, and answers
 * one question: is there enough information yet, and if not, what to ask next.
 */

/** Which variant of the catalog applies. IRIS calls these "nhánh"; Tiểu Linh keys them by product. */
export type VariantKey = string;

export interface FieldSpec {
  /** Field name as it appears in the record and in the generated tool schema. */
  name: string;
  /** Always required for the variant to be considered complete. */
  required: boolean;
  /** Conditional requirement, e.g. `"muc_khan_cap in moc_gap"` — required only when the rule holds. */
  requiredIf?: string;
  /** `"text"`, `"enum:<catalogKey>"`, `"number"`, … */
  type: string;
  /** May the agent ask the user for this? Fields filled by the system are `false`. */
  canAsk: boolean;
  /** Ask once if still empty, but never block completion. */
  askOptional: boolean;
  /** Human label used in recap and questions. */
  label?: string;
  /** First-attempt question text. */
  prompt?: string;
  /** Follow-up phrasings for attempts 2..n. Their count sets the retry budget. */
  followUpPrompts?: string[];
  /** Value to assume once the retry budget is spent. */
  exhaustedDefault?: string;
  /** True when several enum values may be given at once. */
  isMultiValue: boolean;
  /** Derived from surrounding conversation rather than asked. */
  inferFromContext: boolean;
  /** Regex pattern for validating field values. */
  pattern?: string;
  /** Semantic rules for validating field values. */
  semantic?: {
    blacklist?: string[];
    whitelistPattern?: string;
    description?: string;
  };
}

export interface VariantSpec {
  key: VariantKey;
  /** Display name, e.g. "Order tính năng". */
  name: string;
  /** Fields specific to this variant, merged over the catalog's shared fields. */
  fields: Record<string, FieldSpec>;
  /** Field to open the conversation with. */
  openingField?: string;
  /** Ordered field names to print in the recap. */
  recapFields: string[];
  /** At least one of these must be resolved; they are not individually required. */
  oneOf?: string[];
  /**
   * A combined retry allowance across related fields, so the agent stops
   * circling a topic instead of spending each field's budget in turn.
   *
   * `countFields` are tallied together; when the tally reaches `max`, only
   * `exhaustFields` are retired. The two lists differ when one field should
   * keep its own budget while still contributing to the topic's total.
   */
  budgetGroups?: Array<{ countFields: string[]; exhaustFields: string[]; max: number }>;
  /** Status label to report, split by whether every required field resolved. */
  status: { complete: string; incomplete: string };
  /** Optional issue-type / label to stamp on the created issue. */
  outputType?: string;
}

/**
 * Trần cho `callbackData` của một nút bấm, tính bằng **byte UTF-8**.
 *
 * 64 là giới hạn cứng của Telegram Bot API. Vượt là `sendMessage` trả
 * `400 BUTTON_DATA_INVALID` và **cả tin nhắn không gửi được** — bot câm chứ
 * không phải mất nút. Đo thật 14/09/2026 lúc 10:10: giá trị
 * `"Không gấp, Product team có thể đánh giá theo quy trình thông thường"`
 * dài 81 byte, và mọi phiên nhánh 1 chết đúng ở câu hỏi mức khẩn cấp.
 *
 * Tiếng Việt có dấu tốn 2-3 byte mỗi chữ, nên đếm ký tự là đếm sai.
 */
export const MAX_CALLBACK_DATA_BYTES = 64;

/**
 * Cú pháp của `bat_buoc_neu` / `requiredIf`: `"<trường> <toán tử> <danh sách>"`.
 *
 * Ở đây chứ không ở `gate.ts`, vì `catalog.ts` cũng phải soi luật lúc dựng
 * catalog mà `gate.ts` lại import ngược `catalog.ts`.
 */
export const REQUIRED_IF_RULE = /^(\w+) (in|matches|not matches) (\w+)$/;

export interface FieldCatalog {
  /** Retry budget when a field declares no explicit follow-ups. */
  maxRetries: number;
  /** How many fields the agent may ask about in one turn. */
  maxQuestionsPerTurn: number;
  variants: Record<VariantKey, VariantSpec>;
  /** Closed vocabularies referenced by `type: "enum:<key>"`. */
  enums: Record<string, string[]>;
  /** Labels for fields the system fills in, used in recap. */
  autoLabels: Record<string, string>;
  /** Fields that must never be echoed back to the user. */
  recapBlocklist: string[];
  /** Emoji per enum value, for channels that render buttons. */
  icons: Record<string, string>;
  /** Extra normalization hints: enum value -> alternative spellings that map to it. */
  synonyms: Record<string, string[]>;
  /**
   * Nhãn nút ngắn cho những giá trị enum quá dài để làm `callbackData`.
   *
   * Giá trị chuẩn (dài, đầy đủ) vẫn là thứ ghi vào bản ghi và in ra recap;
   * nhãn ở đây chỉ thay mặt nó trên nút bấm. `createCatalog` tự đăng ký nhãn
   * này thành một synonym của giá trị chuẩn, nên đường về (người bấm nút ->
   * `normalizeValue`) không cần thêm cơ chế nào.
   */
  buttonLabels: Record<string, string>;
  /**
   * Có bắt giá trị phải hợp lệ (enum / regex / semantic) hay không.
   *
   * Mặc định **tắt**. Catalog của IRIS khai `kieu: "enum:..."` để render nút và
   * gợi ý lựa chọn, nhưng đường chạy thật chưa bao giờ ép giá trị phải nằm
   * trong danh sách — model vẫn điền văn xuôi vào trường enum, và gate chỉ
   * kiểm tra rỗng/không rỗng. Bật cờ này lên toàn cục sẽ khiến IRIS coi những
   * bản ghi đó là còn thiếu trường và hỏi vòng vô tận.
   *
   * Bảng luật của Tiểu Linh thì ngược lại — nó vốn luôn soi giá trị, nên
   * `catalogFromValidationRules` bật cờ này.
   */
  enforceValueRules: boolean;
}

export interface IntakeRecord {
  variant: VariantKey;
  /** Field name -> captured value. */
  values: Record<string, string>;
  /** Field name -> how many times it has been asked. */
  questionCount: Record<string, number>;
  /** Fields the user explicitly said they cannot answer. */
  explicitlyMissing: string[];
}

export interface FieldVerdict {
  field: string;
  value: string;
  valid: boolean;
  /** Giá trị đã chuẩn hoá về đúng chính tả trong bảng, khi khớp được. */
  normalized?: string;
  reason?: string;
  allowedValues?: string[];
  expectedPattern?: string;
}

export interface GateResult {
  /** True when every required field is resolved and the record may proceed to recap. */
  isComplete: boolean;
  /** True when completion was reached without falling back on any exhausted default. */
  isFullyResolved: boolean;
  status: string;
  /** Required fields still unresolved. */
  missingRequired: string[];
  /** Optional fields worth asking once. */
  missingRecommended: string[];
  /** Fields whose retry budget is spent. */
  exhaustedFields: string[];
  /** Fields chosen to ask about this turn. */
  fieldsToAsk: string[];
  /** Rendered question for this turn, empty when complete. */
  questionText: string;
  /** Things left unanswered that are worth recording for a human to follow up. */
  openQuestions: string[];
  /** Captured values plus defaults substituted for exhausted fields. */
  effectiveValues: Record<string, string>;
  /** Validation verdicts for captured values. */
  verdicts: FieldVerdict[];
  /** Names of fields with invalid values. */
  invalid: string[];
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export function createRecord(variant: VariantKey, values: Record<string, string> = {}): IntakeRecord {
  return { variant, values, questionCount: {}, explicitlyMissing: [] };
}
