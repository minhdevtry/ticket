import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  validateFields,
  validateOne,
  type ValidationRules,
  type FieldRequirementsTable,
  type ProductMappingConfig,
} from "./validate-fields";
import { IdentityRepository } from "../../../lib/storage/identity-repository";
import { applySchema } from "../../../lib/storage/schema";
import validationRules from "../../tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../tieulinh/domain/required_fields.json";
import productMapping from "../../tieulinh/domain/product_mapping.json";
import {
  VALID_SYSTEMS,
  VALID_PRODUCTS,
  VALID_REPORTING_DEPTS,
  VALID_ERROR_CATEGORIES,
} from "../../tieulinh/domain/taxonomy";

function makeTool(dbPath?: string) {
  return validateFields(
    validationRules as ValidationRules,
    fieldRequirements as FieldRequirementsTable,
    productMapping as ProductMappingConfig,
    dbPath,
  );
}

describe("validate_fields parity tests (pre & post refactor safety net)", () => {
  test("shape 1: chế độ thuần không có fieldRequirements", async () => {
    const pureTool = validateFields(validationRules as ValidationRules);
    const res = (await pureTool.handler({
      values: {
        product: "Tự học",
        urgency: "High",
        device_os: "Android 14",
      },
      askedCount: {},
    })) as any;

    expect(res).toEqual({
      allValid: true,
      isComplete: true,
      verdicts: [
        { field: "product", value: "Tự học", valid: true, normalized: "Tự học" },
        { field: "urgency", value: "High", valid: true, normalized: "High" },
        { field: "device_os", value: "Android 14", valid: true, normalized: "Android 14" },
      ],
      invalid: [],
      productKey: "default",
      missingRequired: [],
      missingSoft: [],
      missingSoftLabels: [],
      exhaustedFields: [],
    });
  });

  test("shape 2: thiếu reporting_dept -> chưa complete, có consolidatedQuestion", async () => {
    const res = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "VH_Tự học",
        short_description: "Không vào được bài học",
        urgency: "Urgent",
      },
      askedCount: {},
    })) as any;

    expect(res.allValid).toBe(true);
    expect(res.isComplete).toBe(false);
    expect(res.productKey).toBe("vuihoc-mobile-app");
    expect(res.missingRequired).toEqual(["reporting_dept"]);
    expect(res.exhaustedFields).toEqual([]);
    expect(res.consolidatedQuestion).toBe("Anh/chị bổ sung giúp em: bộ phận của anh/chị.");
  });

  test("shape 3: đủ trường bắt buộc -> complete", async () => {
    const res = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "VH_Tự học",
        short_description: "Không vào được bài học",
        urgency: "Urgent",
        reporting_dept: "CSKH",
      },
      askedCount: {},
    })) as any;

    expect(res.allValid).toBe(true);
    expect(res.isComplete).toBe(true);
    expect(res.productKey).toBe("vuihoc-mobile-app");
    expect(res.missingRequired).toEqual([]);
    expect(res.missingSoft).toEqual(["device_os", "app_version"]);
    expect(res.missingSoftLabels).toEqual(["hệ điều hành", "phiên bản app"]);
    expect(res.exhaustedFields).toEqual([]);
  });

  test("sai enum: chuẩn hoá và bắt lỗi enum", async () => {
    const res = (await makeTool().handler({
      values: {
        product: "tự học", // lowercase -> should normalize to "Tự học"
        urgency: "Khẩn Cấp", // not in allowed
        reporting_dept: "cskh", // lowercase -> normalize to "CSKH"
      },
      askedCount: {},
    })) as any;

    expect(res.allValid).toBe(false);
    expect(res.invalid).toEqual(["urgency"]);
    const urgencyVerdict = res.verdicts.find((v: any) => v.field === "urgency");
    expect(urgencyVerdict.valid).toBe(false);
    expect(urgencyVerdict.reason).toBe("Không nằm trong danh sách cho phép");
    expect(urgencyVerdict.allowedValues).toEqual(["Urgent", "High", "Medium", "Low"]);

    const productVerdict = res.verdicts.find((v: any) => v.field === "product");
    expect(productVerdict.valid).toBe(true);
    expect(productVerdict.normalized).toBe("Tự học");

    const deptVerdict = res.verdicts.find((v: any) => v.field === "reporting_dept");
    expect(deptVerdict.valid).toBe(true);
    expect(deptVerdict.normalized).toBe("CSKH");
  });

  test("sai regex và rác semantic", async () => {
    const res = (await makeTool().handler({
      values: {
        subject_code: "invalid_code",
        device_os: "test", // in blacklist
      },
      askedCount: {},
    })) as any;

    expect(res.allValid).toBe(false);
    expect(res.invalid).toContain("subject_code");
    expect(res.invalid).toContain("device_os");

    const subjectVerdict = res.verdicts.find((v: any) => v.field === "subject_code");
    expect(subjectVerdict.valid).toBe(false);
    expect(subjectVerdict.reason).toBe("Sai định dạng");
    expect(subjectVerdict.expectedPattern).toBe("^[A-Z]+[0-9]+$|^[0-9]{6,}$");

    const osVerdict = res.verdicts.find((v: any) => v.field === "device_os");
    expect(osVerdict.valid).toBe(false);
    expect(osVerdict.reason).toBe("Giá trị rác, không mang thông tin");
  });

  test("whitelist semantic: không nhận diện được", async () => {
    const res = (await makeTool().handler({
      values: {
        device_os: "Solaris 10", // not in blacklist, but fails whitelist pattern
      },
      askedCount: {},
    })) as any;

    const osVerdict = res.verdicts.find((v: any) => v.field === "device_os");
    expect(osVerdict.valid).toBe(false);
    expect(osVerdict.reason).toBe("Không nhận ra giá trị này");
    expect(osVerdict.expectedPattern).toBe(
      "(Laptop|PC|Windows|Mac|Android|iOS|iPadOS|iPad|Linux|Chrome OS)",
    );
  });

  test("budget: askedCount 1 tiếp tục hỏi, askedCount 2 rơi về default", async () => {
    // askedCount = 1
    const res1 = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Lỗi bài học",
        urgency: "Low",
      },
      askedCount: { reporting_dept: 1 },
    })) as any;
    expect(res1.isComplete).toBe(false);
    expect(res1.missingRequired).toEqual(["reporting_dept"]);
    expect(res1.exhaustedFields).toEqual([]);

    // askedCount = 2 -> rơi về EXHAUSTED_DEFAULTS: "Chưa xác định phòng ban"
    const res2 = (await makeTool().handler({
      values: {
        product: "Tự học",
        system: "App",
        short_description: "Lỗi bài học",
        urgency: "Low",
      },
      askedCount: { reporting_dept: 2 },
    })) as any;
    expect(res2.isComplete).toBe(true);
    expect(res2.missingRequired).toEqual([]);
    expect(res2.exhaustedFields).toEqual(["reporting_dept"]);
  });

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
    })) as any;

    expect(resNoPhone.isComplete).toBe(false);
    expect(resNoPhone.missingRequired).toEqual(["student_account"]);
    expect(resNoPhone.consolidatedQuestion).toBe("Anh/chị bổ sung giúp em: tài khoản học sinh.");

    // Khi đã có số điện thoại trong rawText
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
    })) as any;

    expect(resWithPhone.isComplete).toBe(true);
    expect(resWithPhone.missingRequired).toEqual([]);

    // Khi student_account đã được hỏi 2 lần -> rơi về default
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
    })) as any;

    expect(resExhausted.isComplete).toBe(true);
    expect(resExhausted.exhaustedFields).toEqual(["student_account"]);
  });

  test("bẫy #5: inferProductKey xét fallback_priority TRƯỚC mapping", async () => {
    // product: "Tutor" mapping sang "tutor", nhưng nếu có "browser" thì fallback_priority xét trước -> "vuihoc-web"
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
    })) as any;

    expect(resFallback.productKey).toBe("vuihoc-web");

    // Nếu không có field trong fallback_priority -> lấy theo mapping -> "tutor"
    const resMapping = (await makeTool().handler({
      values: {
        product: "Tutor",
        system: "Gia sư",
        short_description: "Lỗi nộp bài",
        urgency: "Medium",
        reporting_dept: "CSKH",
      },
      askedCount: {},
    })) as any;

    expect(resMapping.productKey).toBe("tutor");
    expect(resMapping.missingSoft).toEqual([
      "device_type",
      "student_account",
      "assignment_id",
      "screenshot_url",
    ]);
  });

  test("SQLite persistence: đọc reporting_dept đã lưu & ghi nhận khi có reporting_dept hợp lệ", async () => {
    const tempDbPath = `/tmp/test-validate-fields-parity-${Date.now()}.db`;
    const tempDb = new Database(tempDbPath);
    applySchema(tempDb);
    const tempRepo = new IdentityRepository(tempDb);
    tempRepo.saveUserIdentity({
      telegramUserId: "chat123",
      nameCode: "user_123",
      department: "Vận hành",
    });
    tempRepo.saveUserIdentity({
      telegramUserId: "chat456",
      nameCode: "user_456",
    });
    tempDb.close();

    try {
      const toolWithFileDb = validateFields(
        validationRules as ValidationRules,
        fieldRequirements as FieldRequirementsTable,
        productMapping as ProductMappingConfig,
        tempDbPath,
      );

      const resLoad = (await toolWithFileDb.handler({
        values: {
          product: "Tự học",
          system: "App",
          short_description: "Lỗi app",
          urgency: "Low",
        },
        reporterChatId: "chat123",
        askedCount: {},
      })) as any;

      expect(resLoad.isComplete).toBe(true);
      const deptVerdict = resLoad.verdicts.find((v: any) => v.field === "reporting_dept");
      expect(deptVerdict.valid).toBe(true);
      expect(deptVerdict.normalized).toBe("Vận hành");

      // Lần 2: User mới chưa có dept -> truyền dept mới -> ghi vào DB
      const resSave = (await toolWithFileDb.handler({
        values: {
          product: "Tự học",
          system: "App",
          short_description: "Lỗi app",
          urgency: "Low",
          reporting_dept: "CSKH",
        },
        reporterChatId: "chat456",
        askedCount: {},
      })) as any;

      expect(resSave.isComplete).toBe(true);
      const verifyDb = new Database(tempDbPath);
      const verifyRepo = new IdentityRepository(verifyDb);
      const savedUser = verifyRepo.getUserIdentity("chat456");
      expect(savedUser?.department).toBe("CSKH");
      verifyDb.close();
    } finally {
      try {
        const fs = await import("node:fs");
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  });

  // Ràng hai nguồn enum với nhau — đây là chỗ lệch tồn tại lâu (15 nhãn cũ
  // vẫn sống trong validation-rules.json đến 2026-09-23, 9 nhãn mới đã có trong
  // taxonomy.ts). Bất kỳ giá trị nào trong các mảng canonical không hợp lệ khi
  // chạy qua validation-rules.json → test này đỏ, fix ngay tại nguồn.
  describe("enum không lệch giữa validation-rules.json và taxonomy.ts", () => {
    test("mọi VALID_SYSTEMS đều hợp lệ qua validateOne('system', v)", () => {
      for (const v of VALID_SYSTEMS) {
        const r = validateOne(validationRules as ValidationRules, "system", v);
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
        const r = validateOne(validationRules as ValidationRules, "product", v);
        expect(r.valid).toBe(true);
      }
    });
    test("mọi VALID_REPORTING_DEPTS đều hợp lệ qua validateOne('reporting_dept', v)", () => {
      for (const v of VALID_REPORTING_DEPTS) {
        const r = validateOne(validationRules as ValidationRules, "reporting_dept", v);
        expect(r.valid).toBe(true);
      }
    });
    test("mọi VALID_ERROR_CATEGORIES đều hợp lệ qua validateOne('error_category', v)", () => {
      for (const v of VALID_ERROR_CATEGORIES) {
        const r = validateOne(validationRules as ValidationRules, "error_category", v);
        expect(r.valid).toBe(true);
      }
    });
  });
});
