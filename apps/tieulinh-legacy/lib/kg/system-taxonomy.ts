import taxonomyData from "./system-taxonomy.json";

/**
 * Chuẩn hoá tên "Hệ thống" về danh mục đóng 9 giá trị (system-taxonomy.json).
 *
 * Nguồn luật: Excel "[Vuihoc] Tổng hợp lỗi hệ thống 2026" cột Tech update
 * (tech lead duy trì) + rule: OMS chỉ setup sản phẩm/CTKM; tạo đơn, chuyển phí,
 * upsale, chuyển đổi sản phẩm → CRM. Chi tiết trong system-taxonomy.json.
 *
 * Hợp đồng: KHÔNG BAO GIỜ tạo nhãn mới — giá trị không nhận diện được rơi về
 * fallback + warn. Alias exact match trước, keyword sau (keyword chỉ áp dụng
 * khi input không chứa một tên hệ thống khác rõ ràng hơn).
 */
export const CANONICAL_SYSTEMS = taxonomyData.systems.map((s) => s.id) as readonly string[];
export type CanonicalSystem = (typeof CANONICAL_SYSTEMS)[number];

export const FALLBACK_SYSTEM: CanonicalSystem = "Khác_Hạ tầng_IT";

/** Nhãn rác đã từng xuất hiện trong graph / Excel hiếm — map tường minh. */
const EXACT_ALIASES: Record<string, CanonicalSystem> = {
  // chuẩn
  crm_vuihoc: "CRM_Vuihoc",
  duo_vuihoc: "DUO_Vuihoc",
  duo: "DUO_Vuihoc",
  tutor_vuihoc: "TUTOR_Vuihoc",
  "vh_tự học": "VH_Tự học",
  vh_tự_học: "VH_Tự học",
  lms_vuihoc: "LMS_Vuihoc",
  care_vuihoc: "CARE_Vuihoc",
  classin: "ClassIn",
  vneschool: "VNESCHOOL",
  "khác_hạ tầng_it": "Khác_Hạ tầng_IT",
  // nhãn rác của graph cũ
  "tutor_vuihoc (erp/app/web_gia sư)": "TUTOR_Vuihoc",
  "tutor_vuihoc (erp/app/web_gia_sư)": "TUTOR_Vuihoc",
  "vuihoc (app/web_vuihoc + erp_duo)": "VH_Tự học", // nhãn trộn — mặc định non-Duo; keyword pass có thể nâng thành DUO
  oms_vuihoc: "CRM_Vuihoc", // rule tech lead: OMS chỉ setup; lỗi đơn là CRM
  oms: "CRM_Vuihoc",
  "crm/erp_tutor": "CRM_Vuihoc",
  crm_vh: "CRM_Vuihoc",
  "bitu chat": "DUO_Vuihoc",
  web_vuihoc: "VH_Tự học",
  "app/web_vuihoc": "VH_Tự học",
  "khác (liên quan bên it)": "Khác_Hạ tầng_IT",
  sms: "Khác_Hạ tầng_IT",
  // giá trị hiếm trong Excel nhưng không nằm trong 9 chuẩn
  "k12 viettel": "Khác_Hạ tầng_IT",
  bizfly_vuihoc: "Khác_Hạ tầng_IT",
  "thi thử đgnl": "Khác_Hạ tầng_IT",
  app_thpt: "VH_Tự học",
  "survery platform": "Khác_Hạ tầng_IT",
  invoice: "CRM_Vuihoc",
};

