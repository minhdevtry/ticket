/**
 * Domain taxonomy and synonyms for intake extraction.
 *
 * Core provides default Vietnamese support and common educational platform terms.
 * Apps can supply their own taxonomy / synonyms via ExtractorDomainConfig without
 * coupling core to specific business verticals.
 */

export const VALID_PRODUCTS = [
  "Tutor",
  "Duo",
  "Vuihoc247",
  "Care",
  "Tiểu học",
  "THCS",
  "THPT",
  "Khác",
] as const;
export type ValidProduct = (typeof VALID_PRODUCTS)[number];

export const VALID_SYSTEMS = [
  "CRM_Vuihoc",
  "LMS_Vuihoc",
  "VH_Tự học",
  "DUO_Vuihoc",
  "TUTOR_Vuihoc",
  "ClassIn",
  "CARE_Vuihoc",
  "VNESCHOOL",
  "Khác_Hạ tầng_IT",
] as const;
export type ValidSystem = (typeof VALID_SYSTEMS)[number];

export const VALID_ERROR_CATEGORIES = [
  "Lỗi đăng nhập",
  "Lỗi nạp bài",
  "Lỗi phòng học",
  "Lỗi âm thanh/hình ảnh",
  "Lỗi hiển thị",
  "Lỗi thanh toán",
  "Lỗi đồng bộ",
  "Khác",
] as const;
export type ValidErrorCategory = (typeof VALID_ERROR_CATEGORIES)[number];

export const VALID_REPORTING_DEPTS = [
  "Vận hành",
  "CSKH",
  "CSHV",
  "Chuyên môn",
  "Sale",
  "Quản lý lớp",
  "Vận đơn",
] as const;
export type ValidReportingDept = (typeof VALID_REPORTING_DEPTS)[number];

export const VALID_DEVICE_TYPES = ["PC", "Laptop", "Điện thoại", "Máy tính bảng", "Khác"] as const;
export type ValidDeviceType = (typeof VALID_DEVICE_TYPES)[number];

export const SYSTEM_SYNONYMS: Record<string, string> = {
  crm: "CRM_Vuihoc",
  "crm vuihoc": "CRM_Vuihoc",
  lms: "LMS_Vuihoc",
  "app vuihoc": "VH_Tự học",
  "web vuihoc": "VH_Tự học",
  app: "VH_Tự học",
  web: "VH_Tự học",
  duo: "DUO_Vuihoc",
  "erp duo": "DUO_Vuihoc",
  bitu: "DUO_Vuihoc",
  "bitu chat": "DUO_Vuihoc",
  tutor: "TUTOR_Vuihoc",
  "gia sư": "TUTOR_Vuihoc",
  "tutor vuihoc": "TUTOR_Vuihoc",
  classin: "ClassIn",
  care: "CARE_Vuihoc",
  "care vuihoc": "CARE_Vuihoc",
  oms: "CRM_Vuihoc",
  vneschool: "VNESCHOOL",
  "tự học": "VH_Tự học",
  "tự ôn luyện": "VH_Tự học",
  "hạ tầng": "Khác_Hạ tầng_IT",
  khác: "Khác_Hạ tầng_IT",
  zalo: "Khác_Hạ tầng_IT",
  "zalo pc": "Khác_Hạ tầng_IT",
  viber: "Khác_Hạ tầng_IT",
  messenger: "Khác_Hạ tầng_IT",
  telegram: "Khác_Hạ tầng_IT",
};

export const GENERIC_SYSTEM_KEYS: Record<string, true> = {
  app: true,
  web: true,
  khác: true,
};

export const DEPT_SYNONYMS: Record<string, string> = {
  vh: "Vận hành",
  cskh: "CSKH",
  "chăm sóc khách hàng": "CSKH",
  cshv: "CSHV",
  "chăm sóc học viên": "CSHV",
  cm: "Chuyên môn",
  sale: "Sale",
  sales: "Sale",
  qll: "Quản lý lớp",
  vd: "Vận đơn",
};

export const MAX_LLM_MESSAGE_CHARS = 4000;
export const MAX_LLM_CONTEXT_CHARS = 1500;
