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

// Danh mục chuẩn 9 giá trị (2026-09-23) — nguồn: Excel "[Vuihoc] Tổng hợp lỗi
// hệ thống 2026" cột Tech update (tech lead) + rule: OMS chỉ setup sản phẩm/CTKM;
// tạo đơn, chuyển phí, upsale, chuyển đổi sản phẩm → CRM. Định nghĩa đầy đủ +
// alias/keyword: lib/kg/system-taxonomy.json. Danh sách 15 nhãn cũ bị xoá vì
// LLM extract từ ticket cũ sinh nhiễu (62% ticket gán sai hệ thống — xem audit
// 2026-09-23): nhãn trộn "Vuihoc (App/Web_Vuihoc + ERP_DUO)", OMS_Vuihoc,
// Bitu Chat, biến thể unicode của TUTOR...
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

export const VALID_DEVICE_TYPES = ["Điện thoại", "Máy tính bảng", "PC", "Laptop"] as const;
export type ValidDeviceType = (typeof VALID_DEVICE_TYPES)[number];

export const FIELD_LABELS: Record<string, string> = {
  product: "sản phẩm",
  system: "hệ thống",
  reportingDept: "bộ phận của anh/chị",
  deviceOs: "hệ điều hành",
  deviceType: "loại thiết bị (Điện thoại/Máy tính bảng/PC/Laptop)",
  appVersion: "phiên bản app",
  browser: "trình duyệt",
  customerId: "mã khách hàng hoặc SĐT phụ huynh",
  studentAccount: "tài khoản học sinh",
  roomCode: "mã phòng học",
  transactionId: "mã giao dịch",
  assignmentId: "mã bài tập",
  symptoms: "mô tả chi tiết hiện tượng lỗi",
};

/**
 * Maps product and system to a high-level category for soft-fields recommendations
 */
export function getProductCategory(
  product?: string,
  system?: string,
): "mobile-app" | "web" | "payment" | "tutor" | "crm" | "default" {
  const combined = `${product || ""} ${system || ""}`.toLowerCase();
  if (combined.includes("crm") || combined.includes("lên đơn") || combined.includes("hóa đơn"))
    return "crm";
  if (combined.includes("tutor") || combined.includes("gia sư") || combined.includes("classin"))
    return "tutor";
  if (
    combined.includes("tự học") ||
    combined.includes("duo") ||
    combined.includes("pas") ||
    combined.includes("exam") ||
    combined.includes("app")
  ) {
    return "mobile-app";
  }
  if (
    combined.includes("vneschool") ||
    combined.includes("viettel") ||
    combined.includes("smart media") ||
    combined.includes("lms") ||
    combined.includes("web")
  ) {
    return "web";
  }
  if (
    combined.includes("payment") ||
    combined.includes("thanh toán") ||
    combined.includes("giao dịch")
  ) {
    return "payment";
  }
  return "default";
}

/**
 * Recommended (soft) fields that enhance incident resolution but do not block creation
 */
export function getRecommendedSoftFields(
  category: ReturnType<typeof getProductCategory>,
  hasSpecificSubject: boolean = true,
): string[] {
  switch (category) {
    case "crm":
      return hasSpecificSubject ? ["mã khách hàng hoặc SĐT phụ huynh"] : [];
    case "mobile-app":
      return ["loại thiết bị (Điện thoại/Máy tính bảng/PC/Laptop)", "hệ điều hành"];
    case "web":
      return ["trình duyệt"];
    case "payment":
      return ["mã giao dịch"];
    case "tutor":
      return hasSpecificSubject ? ["mã phòng học hoặc tài khoản học sinh"] : [];
    default:
      return hasSpecificSubject ? ["số điện thoại phụ huynh hoặc tài khoản học sinh"] : [];
  }
}
