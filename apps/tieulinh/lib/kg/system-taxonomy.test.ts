import { describe, expect, it } from "bun:test";
import { normalizeSystemName, CANONICAL_SYSTEMS, FALLBACK_SYSTEM } from "./system-taxonomy";

describe("normalizeSystemName — danh mục đóng 9 giá trị (2026-09-23)", () => {
  it("9 giá trị chuẩn, không hơn", () => {
    expect(CANONICAL_SYSTEMS).toHaveLength(9);
    expect(CANONICAL_SYSTEMS).toContain("CRM_Vuihoc");
    expect(CANONICAL_SYSTEMS).toContain("DUO_Vuihoc");
    expect(CANONICAL_SYSTEMS).toContain("TUTOR_Vuihoc");
    expect(CANONICAL_SYSTEMS).toContain("VH_Tự học");
    expect(CANONICAL_SYSTEMS).toContain("Khác_Hạ tầng_IT");
  });

  it("tên chuẩn đi qua không đổi", () => {
    expect(normalizeSystemName("CRM_Vuihoc")?.value).toBe("CRM_Vuihoc");
    expect(normalizeSystemName("CRM_Vuihoc")?.via).toBe("exact");
    expect(normalizeSystemName("CARE_Vuihoc")?.needsReview).toBe(false);
  });

  it("alias: 2 biến thể unicode của TUTOR gộp về 1", () => {
    const a = normalizeSystemName("TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)")!;
    const b = normalizeSystemName("TUTOR_Vuihoc (ERP/APP/WEB_Gia_sư)")!;
    expect(a.value).toBe("TUTOR_Vuihoc");
    expect(b.value).toBe("TUTOR_Vuihoc");
  });

  it("RULE TECH LEAD: mọi OMS_Vuihoc → CRM_Vuihoc (OMS chỉ setup sản phẩm/CTKM)", () => {
    expect(normalizeSystemName("OMS_Vuihoc")!.value).toBe("CRM_Vuihoc");
    expect(normalizeSystemName("oms")!.value).toBe("CRM_Vuihoc");
  });

  it("nhãn rác LLM: CRM_VH, CRM/ERP_Tutor → CRM_Vuihoc; SMS → Khác_Hạ tầng_IT", () => {
    expect(normalizeSystemName("CRM_VH")!.value).toBe("CRM_Vuihoc");
    expect(normalizeSystemName("CRM/ERP_Tutor")!.value).toBe("CRM_Vuihoc");
    expect(normalizeSystemName("SMS")!.value).toBe("Khác_Hạ tầng_IT");
    expect(normalizeSystemName("Bitu Chat")!.value).toBe("DUO_Vuihoc");
  });

  it("nhãn trộn App/Web+DUO: alias về VH_Tự học nhưng needsReview (bucket chưa chốt với tech lead)", () => {
    const r = normalizeSystemName("Vuihoc (App/Web_Vuihoc + ERP_DUO)")!;
    expect(r.value).toBe("VH_Tự học");
    expect(r.needsReview).toBe(true);
  });

  it("keyword: ticket tạo đơn/chuyển phí → CRM kể cả khi nhắc Duo (thắng theo priority)", () => {
    expect(normalizeSystemName("Không lên được đơn lớp Duo do trùng tài khoản")!.value).toBe("CRM_Vuihoc");
    expect(normalizeSystemName("Chuyển phí khóa gia sư sai số buổi")!.value).toBe("CRM_Vuihoc");
    expect(normalizeSystemName("CTS chưa được đối soát do lỗi")!.value).toBe("CRM_Vuihoc");
  });

  it("keyword: lỗi Duo thuần → DUO; lỗi gia sư thuần → TUTOR; BTVN/sổ liên lạc → VH_Tự học", () => {
    expect(normalizeSystemName("Bài giảng Duo không phát được tiếng")!.value).toBe("DUO_Vuihoc");
    expect(normalizeSystemName("App gia sư không hiển thị bài tập")!.value).toBe("TUTOR_Vuihoc");
    expect(normalizeSystemName("BTVN Sổ liên lạc không load")!.value).toBe("VH_Tự học");
  });

  it("không nhận diện được → fallback Khác_Hạ tầng_IT + needsReview, KHÔNG tạo nhãn mới", () => {
    const r = normalizeSystemName("Hệ thống quản lý kho hangSilongTựNhiên")!;
    expect(r!.value).toBe(FALLBACK_SYSTEM);
    expect(r!.needsReview).toBe(true);
    expect(r!.via).toBe("fallback");
  });

  it("input rỗng/null → null (caller tự quyết định bỏ qua hay fallback)", () => {
    expect(normalizeSystemName(null)).toBeNull();
    expect(normalizeSystemName("")).toBeNull();
    expect(normalizeSystemName("   ")).toBeNull();
  });
});
