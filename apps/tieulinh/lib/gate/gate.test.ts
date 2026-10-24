import { describe, expect, test } from "bun:test";
import { createCatalog, type CatalogInput } from "./catalog";
import { evaluateGate } from "./gate";
import { createRecord, type FieldCatalog } from "./types";

/**
 * A small catalog exercising every rule the gate implements, so a failure points
 * at one behaviour rather than at IRIS's full field table.
 */
const rawCatalog: CatalogInput = {
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    _nhan_tu_sinh: { nhom: "Nhóm" },
    cam_in_trong_recap: { truong: ["ghi_chu_noi_bo"] },
    chung: {
      nguoi_gui: { bat_buoc: true, kieu: "text", duoc_hoi: false, nhan: "Người gửi" },
      tieu_de: { bat_buoc: true, kieu: "text", duoc_hoi: false, nhan: "Tiêu đề" },
    },
    nhanh: {
      "1": {
        ten: "Nhánh chính",
        truong_mo_dau: "van_de",
        recap: ["tieu_de", "nhom", "van_de", "he_thong", "ghi_chu_noi_bo"],
        mot_trong: { truong: ["tan_suat", "quy_mo"] },
        nhom_ngan_sach_hoi: [
          { dem: ["van_de", "nguoi_anh_huong"], het: ["van_de", "nguoi_anh_huong"], toi_da: 3 },
        ],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Vấn đề",
            hoi: "Vấn đề cụ thể là gì ạ?",
            hoi_lai: ["Anh/chị mô tả rõ hơn giúp em nhé?"],
          },
          nguoi_anh_huong: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Người ảnh hưởng",
            hoi: "Việc này ảnh hưởng tới ai ạ?",
            het_luot: "Chưa xác định",
          },
          he_thong: {
            bat_buoc: true,
            kieu: "enum:he_thong",
            duoc_hoi: true,
            nhan: "Hệ thống",
            hoi: "Thuộc hệ thống nào ạ?",
          },
          muc_khan_cap: {
            bat_buoc: false,
            kieu: "enum:muc_khan_cap",
            duoc_hoi: true,
            nhan: "Mức khẩn cấp",
          },
          ly_do_gap: {
            bat_buoc_neu: "muc_khan_cap in muc_gap",
            kieu: "text",
            duoc_hoi: true,
            nhan: "Lý do gấp",
            hoi: "Vì sao cần gấp ạ?",
          },
          tan_suat: {
            kieu: "text",
            duoc_hoi: true,
            nhan: "Tần suất",
            hoi: "Gặp thường xuyên không ạ?",
          },
          quy_mo: { kieu: "text", duoc_hoi: true, nhan: "Quy mô", hoi: "Bao nhiêu người gặp ạ?" },
          ghi_chu_noi_bo: { kieu: "text", duoc_hoi: false, nhan: "Ghi chú nội bộ" },
        },
      },
    },
  },
  enums: {
    he_thong: ["App/web Vuihoc", "CRM"],
    muc_khan_cap: ["Không gấp", "Rất khẩn cấp"],
    muc_gap: ["Rất khẩn cấp"],
    trang_thai: { "1": { du: "Qualified", thieu: "Need Clarification" } },
    loai_dau_ra: { "1": "Feature request" },
  },
};

const catalog: FieldCatalog = createCatalog(rawCatalog);

function record(
  values: Record<string, string>,
  extra: Partial<ReturnType<typeof createRecord>> = {},
) {
  return { ...createRecord("1", values), ...extra };
}

