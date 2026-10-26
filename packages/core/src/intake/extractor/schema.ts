/**
 * Zod schema generation for intake field extraction (RFC 0002 §1.5 E1).
 */
import { z } from "zod";
import {
  VALID_DEVICE_TYPES,
  VALID_ERROR_CATEGORIES,
  VALID_PRODUCTS,
  VALID_REPORTING_DEPTS,
  VALID_SYSTEMS,
} from "./taxonomy";

export interface ExtractorSchemaOptions {
  products?: readonly string[];
  systems?: readonly string[];
  errorCategories?: readonly string[];
  reportingDepts?: readonly string[];
  deviceTypes?: readonly string[];
}

export const USER_INTENTS = [
  "report_issue",
  "provide_info",
  "confirm",
  "cancel",
  "chitchat",
] as const;

export const SCOPE_VALUES = ["single_user", "group", "entire_system"] as const;
export const REQUESTED_PRIORITIES = ["high", "urgent"] as const;

/**
 * Builds the Zod schema for structured extraction from LLM responses.
 */
export function buildExtractorSchema(options: ExtractorSchemaOptions = {}) {
  const products = (
    options.products && options.products.length > 0 ? options.products : VALID_PRODUCTS
  ) as [string, ...string[]];
  const systems = (
    options.systems && options.systems.length > 0 ? options.systems : VALID_SYSTEMS
  ) as [string, ...string[]];
  const errorCategories = (
    options.errorCategories && options.errorCategories.length > 0
      ? options.errorCategories
      : VALID_ERROR_CATEGORIES
  ) as [string, ...string[]];
  const reportingDepts = (
    options.reportingDepts && options.reportingDepts.length > 0
      ? options.reportingDepts
      : VALID_REPORTING_DEPTS
  ) as [string, ...string[]];
  const deviceTypes = (
    options.deviceTypes && options.deviceTypes.length > 0 ? options.deviceTypes : VALID_DEVICE_TYPES
  ) as [string, ...string[]];

  return z.object({
    userIntent: z.enum(USER_INTENTS).describe("Ý định chính của người dùng"),
    title: z
      .string()
      .nullable()
      .optional()
      .describe("Tiêu đề ngắn gọn của sự cố nếu nhận diện được"),
    titleExplicit: z
      .boolean()
      .optional()
      .describe(
        "true CHỈ khi người dùng yêu cầu rõ đổi tiêu đề — khi đó `title` được phép đè tiêu đề cũ",
      ),
    symptoms: z
      .array(z.string())
      .default([])
      .describe("Danh sách các triệu chứng/lỗi quan sát được"),
    removeSymptoms: z
      .array(z.string())
      .optional()
      .describe(
        "Triệu chứng người dùng bảo bỏ/không đúng (khớp theo chuỗi con, không phân biệt hoa thường)",
      ),
    product: z.enum(products).nullable().optional().describe("Sản phẩm thuộc danh mục đóng"),
    system: z.enum(systems).nullable().optional().describe("Hệ thống thuộc danh mục đóng"),
    errorCategory: z
      .enum(errorCategories)
      .nullable()
      .optional()
      .describe("Nhóm lỗi thuộc danh mục đóng"),
    reportingDept: z
      .enum(reportingDepts)
      .nullable()
      .optional()
      .describe("Phòng ban người báo thuộc danh mục đóng"),
    reportingDeptUnrecognized: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Bộ phận người dùng tự nêu nhưng KHÔNG nằm trong danh mục đóng (vd "Kế toán") — để hỏi lại đúng một lần kèm danh sách',
      ),
    deviceType: z.enum(deviceTypes).nullable().optional().describe("Loại thiết bị"),
    deviceOs: z.string().nullable().optional().describe("Hệ điều hành"),
    appVersion: z.string().nullable().optional().describe("Phiên bản app"),
    browser: z.string().nullable().optional().describe("Trình duyệt"),
    customerId: z
      .string()
      .nullable()
      .optional()
      .describe("Mã khách hàng nội bộ CRM/ERP (không phải SĐT)"),
    studentAccount: z
      .string()
      .nullable()
      .optional()
      .describe("Tài khoản học sinh hoặc Số điện thoại phụ huynh"),
    roomCode: z.string().nullable().optional().describe("Mã phòng học"),
    transactionId: z
      .string()
      .nullable()
      .optional()
      .describe("Mã giao dịch ngân hàng / cổng thanh toán"),
    assignmentId: z.string().nullable().optional().describe("Mã bài tập"),
    requestedPriority: z
      .enum(REQUESTED_PRIORITIES)
      .nullable()
      .optional()
      .describe(
        'Mức ưu tiên người báo XIN: "gấp"/"cao"/"high" → high; "khẩn cấp"/"rất gấp"/"urgent" → urgent. Không xin thì null',
      ),
    requestedPriorityReason: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Lý do người báo nêu cho việc xin gấp, nguyên văn ngắn (vd "PH khiếu nại cả tuần", "sale cần tạo lịch test cho con"). Không nêu lý do thì null',
      ),
    scope: z
      .enum(SCOPE_VALUES)
      .nullable()
      .optional()
      .describe(
        "Phạm vi ảnh hưởng: một người (single_user), một nhóm/cả lớp/nhiều học sinh (group), toàn hệ thống (entire_system)",
      ),
    blocksPayment: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Có người KHÔNG hoàn tất được giao dịch ngay lúc này: bấm thanh toán ra lỗi, không tạo/lên được đơn",
      ),
    reconciliationMismatch: z
      .boolean()
      .nullable()
      .optional()
      .describe("Tiền đã chạy nhưng số liệu/doanh thu sai"),
    blocksLearning: z
      .boolean()
      .nullable()
      .optional()
      .describe("Học sinh không vào học được / không có khoá Active / chưa được xếp lớp"),
    dataLoss: z
      .boolean()
      .nullable()
      .optional()
      .describe("Dữ liệu mất hoặc sai lệch không khôi phục được"),
    hasWorkaround: z.boolean().nullable().optional().describe("Có cách làm tạm để đi tiếp"),
    singleDeviceOnly: z
      .boolean()
      .nullable()
      .optional()
      .describe("Chỉ lỗi trên một máy, đổi máy/mạng thì hết"),
  });
}

export const defaultExtractorSchema = buildExtractorSchema();

/**
 * Danh sách khoá JSON kèm mô tả, sinh từ chính schema — đưa vào prompt để model
 * biết phải trả khoá nào.
 */
export function describeExtractedKeys(options?: ExtractorSchemaOptions): string {
  const schema = options ? buildExtractorSchema(options) : defaultExtractorSchema;
  return Object.entries(schema.shape)
    .map(([key, field]) => `- "${key}": ${(field as z.ZodType).description ?? ""}`)
    .join("\n");
}
