/**
 * Adapter converting legacy validation rules, required fields table,
 * and product mapping into a unified FieldCatalog.
 *
 * Used by Tiểu Linh in Phase 1 to migrate to lib/gate without rewriting JSON.
 */
import { assertCatalogIntegrity } from "./catalog";
import type {
  FieldCatalog,
  FieldSpec,
  VariantKey,
  VariantSpec,
} from "./types";

export type ValidationRule =
  | { type: "regex"; pattern: string; description?: string }
  | { type: "enum"; values: string[]; description?: string }
  | { type: "semantic"; blacklist?: string[]; whitelist_pattern?: string; description?: string };

export type ValidationRules = Record<string, ValidationRule | string>;

export interface FieldRequirementsTable {
  [key: string]: {
    bat_buoc?: string[];
    nen_hoi?: string[];
  };
}

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

export function catalogFromValidationRules(
  rules: ValidationRules,
  fieldRequirements?: FieldRequirementsTable,
  _productMapping?: ProductMappingConfig,
): FieldCatalog {
  // 1. Collect enums
  const enums: Record<string, string[]> = {};
  for (const [name, rule] of Object.entries(rules)) {
    if (typeof rule === "object" && rule.type === "enum" && Array.isArray(rule.values)) {
      enums[name] = rule.values;
    }
  }

  // 2. Identify all known field names across rules, labels, and requirements
  const allFieldNames = new Set<string>([
    ...Object.keys(rules).filter((k) => !k.startsWith("_")),
    ...Object.keys(FIELD_PROMPT_LABELS),
  ]);

  if (fieldRequirements) {
    for (const req of Object.values(fieldRequirements)) {
      for (const f of req.bat_buoc ?? []) allFieldNames.add(f);
      for (const f of req.nen_hoi ?? []) allFieldNames.add(f);
    }
  }

  // 3. Build variants
  const variantKeys = fieldRequirements
    ? Object.keys(fieldRequirements)
    : ["default"];

  if (!variantKeys.includes("default")) {
    variantKeys.push("default");
  }

  const buildFieldsForVariant = (
    batBuocList: string[],
    nenHoiList: string[],
    extraRequiredList: string[] = [],
  ): Record<string, FieldSpec> => {
    const batBuocSet = new Set([...batBuocList, ...extraRequiredList]);
    const nenHoiSet = new Set(nenHoiList.filter((f) => !batBuocSet.has(f)));

    const orderedFieldNames: string[] = [];
    const seen = new Set<string>();
    for (const f of [...batBuocList, ...extraRequiredList, ...nenHoiList, ...allFieldNames]) {
      if (!seen.has(f)) {
        seen.add(f);
        orderedFieldNames.push(f);
      }
    }

    const fields: Record<string, FieldSpec> = {};
    for (const name of orderedFieldNames) {
      const rule = rules[name];
      const isEnum = typeof rule === "object" && rule.type === "enum";
      const isRegex = typeof rule === "object" && rule.type === "regex";
      const isSemantic = typeof rule === "object" && rule.type === "semantic";

      const canAsk = !NON_PROMPT_FIELDS.has(name);
      const isRequired = batBuocSet.has(name);
      const isAskOptional = nenHoiSet.has(name);
      const label = FIELD_PROMPT_LABELS[name] ?? name;
      const prompt = `Anh/chị bổ sung giúp em: ${label}.`;

      fields[name] = {
        name,
        required: isRequired,
        type: isEnum ? `enum:${name}` : "text",
        canAsk,
        askOptional: isAskOptional,
        label,
        prompt,
        // Trap #1: followUpPrompts with length 1 ensures retry budget is 1 + 1 = 2
        followUpPrompts: canAsk ? [prompt] : undefined,
        exhaustedDefault: EXHAUSTED_DEFAULTS[name],
        isMultiValue: false,
        inferFromContext: false,
        pattern: isRegex ? rule.pattern : undefined,
        semantic: isSemantic
          ? {
              blacklist: rule.blacklist,
              whitelistPattern: rule.whitelist_pattern,
              description: rule.description,
            }
          : undefined,
      };
    }
    return fields;
  };

  const variants: Record<VariantKey, VariantSpec> = {};

  for (const vKey of variantKeys) {
    const req = fieldRequirements?.[vKey] ?? { bat_buoc: [], nen_hoi: [] };
    const batBuocList = req.bat_buoc ?? [];
    const nenHoiList = req.nen_hoi ?? [];

    // Base variant
    variants[vKey] = {
      key: vKey,
      name: `Sản phẩm ${vKey}`,
      fields: buildFieldsForVariant(batBuocList, nenHoiList),
      recapFields: [],
      status: {
        complete: "Qualified",
        incomplete: "Need Clarification",
      },
    };

    // Paired variant with student_account required for account/class issues (heuristic)
    const accountVariantKey = `${vKey}+account`;
    variants[accountVariantKey] = {
      key: accountVariantKey,
      name: `Sản phẩm ${vKey} (sự cố tài khoản)`,
      fields: buildFieldsForVariant(batBuocList, nenHoiList, ["student_account"]),
      recapFields: [],
      status: {
        complete: "Qualified",
        incomplete: "Need Clarification",
      },
    };
  }

  const catalog: FieldCatalog = {
    maxRetries: 2,
    maxQuestionsPerTurn: 1,
    variants,
    enums,
    autoLabels: {},
    recapBlocklist: [],
    icons: {},
    // Tiểu Linh chưa vẽ nút từ catalog này, nên chưa có giá trị nào cần nhãn ngắn.
    buttonLabels: {},
    synonyms: DEFAULT_SYNONYMS,
    // Bảng luật của Tiểu Linh sinh ra để soi giá trị — đó là cả mục đích của nó.
    enforceValueRules: true,
  };

  assertCatalogIntegrity(catalog);
  return catalog;
}
