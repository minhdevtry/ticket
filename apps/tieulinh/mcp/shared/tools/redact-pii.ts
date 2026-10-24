import { z } from "zod";
import { redactIncidentPII } from "../../../lib/onyx/pii-redactor";
import { defineTool } from "../tool";

/**
 * Khử thông tin cá nhân trước khi text rời khỏi luồng tiếp nhận.
 *
 * Là tool chứ không phải luật trong prompt, vì đây đúng là loại việc hai model
 * khác nhau bắt buộc phải cho ra cùng một kết quả.
 */
export const redactPii = defineTool({
  name: "redact_pii",
  description:
    "Khử số điện thoại, CCCD, email, mật khẩu và token khỏi một đoạn văn bản, " +
    "giữ lại mã ticket, mã phòng, mã lỗi và địa chỉ IP. Dùng trước khi đưa nội " +
    "dung sự cố ra ngoài luồng tiếp nhận.",
  inputSchema: { text: z.string().describe("Đoạn văn bản cần khử thông tin cá nhân") },
  handler: ({ text }) => ({ redacted: redactIncidentPII(text) }),
});
