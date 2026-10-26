import { describe, expect, test } from "bun:test";
import {
  catalogFromValidationRules,
  type ValidationRules,
  type FieldRequirementsTable,
} from "./from-validation-rules";
import { validateValue } from "./validate";

describe("catalogFromValidationRules", () => {
  const sampleRules: ValidationRules = {
    system: {
      type: "enum",
      values: ["CRM", "LMS", "LiveClass"],
      description: "Danh sách hệ thống",
    },
    device_type: {
      type: "enum",
      values: ["Điện thoại", "Máy tính bảng", "PC"],
    },
    room_code: {
      type: "regex",
      pattern: "^ROOM-\\d+$",
    },
    notes: {
      type: "semantic",
      blacklist: ["test", "na"],
      whitelist_pattern: "^[A-Za-z0-9 ]+$",
    },
  };

  const sampleReqs: FieldRequirementsTable = {
    web: {
      bat_buoc: ["system"],
      nen_hoi: ["room_code"],
    },
  };

  test("tạo catalog hợp lệ từ rules và requirements", () => {
    const catalog = catalogFromValidationRules(sampleRules, sampleReqs, {
      labels: {
        system: "hệ thống",
        room_code: "mã phòng",
      },
      synonyms: {
        CRM: ["crm", "customer relationship"],
      },
      enforceValueRules: true,
    });

    expect(catalog.enforceValueRules).toBe(true);
    expect(catalog.enums.system).toEqual(["CRM", "LMS", "LiveClass"]);
    expect(catalog.enums.device_type).toEqual(["Điện thoại", "Máy tính bảng", "PC"]);
    expect(catalog.synonyms.CRM).toContain("crm");

    const webVariant = catalog.variants.web;
    expect(webVariant).toBeDefined();
    expect(webVariant.fields.system.required).toBe(true);
    expect(webVariant.fields.room_code.askOptional).toBe(true);
    expect(webVariant.fields.room_code.pattern).toBe("^ROOM-\\d+$");

    // Paired variant
    const paired = catalog.variants["web+account"];
    expect(paired).toBeDefined();
    expect(paired.fields.student_account.required).toBe(true);
  });

  test("thẩm định giá trị với catalog sinh ra", () => {
    const catalog = catalogFromValidationRules(sampleRules, sampleReqs, {
      synonyms: {
        CRM: ["crm"],
      },
    });

    const v1 = validateValue(catalog, "system", "crm");
    expect(v1.valid).toBe(true);
    expect(v1.normalized).toBe("CRM");

    const v2 = validateValue(catalog, "room_code", "ROOM-123");
    expect(v2.valid).toBe(true);

    const v3 = validateValue(catalog, "room_code", "INVALID");
    expect(v3.valid).toBe(false);
  });
});