describe("evaluateGate", () => {
  test("asks the opening question when nothing has been captured", () => {
    const gate = evaluateGate(catalog, record({}));

    expect(gate.isComplete).toBe(false);
    expect(gate.fieldsToAsk).toEqual(["van_de"]);
    expect(gate.questionText).toContain("Vấn đề cụ thể là gì ạ?");
    expect(gate.status).toBe("Need Clarification");
  });

  test("asks one field per turn even when several are missing", () => {
    const gate = evaluateGate(catalog, record({}));
    expect(gate.missingRequired.length).toBeGreaterThan(1);
    expect(gate.fieldsToAsk).toHaveLength(1);
  });

  test("appends the vocabulary to enum questions so the user can pick", () => {
    const gate = evaluateGate(catalog, record({ van_de: "x", nguoi_anh_huong: "GV" }));
    expect(gate.fieldsToAsk).toEqual(["he_thong"]);
    expect(gate.questionText).toContain("chọn một: App/web Vuihoc · CRM");
  });

  test("escalates to the follow-up phrasing once a field has been asked", () => {
    const gate = evaluateGate(catalog, record({}, { questionCount: { van_de: 1 } }));
    expect(gate.questionText).toContain("mô tả rõ hơn");
  });

  test("completes once every required field and one of the oneOf group is present", () => {
    const gate = evaluateGate(
      catalog,
      record({
        van_de: "Không xuất được báo cáo",
        nguoi_anh_huong: "Giáo viên",
        he_thong: "CRM",
        tan_suat: "Hàng ngày",
      }),
    );

    expect(gate.isComplete).toBe(true);
    expect(gate.isFullyResolved).toBe(true);
    expect(gate.status).toBe("Qualified");
    expect(gate.questionText).toBe("");
  });

  test("does not chase the rest of the oneOf group once one member is answered", () => {
    const gate = evaluateGate(
      catalog,
      record({ van_de: "a", nguoi_anh_huong: "b", he_thong: "CRM", quy_mo: "20 lớp" }),
    );
    expect(gate.missingRequired).toEqual([]);
    expect(gate.fieldsToAsk).toEqual([]);
  });

  test("asks for one oneOf member while none is answered", () => {
    const gate = evaluateGate(
      catalog,
      record({ van_de: "a", nguoi_anh_huong: "b", he_thong: "CRM" }),
    );
    expect(gate.fieldsToAsk).toEqual(["tan_suat"]);
  });

  test("giving up on the whole oneOf group completes, but does not claim to be resolved", () => {
    const gate = evaluateGate(
      catalog,
      record(
        { van_de: "a", nguoi_anh_huong: "b", he_thong: "CRM" },
        {
          explicitlyMissing: ["tan_suat", "quy_mo"],
        },
      ),
    );

    // Settled and resolved are different things. The gate must stop asking, or
    // the bot loops forever on a question the user already declined. But
    // neither field declares a fallback, so the record really is missing both,
    // and the status has to say so rather than reading "Qualified".
    expect(gate.isComplete).toBe(true);
    expect(gate.questionText).toBe("");
    expect(gate.isFullyResolved).toBe(false);
    expect(gate.status).toBe("Need Clarification");
    expect(gate.openQuestions).toContain("Chưa có Tần suất, Quy mô");
    expect(gate.exhaustedFields).toContain("tan_suat");
    expect(gate.exhaustedFields).toContain("quy_mo");
  });

  test("a declared fallback is a real answer, so the group is resolved", () => {
    // The same conversation on IRIS's catalog, where every oneOf member has an
    // `het_luot`: giving up leaves a usable value, so nothing is left open.
    const withDefaults = createCatalog({
      ...rawCatalog,
      fields: {
        ...rawCatalog.fields,
        nhanh: {
          "1": {
            ...rawCatalog.fields.nhanh!["1"],
            truong: {
              ...rawCatalog.fields.nhanh!["1"].truong,
              tan_suat: { ...rawCatalog.fields.nhanh!["1"].truong!.tan_suat, het_luot: "Chưa rõ" },
              quy_mo: { ...rawCatalog.fields.nhanh!["1"].truong!.quy_mo, het_luot: "Chưa rõ" },
            },
          },
        },
      },
    });

    const gate = evaluateGate(
      withDefaults,
      record(
        { van_de: "a", nguoi_anh_huong: "b", he_thong: "CRM" },
        {
          explicitlyMissing: ["tan_suat", "quy_mo"],
        },
      ),
    );

    expect(gate.isFullyResolved).toBe(true);
    expect(gate.openQuestions).toEqual([]);
    expect(gate.effectiveValues.tan_suat).toBe("Chưa rõ");
  });

  test("substitutes the declared default once a field's retry budget is spent", () => {
    const gate = evaluateGate(
      catalog,
      record(
        { van_de: "a", he_thong: "CRM", tan_suat: "Hàng ngày" },
        {
          questionCount: { nguoi_anh_huong: 1 },
        },
      ),
    );

    expect(gate.exhaustedFields).toContain("nguoi_anh_huong");
    expect(gate.effectiveValues.nguoi_anh_huong).toBe("Chưa xác định");
    expect(gate.isComplete).toBe(true);
    expect(gate.isFullyResolved).toBe(true);
  });

  test("treats a field the user cannot answer as settled", () => {
    const gate = evaluateGate(
      catalog,
      record(
        { van_de: "a", he_thong: "CRM", tan_suat: "Hàng ngày" },
        {
          explicitlyMissing: ["nguoi_anh_huong"],
        },
      ),
    );
    expect(gate.isComplete).toBe(true);
    expect(gate.missingRequired).toEqual([]);
  });

  test("stops circling a topic once the shared budget is spent", () => {
    // Two questions on van_de plus one on nguoi_anh_huong reaches the group's max of 3.
    const gate = evaluateGate(
      catalog,
      record(
        { he_thong: "CRM", tan_suat: "Hàng ngày" },
        {
          questionCount: { van_de: 2, nguoi_anh_huong: 1 },
        },
      ),
    );

    expect(gate.exhaustedFields).toContain("van_de");
    expect(gate.exhaustedFields).toContain("nguoi_anh_huong");
    expect(gate.fieldsToAsk).toEqual([]);
  });

  test("keeps asking while the shared budget still has room", () => {
    const gate = evaluateGate(
      catalog,
      record(
        { he_thong: "CRM", tan_suat: "Hàng ngày" },
        {
          questionCount: { van_de: 1 },
        },
      ),
    );
    expect(gate.fieldsToAsk).toEqual(["van_de"]);
  });

  test("conditional field stays optional until its condition holds", () => {
    const base = { van_de: "a", nguoi_anh_huong: "b", he_thong: "CRM", tan_suat: "Hàng ngày" };

    const relaxed = evaluateGate(catalog, record({ ...base, muc_khan_cap: "Không gấp" }));
    expect(relaxed.isComplete).toBe(true);

    const urgent = evaluateGate(catalog, record({ ...base, muc_khan_cap: "Rất khẩn cấp" }));
    expect(urgent.isComplete).toBe(false);
    expect(urgent.fieldsToAsk).toEqual(["ly_do_gap"]);
  });

  test("never asks for fields the system fills in", () => {
    const gate = evaluateGate(catalog, record({}));
    expect(gate.fieldsToAsk).not.toContain("nguoi_gui");
    expect(gate.fieldsToAsk).not.toContain("tieu_de");
    expect(gate.missingRequired).not.toContain("tieu_de");
  });

  test("does not mutate the record it is given", () => {
    const input = record({ van_de: "a" }, { questionCount: { nguoi_anh_huong: 9 } });
    const snapshot = JSON.stringify(input);
    evaluateGate(catalog, input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("catalog integrity", () => {
  test("rejects a field pointing at a vocabulary that does not exist", () => {
    expect(() =>
      createCatalog({
        fields: { nhanh: { "1": { truong: { x: { kieu: "enum:khong_co", duoc_hoi: true } } } } },
      }),
    ).toThrow(/no such vocabulary/);
  });

  test("rejects a conditional rule referencing a missing vocabulary", () => {
    expect(() =>
      createCatalog({
        fields: {
          nhanh: { "1": { truong: { x: { bat_buoc_neu: "y in vang_mat", kieu: "text" } } } },
        },
      }),
    ).toThrow(/missing vocabulary/);
  });

  test("rejects a recap listing an unknown field", () => {
    expect(() =>
      createCatalog({
        fields: { nhanh: { "1": { recap: ["khong_ton_tai"], truong: {} } } },
      }),
    ).toThrow(/neither a field nor an auto label/);
  });
});
