import { z } from "zod";
import {
  VALID_PRODUCTS,
  VALID_SYSTEMS,
  VALID_ERROR_CATEGORIES,
  VALID_REPORTING_DEPTS,
  VALID_DEVICE_TYPES,
} from "../../mcp/tieulinh/domain/taxonomy";

export const extractedFieldsSchema = z.object({
  userIntent: z
    .enum(["report_issue", "provide_info", "confirm", "cancel", "chitchat"])
    .describe("Ý định chính của người dùng"),
  title: z.string().nullable().optional().describe("Tiêu đề ngắn gọn của sự cố nếu nhận diện được"),
  titleExplicit: z
    .boolean()
    .optional()
    .describe(
      "true CHỈ khi người dùng yêu cầu rõ đổi tiêu đề — khi đó `title` được phép đè tiêu đề cũ",
    ),
  symptoms: z.array(z.string()).default([]).describe("Danh sách các triệu chứng/lỗi quan sát được"),
  removeSymptoms: z
    .array(z.string())
    .optional()
    .describe(
      "Triệu chứng người dùng bảo bỏ/không đúng (khớp theo chuỗi con, không phân biệt hoa thường)",
    ),
  product: z.enum(VALID_PRODUCTS).nullable().optional().describe("Sản phẩm thuộc danh mục đóng"),
  system: z.enum(VALID_SYSTEMS).nullable().optional().describe("Hệ thống thuộc danh mục đóng"),
  errorCategory: z
    .enum(VALID_ERROR_CATEGORIES)
    .nullable()
    .optional()
    .describe("Nhóm lỗi thuộc danh mục đóng"),
  reportingDept: z
    .enum(VALID_REPORTING_DEPTS)
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
  deviceType: z.enum(VALID_DEVICE_TYPES).nullable().optional().describe("Loại thiết bị"),
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
  // Người báo tự XIN mức ưu tiên (user chốt 29/09: xin gấp có lý do thì cho hết)
  requestedPriority: z
    .enum(["high", "urgent"])
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
  // Evidence cho Priority Matrix
  scope: z
    .enum(["single_user", "group", "entire_system"])
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

export type ExtractedFields = z.infer<typeof extractedFieldsSchema>;

/**
 * Danh sách khoá JSON kèm mô tả, sinh từ chính schema — đưa vào prompt để model
 * biết phải trả khoá nào (trước đây prompt không liệt kê, model không bao giờ trả
 * các trường bằng chứng ưu tiên).
 */
export function describeExtractedKeys(): string {
  return Object.entries(extractedFieldsSchema.shape)
    .map(([key, field]) => `- "${key}": ${(field as z.ZodType).description ?? ""}`)
    .join("\n");
}
