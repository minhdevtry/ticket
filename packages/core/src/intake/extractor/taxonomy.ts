/**
 * Domain taxonomy and synonyms for intake extraction.
 *
 * Core provides default Vietnamese support and common educational platform terms.
 * Apps can supply their own taxonomy / synonyms via ExtractorDomainConfig without
 * coupling core to specific business verticals.
 *
 * LƯU Ý VỀ RANH GIỚI (RFC 0002 mục 2.x): từ đồng nghĩa THEO MIỀN (E2) thuộc DỮ
 * LIỆU của app, không phải của core. Ở PR 5, bộ từ đồng nghĩa này là bản PARITY
 * với legacy để port test được đúng ý; PR 14 sẽ đưa danh mục của app vào đây và
 * thay các giá trị mặc định. Mọi lần dùng đều nạp được qua `ExtractorDomainConfig`,
 * nên app đã có thể ghi đè từ PR 5.
 */

export const VALID_PRODUCTS = [
  "Tự học",
  "Duo",
  "Pas",
  "Tutor",
  "Exam",
  "VNESchool",
  "K12 Viettel",
  "Smart Media",
  "Khác",
] as const;
export type ValidProduct = (typeof VALID_PRODUCTS)[number];

export const VALID_SYSTEMS = [
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
export type ValidSystem = (typeof VALID_SYSTEMS)[number];

export const VALID_ERROR_CATEGORIES = [
  "Lỗi hệ thống",
  "Lỗi kỹ thuật",
  "Lỗi dữ liệu",
  "Lỗi bên thứ 3",
  "Lỗi chưa xác định",
  "Hỗ trợ",
  "Khác",
  "Lỗi cấu hình máy",
  "Cải tiến sản phẩm",
  "ND bị nhầm hoặc hiểu sai",
  "Lỗi nhập liệu",
] as const;
export type ValidErrorCategory = (typeof VALID_ERROR_CATEGORIES)[number];

export const VALID_REPORTING_DEPTS = [
  "Vận hành",
  "Vận đơn",
  "CSKH",
  "CSHV",
  "Chuyên môn",
  "Sale",
  "Quản lý lớp",
] as const;
export type ValidReportingDept = (typeof VALID_REPORTING_DEPTS)[number];

export const VALID_DEVICE_TYPES = ["Điện thoại", "Máy tính bảng", "PC", "Laptop"] as const;

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
