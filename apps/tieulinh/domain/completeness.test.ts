import { describe, expect, test } from "bun:test";
import fieldRequirements from "./required_fields.json";
import productMapping from "./product_mapping.json";
import {
  type FieldRequirementsTable,
  type ProductMappingConfig,
  type ValidateFieldsResult,
  type ValidationRules,
  validateFields,
} from "./validate";
import validationRules from "./validation-rules.json";

function tool(dbPath?: string) {
  return validateFields(
    validationRules as unknown as ValidationRules,
    fieldRequirements as unknown as FieldRequirementsTable,
    productMapping as unknown as ProductMappingConfig,
    dbPath,
  );
}

describe("validate_fields — tính đủ/thiếu (bật từ 12/09/2026)", () => {
  test("thiếu reporting_dept thì chưa đủ và đính nút bộ phận", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Không mở được bài giảng",
        urgency: "Medium",
      },
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(res.isComplete).toBe(false);
    expect(res.missingRequired).toContain("reporting_dept");
    expect(res.consolidatedQuestion).toContain("bộ phận");
  });

  test("có đủ reporting_dept thì hoàn tất", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Không mở được bài giảng",
        urgency: "Medium",
        reporting_dept: "CS",
      },
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(res.isComplete).toBe(true);
  });

  test("hỏi reporting_dept quá 2 lần mà vẫn trống thì dùng mặc định, không hỏi mãi", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Không mở được bài giảng",
        urgency: "Medium",
      },
      askedCount: { reporting_dept: 2 },
    })) as ValidateFieldsResult;

    expect(res.isComplete).toBe(true);
    expect(res.exhaustedFields).toContain("reporting_dept");
  });

  test("chưa hết ngân sách (mới hỏi 1 lần) thì vẫn tiếp tục hỏi, chưa dùng mặc định", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Không mở được bài giảng",
        urgency: "Medium",
      },
      askedCount: { reporting_dept: 1 },
    })) as ValidateFieldsResult;

    expect(res.isComplete).toBe(false);
    expect(res.missingRequired).toContain("reporting_dept");
  });

  test("sự cố liên quan tài khoản/phụ huynh mà không có số điện thoại hay mã thì đòi thêm student_account", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Phụ huynh báo tài khoản không đăng nhập được",
        urgency: "Medium",
        reporting_dept: "CS",
      },
      rawText: "Phụ huynh báo tài khoản không đăng nhập được",
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(res.isComplete).toBe(false);
    expect(res.missingRequired).toContain("student_account");
  });

  test("có số điện thoại trong lời kể thì không đòi thêm student_account nữa", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Phụ huynh báo tài khoản không đăng nhập được",
        urgency: "Medium",
        reporting_dept: "CS",
      },
      rawText: "Phụ huynh 0900000005 báo tài khoản không đăng nhập được",
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(res.isComplete).toBe(true);
  });

  test("suy đúng product_key từ tên sản phẩm để chọn bộ trường nen_hoi phù hợp", async () => {
    const res = (await tool().handler({
      values: {
        product: "Tutor",
        system: "Gia sư",
        short_description: "Học sinh không nộp được bài tập",
        urgency: "Medium",
        reporting_dept: "CS",
      },
      askedCount: {},
    })) as ValidateFieldsResult;

    expect(res.productKey).toBe("tutor");
    expect(res.missingSoft).toContain("screenshot_url");
  });
});
