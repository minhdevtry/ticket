/**
 * Bộ mục thông tin chuẩn (cùng từ vựng với nghiên cứu W23/W24) để Tiểu Linh học
 * "người báo thường phải bổ sung gì" theo từng hệ thống.
 *
 * Mỗi mục có MỘT dòng hỏi ngắn (cùng văn phong với checklist-review.ts). Dòng hỏi
 * của các mục đã có trong danh sách cố định được tách ra đây để checklist và bộ học
 * dùng chung, khỏi lệch nhau.
 */

export const CANON_ITEMS = [
  "SCREENSHOT",
  "ERROR_TEXT",
  "STEPS",
  "EXPECTED_VS_ACTUAL",
  "TIME",
  "DEVICE_APP",
  "STUDENT_ID",
  "CARE_STUDENT_LINK",
  "CRM_CONTACT_LINK",
  "LMS_UID_LINK",
  "ORDER_CODE",
  "COURSE_CLASS_SCOPE",
  "OTHER_LINK",
  "EXTENT",
  "OTHER",
] as const;

export type CanonItem = (typeof CANON_ITEMS)[number];

export function isCanonItem(value: unknown): value is CanonItem {
  return typeof value === "string" && (CANON_ITEMS as readonly string[]).includes(value);
}

/**
 * Dòng hỏi cố định trong checklist-review.ts (key là tên ngắn trong `missing`) →
 * các mục chuẩn mà dòng đó đáp ứng. Dùng để biết mục học được nào đã được hỏi/đã có.
 */
export const CHECKLIST_KEY_ITEMS: Record<string, CanonItem[]> = {
  "ảnh màn hình": ["SCREENSHOT"],
  "link chi tiết CARE": ["CARE_STUDENT_LINK"],
  "link contact CRM": ["CRM_CONTACT_LINK"],
  "UID/link LMS": ["LMS_UID_LINK"],
  "mã đơn hàng": ["ORDER_CODE"],
  "học sinh/khoá/lớp": ["COURSE_CLASS_SCOPE", "STUDENT_ID"],
  "bước thao tác": ["STEPS"],
  "đang hiện vs đúng": ["EXPECTED_VS_ACTUAL"],
  "thời điểm": ["TIME"],
  "thiết bị/app": ["DEVICE_APP"],
};
