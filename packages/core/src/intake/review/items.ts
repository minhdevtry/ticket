/**
 * Bộ mục thông tin chuẩn (cùng từ vựng với nghiên cứu W23/W24) để Tiểu Linh học
 * "người báo thường phải bổ sung gì" theo từng hệ thống.
 *
 * Mỗi mục có MỘT dòng hỏi ngắn (cùng văn phong với checklist-review.ts). Dòng hỏi
 * của các mục đã có trong danh sách cố định được tách ra đây để checklist và bộ học
 * dùng chung, khỏi lệch nhau.
 */
import type { CopyKey } from "../ports";

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
 * Khoá `CopyCatalog` của dòng hỏi cho từng mục.
 *
 * Bảng TČNH (không dựng khoá động) để union `CopyKey` vẫn là union đóng — gõ sai
 * khoá thì phải là lỗi kiểu, không phải lỗi chạy. `OTHER` không có dòng hỏi.
 */
export const ASK_LINE_COPY_KEY: Partial<Record<CanonItem, CopyKey>> = {
  SCREENSHOT: "checklist.ask.SCREENSHOT",
  ERROR_TEXT: "checklist.ask.ERROR_TEXT",
  STEPS: "checklist.ask.STEPS",
  EXPECTED_VS_ACTUAL: "checklist.ask.EXPECTED_VS_ACTUAL",
  TIME: "checklist.ask.TIME",
  DEVICE_APP: "checklist.ask.DEVICE_APP",
  STUDENT_ID: "checklist.ask.STUDENT_ID",
  CARE_STUDENT_LINK: "checklist.ask.CARE_STUDENT_LINK",
  CRM_CONTACT_LINK: "checklist.ask.CRM_CONTACT_LINK",
  LMS_UID_LINK: "checklist.ask.LMS_UID_LINK",
  ORDER_CODE: "checklist.ask.ORDER_CODE",
  COURSE_CLASS_SCOPE: "checklist.ask.COURSE_CLASS_SCOPE",
  OTHER_LINK: "checklist.ask.OTHER_LINK",
  EXTENT: "checklist.ask.EXTENT",
};

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
