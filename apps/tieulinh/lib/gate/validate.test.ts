import { describe, expect, test } from "bun:test";
import { createCatalog } from "./catalog";
import { evaluateGate } from "./gate";
import { createRecord, type FieldCatalog } from "./types";
import { validateValue } from "./validate";

const testCatalog: FieldCatalog = createCatalog({
  fields: {
    _soi_gia_tri: true,
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      "1": {
        ten: "Nhánh test",
        truong: {
          phong_ban: {
            bat_buoc: true,
            kieu: "enum:phong_ban",
            nhan: "Phòng ban",
            hoi: "Bạn thuộc phòng ban nào?",
          },
          ma_so: {
            bat_buoc: true,
            kieu: "text",
            dinh_dang: "^[A-Z]{2}[0-9]{4}$",
            nhan: "Mã số",
          },
          thiet_bi: {
            bat_buoc: false,
            kieu: "text",
            ngu_nghia: {
              chan: ["test", "na", "n/a", "."],
              mau_nhan_dien: "(PC|Laptop|Mac|Android|iOS)",
            },
            nhan: "Thiết bị",
          },
          khong_luat: {
            bat_buoc: false,
            kieu: "text",
            nhan: "Không luật",
          },
        },
      },
    },
  },
  enums: {
    phong_ban: ["Vận hành", "CSKH", "Công nghệ"],
  },
  synonyms: {
    CSKH: ["cs", "chăm sóc khách hàng"],
  },
});

describe("validateValue", () => {
  test("enum: chuẩn hoá đúng chính tả và hỗ trợ synonyms, unit prefix, NFC", () => {
    const v1 = validateValue(testCatalog, "phong_ban", "vận hành");
    expect(v1.valid).toBe(true);
    expect(v1.normalized).toBe("Vận hành");

    // Unit prefix "bên CSKH"
    const v2 = validateValue(testCatalog, "phong_ban", "bên cskh");
    expect(v2.valid).toBe(true);
    expect(v2.normalized).toBe("CSKH");

    // Synonym "chăm sóc khách hàng"
    const v3 = validateValue(testCatalog, "phong_ban", "chăm sóc khách hàng");
    expect(v3.valid).toBe(true);
    expect(v3.normalized).toBe("CSKH");

    // Sai enum
    const v4 = validateValue(testCatalog, "phong_ban", "Phòng Kinh Doanh");
    expect(v4.valid).toBe(false);
    expect(v4.reason).toBe("Không nằm trong danh sách cho phép");
    expect(v4.allowedValues).toEqual(["Vận hành", "CSKH", "Công nghệ"]);
  });

  test("regex: kiểm tra mẫu định dạng", () => {
    const vOk = validateValue(testCatalog, "ma_so", "AB1234");
    expect(vOk.valid).toBe(true);
    expect(vOk.normalized).toBe("AB1234");

    const vBad = validateValue(testCatalog, "ma_so", "abc1234");
    expect(vBad.valid).toBe(false);
    expect(vBad.reason).toBe("Sai định dạng");
    expect(vBad.expectedPattern).toBe("^[A-Z]{2}[0-9]{4}$");
  });

  test("semantic: chặn blacklist và yêu cầu whitelist pattern", () => {
    const vBadBlacklist = validateValue(testCatalog, "thiet_bi", "test");
    expect(vBadBlacklist.valid).toBe(false);
    expect(vBadBlacklist.reason).toBe("Giá trị rác, không mang thông tin");

    const vBadWhitelist = validateValue(testCatalog, "thiet_bi", "Máy giặt");
    expect(vBadWhitelist.valid).toBe(false);
    expect(vBadWhitelist.reason).toBe("Không nhận ra giá trị này");
    expect(vBadWhitelist.expectedPattern).toBe("(PC|Laptop|Mac|Android|iOS)");

    const vOk = validateValue(testCatalog, "thiet_bi", "Laptop Dell");
    expect(vOk.valid).toBe(true);
    expect(vOk.normalized).toBe("Laptop Dell");
  });

  test("trường không có luật thì cho qua", () => {
    const v = validateValue(testCatalog, "khong_luat", "bất kỳ giá trị nào");
    expect(v.valid).toBe(true);
    expect(v.reason).toBe("Không có luật cho trường này");
  });

  test("trường có luật mà để trống thì báo lỗi", () => {
    const v = validateValue(testCatalog, "phong_ban", "   ");
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("Để trống");
  });

  test("evaluateGate: trường có giá trị sai luật không vào resolved/finalized và lọt vào invalid", () => {
    const record = createRecord("1", {
      phong_ban: "Phòng Không Hợp Lệ",
      ma_so: "AB1234",
    });
    const res = evaluateGate(testCatalog, record);

    expect(res.isComplete).toBe(false);
    expect(res.invalid).toContain("phong_ban");
    expect(res.missingRequired).toContain("phong_ban");
    expect(res.verdicts.find((v) => v.field === "phong_ban")?.valid).toBe(false);
  });
});

/**
 * Chốt chặn hồi quy cho một lỗi đã thực sự xảy ra.
 *
 * Khi mới gộp hai hệ gating, `evaluateGate` soi giá trị cho MỌI catalog. Catalog
 * của IRIS khai `kieu: "enum:..."` để render nút, nhưng đường chạy thật chưa bao
 * giờ ép giá trị phải nằm trong danh sách — model vẫn điền văn xuôi vào trường
 * enum. Bật soi toàn cục khiến IRIS coi bản ghi đã đủ thông tin là còn thiếu, và
 * bot hỏi vòng vô tận. Script Tầng 1 rơi từ 90/0 xuống 86/4.
 */
describe("soi giá trị là tuỳ chọn của từng catalog", () => {
  const authored = {
    fields: {
      _toi_da_hoi_lai: 2,
      _toi_da_truong_moi_luot: 1,
      nhanh: {
        "1": {
          ten: "Nhánh test",
          truong: {
            phong_ban: {
              bat_buoc: true,
              kieu: "enum:phong_ban",
              nhan: "Phòng ban",
              hoi: "Bạn thuộc phòng ban nào?",
            },
          },
        },
      },
    },
    enums: { phong_ban: ["Vận hành", "CSKH"] },
  };

  test("mặc định TẮT: văn xuôi trong trường enum vẫn tính là đã trả lời", () => {
    const catalog = createCatalog(authored as any);
    expect(catalog.enforceValueRules).toBe(false);

    const res = evaluateGate(
      catalog,
      createRecord("1", { phong_ban: "20 nhân sự giáo vụ toàn quốc" }),
    );

    expect(res.isComplete).toBe(true);
    expect(res.missingRequired).toEqual([]);
    expect(res.invalid).toEqual([]);
  });

  test("khai `_soi_gia_tri: true` thì mới bắt lỗi giá trị", () => {
    const catalog = createCatalog({
      ...authored,
      fields: { ...authored.fields, _soi_gia_tri: true },
    } as any);
    expect(catalog.enforceValueRules).toBe(true);

    const res = evaluateGate(
      catalog,
      createRecord("1", { phong_ban: "20 nhân sự giáo vụ toàn quốc" }),
    );

    expect(res.isComplete).toBe(false);
    expect(res.invalid).toContain("phong_ban");
  });
});
