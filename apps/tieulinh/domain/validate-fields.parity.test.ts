import { describe, expect, test } from "bun:test";
import fieldRequirements from "./required_fields.json";
import productMapping from "./product_mapping.json";
import {
  VALID_ERROR_CATEGORIES,
  VALID_PRODUCTS,
  VALID_REPORTING_DEPTS,
  VALID_SYSTEMS,
} from "./taxonomy";
import {
  type FieldRequirementsTable,
  type ProductMappingConfig,
  type ValidateFieldsResult,
  type ValidationRules,
  validateFields,
  validateOne,
} from "./validate";
import validationRules from "./validation-rules.json";

function makeTool(dbPath?: string) {
  return validateFields(
    validationRules as unknown as ValidationRules,
    fieldRequirements as unknown as FieldRequirementsTable,
    productMapping as unknown as ProductMappingConfig,
    dbPath,
  );
}

describe("validate_fields parity tests", () => {
  test("heuristic student_account: phụ huynh/học sinh không có sđt", async () => {
    const resNoPhone = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Học sinh không vào được phòng học",
        urgency: "High",
        reporting_dept: "Vận hành",
      },
      rawText: "Học sinh không vào được phòng học",
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(resNoPhone.isComplete).toBe(false);
    expect(resNoPhone.missingRequired).toEqual(["student_account"]);
    expect(resNoPhone.consolidatedQuestion).toBe("Anh/chị bổ sung giúp em: tài khoản học sinh.");

    const resWithPhone = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Học sinh không vào được phòng học",
        urgency: "High",
        reporting_dept: "Vận hành",
      },
      rawText: "Học sinh 0900000008 không vào được phòng học",
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(resWithPhone.isComplete).toBe(true);
    expect(resWithPhone.missingRequired).toEqual([]);

    const resExhausted = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Học sinh không vào được phòng học",
        urgency: "High",
        reporting_dept: "Vận hành",
      },
      rawText: "Học sinh không vào được phòng học",
      askedCount: { student_account: 2 },
    })) as ValidateFieldsResult;

    expect(resExhausted.isComplete).toBe(true);
    expect(resExhausted.exhaustedFields).toEqual(["student_account"]);
  });

  test("bẫy #5: inferProductKey xét fallback_priority TRƯỚC mapping", async () => {
    const resFallback = (await makeTool().handler({
      values: {
        product: "Tutor",
        browser: "Chrome 120",
        system: "Web",
        short_description: "Lỗi giao diện web",
        urgency: "Medium",
        reporting_dept: "CSKH",
      },
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(resFallback.productKey).toBe("vuihoc-web");

    const resMapping = (await makeTool().handler({
      values: {
        product: "Tutor",
        system: "Gia sư",
        short_description: "Lỗi nộp bài",
        urgency: "Medium",
        reporting_dept: "CSKH",
      },
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(resMapping.productKey).toBe("tutor");
    expect(resMapping.missingSoft).toEqual([
      "device_type",
      "student_account",
      "assignment_id",
      "screenshot_url",
    ]);
  });

  describe("enum không lệch giữa validation-rules.json và taxonomy.ts", () => {
    test("mọi VALID_SYSTEMS đều hợp lệ qua validateOne('system', v)", () => {
      for (const v of VALID_SYSTEMS) {
        const r = validateOne(validationRules as unknown as ValidationRules, "system", v);
        expect(r).toEqual({
          value: v,
          field: "system",
          valid: true,
          normalized: v,
        });
      }
    });

    test("mọi VALID_PRODUCTS đều hợp lệ qua validateOne('product', v)", () => {
      for (const v of VALID_PRODUCTS) {
        const r = validateOne(validationRules as unknown as ValidationRules, "product", v);
        expect(r.valid).toBe(true);
      }
    });

    test("mọi VALID_REPORTING_DEPTS đều hợp lệ qua validateOne('reporting_dept', v)", () => {
      for (const v of VALID_REPORTING_DEPTS) {
        const r = validateOne(validationRules as unknown as ValidationRules, "reporting_dept", v);
        expect(r.valid).toBe(true);
      }
    });

    test("mọi VALID_ERROR_CATEGORIES đều hợp lệ qua validateOne('error_category', v)", () => {
      for (const v of VALID_ERROR_CATEGORIES) {
        const r = validateOne(validationRules as unknown as ValidationRules, "error_category", v);
        expect(r.valid).toBe(true);
      }
    });
  });
});
