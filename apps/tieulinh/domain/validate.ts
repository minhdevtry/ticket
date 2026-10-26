import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
import {
  catalogFromValidationRules,
  createRecord,
  evaluateGate,
  validateValue,
  type FieldCatalog,
  type FieldRequirementsTable,
  type FieldVerdict,
  type ValidationRule,
  type ValidationRules,
} from "@vuihoc/bot-core/intake";
import { z } from "zod";

export type { ValidationRule, ValidationRules, FieldRequirementsTable, FieldVerdict };

export interface ProductMappingConfig {
  mapping?: Array<{ product: string; product_key: string; rationale?: string }>;
  fallback_priority?: Array<{ if_has: string; product_key: string }>;
}

export const FIELD_PROMPT_LABELS: Record<string, string> = {
  product: "sản phẩm",
  system: "hệ thống",
  short_description: "mô tả ngắn",
  urgency: "mức ưu tiên",
  reporting_dept: "bộ phận của anh/chị",
  device_os: "hệ điều hành",
  device_type: "loại thiết bị (Điện thoại/Máy tính bảng/PC/Laptop)",
  app_version: "phiên bản app",
  browser: "trình duyệt",
  customer_id: "mã khách hàng",
  transaction_id: "mã giao dịch",
  student_account: "tài khoản học sinh",
  assignment_id: "mã bài tập",
  screenshot_url: "ảnh chụp màn hình",
};

export const NON_PROMPT_FIELDS = new Set(["urgency", "short_description", "product", "system"]);

export const EXHAUSTED_DEFAULTS: Record<string, string> = {
  reporting_dept: "Chưa xác định phòng ban",
  student_account: "Chưa xác định tài khoản/mã phòng",
};

export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  CSKH: ["cs", "cskh", "chăm sóc khách hàng", "customer care"],
  CSHV: ["cshv", "chăm sóc học viên"],
  "Vận hành": ["vh", "vận hành", "ops"],
  Sale: ["sales", "kinh doanh"],
  "Quản lý lớp": ["qll", "quản lý lớp"],
  "Chuyên môn": ["cm", "chuyên môn"],
  "Vận đơn": ["vd", "vận đơn"],
};

export function buildTieulinhCatalog(
  rules: ValidationRules,
  fieldRequirements?: FieldRequirementsTable,
): FieldCatalog {
  return catalogFromValidationRules(rules, fieldRequirements, {
    labels: FIELD_PROMPT_LABELS,
    promptBuilder: (_name, label) => `Anh/chị bổ sung giúp em: ${label}.`,
    variantName: (key, isAccount) =>
      key === "default"
        ? isAccount
          ? "Mặc định (sự cố tài khoản)"
          : "Mặc định"
        : isAccount
          ? `Sản phẩm ${key} (sự cố tài khoản)`
          : `Sản phẩm ${key}`,
    nonPromptFields: NON_PROMPT_FIELDS,
    exhaustedDefaults: EXHAUSTED_DEFAULTS,
    synonyms: DEFAULT_SYNONYMS,
    enforceValueRules: true,
  });
}

const rulesCatalogCache = new WeakMap<ValidationRules, FieldCatalog>();
export function getCatalogForRules(
  rules: ValidationRules,
  fieldRequirements?: FieldRequirementsTable,
): FieldCatalog {
  let cat = rulesCatalogCache.get(rules);
  if (!cat || fieldRequirements) {
    cat = buildTieulinhCatalog(rules, fieldRequirements);
    if (!fieldRequirements) {
      rulesCatalogCache.set(rules, cat);
    }
  }
  return cat;
}

export function validateOne(rules: ValidationRules, field: string, value: string): FieldVerdict {
  const catalog = getCatalogForRules(rules);
  return validateValue(catalog, field, value);
}

export function inferProductKey(
  record: Record<string, unknown>,
  mappingConfig?: ProductMappingConfig,
): { key: string; reason: string } {
  if (!mappingConfig) return { key: "default", reason: "no mapping config" };
  for (const rule of mappingConfig.fallback_priority ?? []) {
    if (rule.if_has && String(record[rule.if_has] ?? "").trim()) {
      return { key: rule.product_key ?? "default", reason: `bản ghi có ${rule.if_has}` };
    }
  }
  const productName = String(record.product ?? "").trim();
  for (const entry of mappingConfig.mapping ?? []) {
    if (entry.product === productName) {
      return { key: entry.product_key ?? "default", reason: `sản phẩm ${productName}` };
    }
  }
  return {
    key: "default",
    reason: productName ? `không khớp (product=${productName})` : "chưa có product",
  };
}

