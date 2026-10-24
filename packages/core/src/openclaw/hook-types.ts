/**
 * Kiểu CỤC BỘ cho các hook OpenClaw mà kit này đụng tới.
 *
 * Ticket 07: "No dependency on the OpenClaw runtime package; plugin hook event
 * shapes are typed locally from what the sources use." Đây KHÔNG phải khai báo
 * đầy đủ của OpenClaw — chỉ những trường các plugin nguồn thực sự đọc
 * (`cm-support`, `iris-tuong-tac`, `dinh-huong`, `nap-skill`). Vì vậy mọi trường
 * đều optional và `unknown`-dung-sai ở biên: plugin đọc phòng thủ, không giả định.
 */

/** ctx chung của hook — các trường runtime bơm vào mà plugin nguồn có đọc. */
export interface PluginHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  chatId?: string | number;
  senderId?: string | number;
  accountId?: string;
  channel?: string;
  /** Ngữ cảnh kênh (Telegram đặt `sender` ở đây). */
  channelContext?: {
    sender?: { id?: string | number; username?: string; handle?: string; isBot?: boolean } | null;
    chat?: { id?: string | number } | null;
  } | null;
}

/** event của `before_agent_run`. */
export interface BeforeAgentRunEvent {
  runId?: string;
  senderId?: string | number;
  senderUsername?: string;
}

/** event của `before_tool_call`. Kết quả hook có thể trả `{ params }` để ghi đè. */
export interface BeforeToolCallEvent {
  toolName?: string;
  runId?: string;
  params?: Record<string, unknown>;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
}

/** event của `before_prompt_build` — nơi chèn system context. */
export interface BeforePromptBuildEvent {
  prompt?: string;
  /** Codex trả rỗng; embedded runtime có lịch sử. */
  messages?: Array<{ role?: string; content?: unknown }>;
}

export interface BeforePromptBuildResult {
  prependSystemContext?: string;
}
