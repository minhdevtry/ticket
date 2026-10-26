import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
import { z } from "zod";

export interface TrackerConfig {
  baseUrl: string;
  apiKey: string;
  projectKey: string;
  webUrl?: string;
}

export interface IssueVocabulary {
  noun: string;
  handlerTeam: string;
  commentAuthorFallback: string;
}

export const DEFAULT_ISSUE_VOCABULARY: IssueVocabulary = {
  noun: "ticket",
  handlerTeam: "Kỹ thuật",
  commentAuthorFallback: "Kỹ thuật viên",
};

export interface OwnTicketsOnlyOptions {
  ownTicketsOnly?: boolean;
}

export interface UpdateIssueOptions extends OwnTicketsOnlyOptions {
  requireConfirmation?: boolean;
}

export function getIssue(
  config: TrackerConfig,
  _dbPath?: string,
  vocabulary: IssueVocabulary = DEFAULT_ISSUE_VOCABULARY,
  _options: OwnTicketsOnlyOptions = {},
): AnyMcpTool {
  const sampleId = `${config.projectKey}-42`;
  return defineTool({
    name: "get_issue",
    description:
      "Tra tiến độ, người phụ trách và toàn bộ trao đổi của một bản ghi theo mã " +
      `(ví dụ "${sampleId}") hoặc tra ${vocabulary.noun} gần nhất nếu người dùng không nhớ mã. ` +
      "Dùng khi người dùng hỏi tiến độ hoặc nhắc tới một mã.",
    inputSchema: {
      identifier: z
        .string()
        .optional()
        .describe(
          `Mã hiển thị, ví dụ "${sampleId}". Nếu để trống sẽ tự lấy ${vocabulary.noun} gần nhất qua chatId.`,
        ),
      chatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của người dùng để tra ticket gần nhất nếu thiếu mã"),
    },
    handler: async () => ({}),
  });
}

export function updateIssue(
  config: TrackerConfig,
  _dbPath?: string,
  _vocabulary: IssueVocabulary = DEFAULT_ISSUE_VOCABULARY,
  options: UpdateIssueOptions = {},
): AnyMcpTool {
  const sampleId = `${config.projectKey}-42`;
  return defineTool({
    name: "update_issue",
    description:
      "Bổ sung / đính chính thông tin vào MỘT BẢN GHI CỦA CHÍNH NGƯỜI DÙNG. TUYỆT ĐỐI KHÔNG dùng khi " +
      "người dùng trình bày một sự cố/yêu cầu hoàn toàn mới — việc mới thì LUÔN LUÔN tạo bản ghi mới. " +
      "Bắt buộc truyền `identifier` — nếu chưa chắc là mã nào, hỏi lại người dùng chứ không tự đoán. " +
      (options.requireConfirmation
        ? "KHÔNG ghi ngay: gọi lần đầu (userConfirmed=false) chỉ trả bản xem trước + nút xác nhận; gửi nguyên văn `message` cho người dùng. " +
          "Khi người dùng bấm nút xác nhận mới gọi lại với userConfirmed=true và chatId. Người dùng bấm Huỷ thì gọi với cancel=true."
        : ""),
    inputSchema: {
      identifier: (options.requireConfirmation ? z.string().optional() : z.string()).describe(
        `Mã hiển thị, ví dụ "${sampleId}". Chưa chắc chắn thì phải hỏi lại người dùng trước, không được để trống rồi đoán.`,
      ),
      note: (options.requireConfirmation ? z.string().optional() : z.string()).describe(
        "Nội dung người dùng bổ sung / đính chính, nguyên văn",
      ),
      studentAccount: z
        .string()
        .optional()
        .describe("Tài khoản học sinh hoặc SĐT phụ huynh mới bổ sung"),
      device: z.string().optional().describe("Thiết bị sử dụng bổ sung"),
      appVersion: z.string().optional().describe("Phiên bản app bổ sung"),
      roomId: z.string().optional().describe("Mã phòng học / lớp bổ sung"),
      mediaPaths: z
        .array(z.string())
        .optional()
        .describe("Danh sách đường dẫn file ảnh bổ sung cần đính kèm"),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Mức ưu tiên mới, chỉ đặt khi người dùng yêu cầu rõ"),
      chatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của người dùng (bắt buộc khi cần xác nhận)"),
      userConfirmed: z
        .boolean()
        .optional()
        .describe("true khi người dùng đã bấm nút xác nhận bản xem trước"),
      cancel: z.boolean().optional().describe("true khi người dùng bấm Huỷ bản xem trước"),
    },
    handler: async () => ({}),
  });
}
