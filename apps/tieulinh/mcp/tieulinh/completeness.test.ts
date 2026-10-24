import { describe, expect, test } from "bun:test";
import { validateFields, type ValidationRules, type FieldRequirementsTable, type ProductMappingConfig } from "../shared/index";
import validationRules from "./domain/validation-rules.json";
import fieldRequirements from "./domain/required_fields.json";
import productMapping from "./domain/product_mapping.json";

/**
 * Trước 12/09/2026, `fieldRequirements`/`productMapping` được import trong
 * `index.ts` nhưng KHÔNG hề truyền vào `validateFields()` — toàn bộ nhánh
 * tính đủ/thiếu dưới đây chưa từng chạy trong production, và cũng chưa từng
 * có test. Bộ test này khoá lại đúng hành vi sau khi bật lên.
 */
function tool(dbPath?: string) {
  return validateFields(
    validationRules as ValidationRules,
    fieldRequirements as FieldRequirementsTable,
    productMapping as ProductMappingConfig,
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
    })) as any;

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
    })) as any;

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
    })) as any;

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
    })) as any;

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
    })) as any;

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
    })) as any;

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
    })) as any;

    expect(res.productKey).toBe("tutor");
    expect(res.missingSoft).toContain("screenshot_url");
  });
});