/** Từ khóa nhận diện theo definition — dùng khi alias không khớp. */
const KEYWORD_RULES: Array<{ system: CanonicalSystem; patterns: RegExp[] }> =
  taxonomyData.systems.map((s) => ({
    system: s.id as CanonicalSystem,
    patterns: (s.keywords ?? []).map(
      (k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    ),
  }));

// CRM phải thắng DUO/VH_Tự học khi cả hai cùng xuất hiện (ví dụ "không lên được
// đơn lớp Duo" là lỗi đơn — CRM), theo rule nghiệp vụ tech lead.
const KEYWORD_PRIORITY: CanonicalSystem[] = [
  "CRM_Vuihoc",
  "TUTOR_Vuihoc",
  "CARE_Vuihoc",
  "LMS_Vuihoc",
  "ClassIn",
  "VNESCHOOL",
  "DUO_Vuihoc",
  "VH_Tự học",
  "Khác_Hạ tầng_IT",
];

export interface NormalizeSystemResult {
  value: CanonicalSystem;
  /** Cách tìm ra: "exact" | "alias" | "keyword" | "fallback" */
  via: "exact" | "alias" | "keyword" | "fallback";
  /** true nếu cần người duyệt lại (nhãn trộn cũ, fallback, hoặc bucket VH_Tự học vs DUO chưa chốt) */
  needsReview: boolean;
  /** Nhãn gốc trước khi normalize */
  original: string;
}

/**
 * Chuẩn hoá tên hệ thống. Trả về null khi input rỗng (caller quyết định bỏ qua
 * hay fallback — kg-sync bỏ qua, relabel script fallback).
 */
export function normalizeSystemName(raw: string | null | undefined): NormalizeSystemResult | null {
  const original = (raw ?? "").trim();
  if (!original) return null;

  const key = original.toLowerCase().replace(/\s+/g, " ");

  if ((CANONICAL_SYSTEMS as readonly string[]).includes(original)) {
    return { value: original as CanonicalSystem, via: "exact", needsReview: false, original };
  }
  if (EXACT_ALIASES[key]) {
    const value = EXACT_ALIASES[key];
    const isMixedLabel = key.includes("app/web_vuihoc + erp_duo") || key.includes("bitu chat");
    return { value, via: "alias", needsReview: isMixedLabel, original };
  }

  // keyword pass — theo thứ tự ưu tiên nghiệp vụ
  for (const system of KEYWORD_PRIORITY) {
    const rule = KEYWORD_RULES.find((r) => r.system === system);
    if (!rule) continue;
    for (const re of rule.patterns) {
      if (re.test(original)) {
        // Bucket chưa chốt: VH_Tự học vs DUO trên app vuihoc.vn
        const ambiguous =
          (system === "VH_Tự học" || system === "DUO_Vuihoc") &&
          /app vuihoc|web vuihoc|vuihoc\.vn/i.test(original) &&
          !/duo/i.test(original) === (system === "DUO_Vuihoc");
        return { value: system, via: "keyword", needsReview: ambiguous, original };
      }
    }
  }

  return { value: FALLBACK_SYSTEM, via: "fallback", needsReview: true, original };
}

/**
 * Trả về tập nhãn (alias union) cho một hệ thống chuẩn — gồm id chuẩn + mọi
 * nhãn cũ trong `absorbs` của system-taxonomy.json. Mục đích: search theo tag ở
 * Onyx (xem OnyxRestSearchClient) mà Onyx không bao giờ được gắn tag `system`
 * lúc ingest (xem worker/ingest.service.ts: chỉ ghi metadata.ticket_id/status/
 * root_cause/resolution) → tìm theo EQUAL sẽ trả 0. Nếu nhãn đã từng xuất hiện
 * trong document cũ dưới dạng "VUihoc (App/Web_Vuihoc)" plain text trong
 * content, có thể match theo chuỗi — đó là job của soft-filter post-fetch,
 * KHÔNG phải job của hàm này.
 *
 * Hợp đồng: với input không thuộc 9 chuẩn, trả mảng chỉ chứa input gốc (đã
 * trim) — caller tự quyết định fallback. Không ném lỗi vì đây là helper search,
 * không phải chuẩn hoá (muốn chuẩn hoá dùng normalizeSystemName).
 */
export function systemAliasesFor(canonical: string): string[] {
  const trimmed = canonical.trim();
  if (!trimmed) return [];
  const entry = taxonomyData.systems.find((s) => s.id === trimmed);
  if (!entry) return [trimmed];
  const absorbs = (entry.absorbs ?? []).filter((a) => typeof a === "string" && a.length > 0);
  // Đặt id chuẩn trước (ưu tiên trùng khớp canonical nếu Onyx có tag), aliases
  // theo sau — Onyx không quan tâm thứ tự trong tag_value nhưng log dễ đọc.
  return [entry.id, ...absorbs];
}
