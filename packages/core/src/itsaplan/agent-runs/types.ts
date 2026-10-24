/**
 * Kiểu dữ liệu giao thức "external agent runs" của itsaplan.
 *
 * Mô tả đầy đủ endpoint, payload và ngữ nghĩa lỗi: `docs/reference/agent-runs.md`.
 */

/**
 * Điều gì đã tạo ra run. Server hiện phát bảy loại:
 *  - `mention`: có comment `@agent` (hoặc trả lời comment của agent);
 *  - `delegation`: issue được giao (delegate) cho agent;
 *  - `field`: agent được đặt vào một custom field kiểu "member";
 *  - `schedule`: lịch cron chạy theo giờ UTC;
 *  - `manual`: người dùng bấm chạy một lịch cron;
 *  - `status`: issue vào một cột mà lịch `status` theo dõi;
 *  - `event`: loại do extension của instance thêm.
 *
 * SDK chính thức mới liệt kê năm loại đầu; `status`/`event` có trong schema server
 * nên client này nhận cả bảy, và chấp nhận chuỗi lạ (server thêm loại mới không
 * làm worker hỏng).
 */
export type AgentRunTrigger =
  | "mention"
  | "delegation"
  | "field"
  | "schedule"
  | "manual"
  | "status"
  | "event";

/** Run mà worker nhận được từ `POST /agent-runs/claim`. */
export interface ClaimedAgentRun {
  id: number;
  /** Loại trigger. Có thể là chuỗi chưa biết nếu server mới thêm loại. */
  trigger: AgentRunTrigger | (string & {});
  /**
   * Nhiệm vụ đã được server "đóng khung" (nói rõ chuyện gì đã xảy ra và cần làm gì).
   * Với `schedule`/`manual` là prompt của lịch; với `mention` là cả khung chứa comment.
   */
  prompt: string;
  /** Chỉ dẫn về chính run (chạy tự động, dự án nào, ai liên quan, chỉ dẫn của operator). */
  systemPrompt: string;
  /** Lần thử thứ mấy (1 = lần đầu). Tăng mỗi lần lease hết hạn mà run được giao lại. */
  attempts: number;
  /** Server có muốn nhận trace (`/events`) cho run này không. */
  traceEvents: boolean;
  issueId: number | null;
  /** Mã đọc được, vd `TECH-42`. `null` nếu run không gắn issue hoặc issue đã bị xoá. */
  issueIdentifier: string | null;
}

/** Số token của lần gọi model cuối trong run (để hiện trên lịch sử run). */
export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Kết quả báo lại cho `POST /agent-runs/:id/result`. */
export interface AgentRunResult {
  status: "success" | "failed";
  /** Kết quả để xem lịch sử. Server cắt còn 10 000 ký tự. */
  output?: string | null;
  /** Lý do thất bại. Server cắt còn 500 ký tự. */
  error?: string | null;
  usage?: AgentRunUsage | null;
}

/**
 * Tập con sự kiện AG-UI mà server nhận ở `/events` (đúng tên trường của giao
 * thức AG-UI; `threadId`/`runId` của lifecycle là tuỳ chọn vì server tự biết).
 */
export type AgUiEvent =
  | { type: "RUN_STARTED"; threadId?: string; runId?: string }
  | { type: "RUN_FINISHED"; threadId?: string; runId?: string }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | {
      type: "TOOL_CALL_START";
      toolCallId: string;
      toolCallName: string;
      parentMessageId?: string;
    }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | {
      type: "TOOL_CALL_RESULT";
      messageId: string;
      toolCallId: string;
      content: string;
      role?: "tool";
    };

/** Một lô sự kiện cho `POST /agent-runs/:id/events`. */
export interface AgentRunEventsBatch {
  /** Lần thử hiện tại (`ClaimedAgentRun.attempts`). */
  attempt: number;
  /** Vị trí của sự kiện đầu lô trong dòng sự kiện của lần thử này (bắt đầu từ 0). */
  offset: number;
  /** 1–200 sự kiện. */
  events: AgUiEvent[];
  /** UUID phiên của coding agent nếu có (server gắn vào lần thử, không đổi được). */
  sessionId?: string;
}

/** Trả lời của `/events`. */
export interface AgentRunEventsAck {
  /** Offset mong đợi cho lô kế tiếp. */
  nextOffset: number;
  /** Server đã chạm trần (2000 sự kiện / 1 MB) và đang bỏ bớt. */
  truncated: boolean;
}

/** Giới hạn do server áp, hằng số hoá để client/worker cắt trước. */
export const AGENT_RUN_LIMITS = {
  outputChars: 10_000,
  errorChars: 500,
  eventsPerBatch: 200,
  textDeltaChars: 12_000,
  toolTextChars: 32_000,
} as const;
