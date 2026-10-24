import { z } from "zod";
import { openLazyDb } from "../../../lib/storage/lazy-db";
import { getLogger } from "@vuihoc/bot-core/core";
import { IdentityRepository } from "../../../lib/storage/identity-repository";
import {
  savePendingButtons,
  getDepartmentButtons,
  type DepartmentOption,
} from "../../../lib/telegram/buttons";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
import { createRecord, evaluateGate } from "@vuihoc/bot-core/intake";
import { validateValue } from "@vuihoc/bot-core/intake";
import {
  catalogFromValidationRules,
  FIELD_PROMPT_LABELS,
  NON_PROMPT_FIELDS,
  EXHAUSTED_DEFAULTS,
  type ValidationRule,
  type ValidationRules,
  type FieldRequirementsTable,
  type ProductMappingConfig,
} from "../../../lib/gate/from-validation-rules";
import type { FieldVerdict } from "@vuihoc/bot-core/intake";

export {
  FIELD_PROMPT_LABELS,
  NON_PROMPT_FIELDS,
  EXHAUSTED_DEFAULTS,
  type ValidationRule,
  type ValidationRules,
  type FieldRequirementsTable,
  type ProductMappingConfig,
  type FieldVerdict,
};

const rulesCatalogCache = new WeakMap<ValidationRules, any>();
function getCatalogForRules(rules: ValidationRules) {
  let cat = rulesCatalogCache.get(rules);
  if (!cat) {
    cat = catalogFromValidationRules(rules);
    rulesCatalogCache.set(rules, cat);
  }
  return cat;
}

export function validateOne(rules: ValidationRules, field: string, value: string): FieldVerdict {
  const catalog = getCatalogForRules(rules);
  return validateValue(catalog, field, value);
}

export function inferProductKey(
  record: Record<string, any>,
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

function departmentOptionsFromRules(rules: ValidationRules): DepartmentOption[] {
  const rule = rules.reporting_dept;
  if (!rule || typeof rule === "string" || rule.type !== "enum") return [];
  return rule.values.map((v) => ({ label: v, callbackData: v }));
}

export interface ValidateFieldsResult {
  /** True nếu tất cả giá trị truyền vào đều hợp lệ theo taxonomy & regex */
  allValid: boolean;
  /** True nếu tất cả trường bắt buộc đã có giá trị hợp lệ (hoặc đã rơi về giá trị mặc định khi hết ngân sách) */
  isComplete: boolean;
  /** Chi tiết thẩm định từng trường (kèm normalized value) */
  verdicts: FieldVerdict[];
  /** Danh sách các trường có giá trị không hợp lệ */
  invalid: string[];
  /** Phân loại sản phẩm nhận diện được */
  productKey: string;
  /** Các trường bắt buộc còn thiếu */
  missingRequired: string[];
  /** Các trường khuyến nghị nên có nhưng chưa có */
  missingSoft: string[];
  /** Nhãn tiếng Việt của các trường khuyến nghị */
  missingSoftLabels: string[];
  /** Các trường đã hỏi quá số lần ngân sách và nhận giá trị mặc định */
  exhaustedFields: string[];
  /** Câu hỏi gộp cho các trường bắt buộc còn thiếu */
  consolidatedQuestion?: string;
}

export function validateFields(
  rules: ValidationRules,
  fieldRequirements?: FieldRequirementsTable,
  productMapping?: ProductMappingConfig,
  dbPath?: string,
): AnyMcpTool {
  const fields = Object.keys(rules).filter((k) => !k.startsWith("_"));
  const departmentOptions = departmentOptionsFromRules(rules);
  const catalog = catalogFromValidationRules(rules, fieldRequirements, productMapping);

  return defineTool({
    name: "validate_fields",
    description:
      "Kiểm tra tính hợp lệ và đầy đủ của các trường thông tin sự cố theo taxonomy và quy chuẩn TMS VUIHOC. " +
      "BẮT BUỘC gọi trước khi tạo ticket để thẩm định dữ liệu. Khi thiếu thông tin bắt buộc, tool tự động đính nút bấm " +
      "chọn bộ phận trên Telegram và trả về danh sách trường cần bổ sung. Tuyệt đối không tự đoán mò bộ phận.",
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
        .describe(
          "Số lần đã hỏi từng trường bắt buộc còn thiếu, để tool biết khi nào nên thôi hỏi và dùng mặc định",
        ),
    },
    handler: ({
      values,
      reporterChatId,
      telegramUserId,
      rawText,
      askedCount,
    }): ValidateFieldsResult => {
      const currentValues: Record<string, string> = { ...values };
      const targetChatId = reporterChatId ?? telegramUserId;

      // 1. Nếu chưa có reporting_dept, kiểm tra xem đã lưu trong SQLite chưa
      if (!currentValues.reporting_dept && targetChatId && dbPath) {
        try {
          const db = openLazyDb(dbPath);
          const repo = new IdentityRepository(db);
          const ident = repo.getUserIdentity(String(targetChatId));
          if (ident?.department) {
            currentValues.reporting_dept = ident.department;
          }
        } catch (err) {
          getLogger().warn(`Không thể nạp department từ SQLite: ${err}`);
        }
      }

      // Nếu không có bảng cấu hình độ đầy đủ (chế độ soi thuần tuý)
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

      // 2. Suy productKey theo thứ tự ưu tiên (bẫy #5: fallback_priority trước mapping)
      const { key: productKey } = inferProductKey(currentValues, productMapping);

      // 3. Kiểm tra sự cố liên quan tài khoản / phòng học
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

      // 4. Chạy Gate
      const record = createRecord(variantKey, currentValues);
      if (askedCount && typeof askedCount === "object") {
        record.questionCount = { ...askedCount };
      }
      const gate = evaluateGate(catalog, record);

      // 5. Nếu có reporting_dept hợp lệ, lưu vào SQLite cho các lượt sau
      if (currentValues.reporting_dept && targetChatId && dbPath) {
        const bpVerdict = gate.verdicts.find((v) => v.field === "reporting_dept");
        if (bpVerdict?.valid) {
          try {
            const db = openLazyDb(dbPath);
            const repo = new IdentityRepository(db);
            repo.updateDepartment(
              String(targetChatId),
              bpVerdict.normalized ?? currentValues.reporting_dept,
            );
          } catch (err) {
            getLogger().warn(`Không thể lưu department vào SQLite: ${err}`);
          }
        }
      }

      const allValid = gate.invalid.length === 0;
      const missingRequired = gate.missingRequired;
      const missingSoft = gate.missingRecommended;
      const missingSoftLabels = missingSoft.map((f) => FIELD_PROMPT_LABELS[f] ?? f);
      const exhaustedFields = gate.exhaustedFields;
      const isComplete = allValid && missingRequired.length === 0;

      // 6. Nếu thiếu trường bắt buộc nghiêm trọng (như reporting_dept):
      if (!isComplete && missingRequired.length > 0) {
        if (missingRequired.includes("reporting_dept") && targetChatId) {
          savePendingButtons(targetChatId, getDepartmentButtons(departmentOptions));
        }

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

      // 7. Đã đủ thông tin bắt buộc
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