export interface ValidateFieldsResult {
  allValid: boolean;
  isComplete: boolean;
  verdicts: FieldVerdict[];
  invalid: string[];
  productKey: string;
  missingRequired: string[];
  missingSoft: string[];
  missingSoftLabels: string[];
  exhaustedFields: string[];
  consolidatedQuestion?: string;
}

export function validateFields(
  rules: ValidationRules,
  fieldRequirements?: FieldRequirementsTable,
  productMapping?: ProductMappingConfig,
  _dbPath?: string,
): AnyMcpTool {
  const fields = Object.keys(rules).filter((k) => !k.startsWith("_"));
  const catalog = buildTieulinhCatalog(rules, fieldRequirements);

  return defineTool({
    name: "validate_fields",
    description:
      "Kiểm tra tính hợp lệ và đầy đủ của các trường thông tin sự cố theo taxonomy và quy chuẩn TMS VUIHOC.",
    inputSchema: {
      values: z
        .record(z.string(), z.string())
        .describe(`Tên trường -> giá trị cần soi. Trường có luật: ${fields.join(", ")}`),
      reporterChatId: z.string().optional().describe("Chat ID Telegram của người báo sự cố"),
      telegramUserId: z.string().optional().describe("Telegram User ID nếu khác Chat ID"),
      rawText: z.string().optional().describe("Nội dung tin nhắn gốc từ người dùng"),
      askedCount: z
        .record(z.string(), z.number())
        .default({})
        .describe("Số lần đã hỏi từng trường bắt buộc còn thiếu"),
    },
    handler: (rawArgs: Record<string, unknown>): ValidateFieldsResult => {
      const values = (rawArgs.values ?? {}) as Record<string, string>;
      const rawText = rawArgs.rawText as string | undefined;
      const askedCount = (rawArgs.askedCount ?? {}) as Record<string, number>;
      const currentValues: Record<string, string> = { ...values };

      // Chế độ không có bảng ràng buộc
      if (!fieldRequirements) {
        const verdicts = Object.entries(currentValues).map(([field, value]) =>
          validateValue(catalog, field, String(value)),
        );
        const allValid = verdicts.every((v) => v.valid);
        const invalid = verdicts.filter((v) => !v.valid).map((v) => v.field);
        return {
          allValid,
          isComplete: allValid,
          verdicts,
          invalid,
          productKey: "default",
          missingRequired: [],
          missingSoft: [],
          missingSoftLabels: [],
          exhaustedFields: [],
        };
      }

      // Suy productKey
      const { key: productKey } = inferProductKey(currentValues, productMapping);

      const combinedDesc =
        `${rawText || ""} ${currentValues.description || ""} ${currentValues.short_description || ""}`.toLowerCase();
      const isAccountOrClassIssue =
        combinedDesc.includes("phụ huynh") ||
        combinedDesc.includes("học sinh") ||
        combinedDesc.includes("báo vắng") ||
        combinedDesc.includes("điểm danh") ||
        combinedDesc.includes("mất khóa") ||
        combinedDesc.includes("tài khoản") ||
        combinedDesc.includes("buổi học") ||
        combinedDesc.includes("crm");

      const hasPhoneOrAccount =
        Boolean(currentValues.student_account?.trim()) ||
        Boolean(currentValues.customer_id?.trim()) ||
        /(0\d{9,10}|\b\d{9,11}\b)/.test(combinedDesc);

      const isAccountIssue = isAccountOrClassIssue && !hasPhoneOrAccount;
      const variantKey = isAccountIssue ? `${productKey}+account` : productKey;

      const record = createRecord(variantKey, currentValues);
      if (askedCount && typeof askedCount === "object") {
        record.questionCount = { ...askedCount };
      }
      const gate = evaluateGate(catalog, record);

      const allValid = gate.invalid.length === 0;
      const missingRequired = gate.missingRequired;
      const missingSoft = gate.missingRecommended;
      const missingSoftLabels = missingSoft.map((f) => FIELD_PROMPT_LABELS[f] ?? f);
      const exhaustedFields = gate.exhaustedFields;
      const isComplete = allValid && missingRequired.length === 0;

      if (!isComplete && missingRequired.length > 0) {
        const hardLabels = missingRequired.map((f) => FIELD_PROMPT_LABELS[f] ?? f);
        const consolidatedQuestion = `Anh/chị bổ sung giúp em: ${hardLabels.join(", ")}.`;

        return {
          allValid,
          isComplete: false,
          verdicts: gate.verdicts,
          invalid: gate.invalid,
          productKey,
          missingRequired,
          missingSoft,
          missingSoftLabels,
          exhaustedFields,
          consolidatedQuestion,
        };
      }

      return {
        allValid,
        isComplete: true,
        verdicts: gate.verdicts,
        invalid: gate.invalid,
        productKey,
        missingRequired: [],
        missingSoft,
        missingSoftLabels,
        exhaustedFields,
      };
    },
  });
}
