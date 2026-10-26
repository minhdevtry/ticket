/**
 * Danh mục hệ thống chuẩn và ánh xạ nhãn cũ/gộp (absorbs).
 * Phục vụ chuẩn hoá hệ thống khi tra cứu mục học được (W25, RFC 0002 PR 13).
 */

export const CANONICAL_SYSTEMS = [
  "CRM_Vuihoc",
  "DUO_Vuihoc",
  "TUTOR_Vuihoc",
  "VH_Tự học",
  "LMS_Vuihoc",
  "CARE_Vuihoc",
  "ClassIn",
  "VNESCHOOL",
  "Khác_Hạ tầng_IT",
] as const;

export type CanonicalSystem = (typeof CANONICAL_SYSTEMS)[number];
export const FALLBACK_SYSTEM: CanonicalSystem = "Khác_Hạ tầng_IT";

export const SYSTEM_ABSORBS: Record<CanonicalSystem, readonly string[]> = {
  CRM_Vuihoc: ["OMS_Vuihoc", "CRM_VH", "CRM/ERP_Tutor", "CRM/ERP_Tutor (lượt test)"],
  DUO_Vuihoc: ["Bitu Chat", "Vuihoc (App/Web_Vuihoc + ERP_DUO) [phần Duo]"],
  TUTOR_Vuihoc: ["TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)", "TUTOR_Vuihoc (ERP/APP/WEB_Gia_sư)"],
  "VH_Tự học": ["Web_Vuihoc", "App/Web_Vuihoc", "Vuihoc (App/Web_Vuihoc + ERP_DUO) [phần non-Duo]"],
  LMS_Vuihoc: [],
  CARE_Vuihoc: [],
  ClassIn: [],
  VNESCHOOL: [],
  "Khác_Hạ tầng_IT": ["Khác (liên quan bên IT)", "SMS"],
};

export const AMBIGUOUS_APP_WEB_LABELS = [
  "Vuihoc (App/Web_Vuihoc + ERP_DUO)",
  "App/Web_Vuihoc",
  "Web_Vuihoc",
  "APP/WEB/CARE_Vuihoc",
] as const;

export function systemAliasesFor(canonical: string): string[] {
  const trimmed = canonical.trim();
  if (!trimmed) return [];
  const absorbs = (SYSTEM_ABSORBS as Record<string, readonly string[]>)[trimmed];
  if (!absorbs) return [trimmed];
  return [trimmed, ...absorbs];
}
