import type { InlineButton } from "@vuihoc/bot-core/intake";
import type { IntakeDocument, IntakeDocumentStatus } from "./types";

export type IntakeNextAction =
  | "ask_missing_field"
  | "confirm_summary"
  /** Xác nhận tới quá sớm sau tóm tắt (nghi model tự bấm) — vẫn chờ người dùng. */
  | "awaiting_user_confirmation"
  /** Tin nhắn mới mang định danh xung đột với tờ khai đang mở — hỏi rõ sự cố mới hay bổ sung (TECH-928). */
  | "ask_new_or_continue"
  /** Tin nhắn chứa nhiều học sinh/sự cố — hỏi rõ tách ticket hay gộp (W29-SPLIT). */
  | "ask_split_or_merge"
  /** Bản xem trước ghi vào ticket đã có — chờ người báo bấm xác nhận (ADR-0008). */
  | "confirm_ticket_action"
  /** Trả lời tra cứu tình trạng ticket. */
  | "lookup_result"
  | "ticket_created"
  | "post_create_update"
  | "already_created"
  | "clarify_intent"
  | "canceled"
  | "create_failed"
  | "in_progress";

export interface IntakePacket {
  success: boolean;
  docId: string;
  chatId: string;
  revision: number;
  status: IntakeDocumentStatus;
  action: IntakeNextAction;
  voiceText: string;
  displayMarkdown?: string;
  missingFields: string[];
  /** Hàng nút (channel-agnostic, `callbackData`) — pipeline đã tự đẩy ra Telegram qua file nút chờ. */
  buttons?: InlineButton[][];
  issue?: {
    id: number;
    identifier: string;
    title: string;
    url?: string;
  };
  /**
   * CHỈ có ở lượt tạo ticket mà còn hàng đợi tách (W29-SPLIT): ticket VỪA TẠO xong trong
   * lượt này, tách bạch khỏi `document` (vốn là tờ khai của SỰ CỐ KẾ TIẾP).
   * Hợp đồng của lượt đó: `action`/`issue`/`createdIssue` = ticket vừa tạo;
   * `document`/`docId`/`status`/`buttons` = tờ khai KẾ TIẾP đang mở; tóm tắt sự cố kế
   * tiếp nằm ở `displayMarkdown`/`voiceText`. Hai bên khác nhau là CÓ CHỦ Ý (P3, Vòng 3).
   */
  createdIssue?: {
    id: number;
    identifier: string;
    title: string;
  };
  /** CHỈ có ở lượt tạo ticket còn hàng đợi tách: tóm tắt tờ khai KẾ TIẾP đang mở (P3, Vòng 3). */
  nextDraft?: {
    docId: string;
    action: IntakeNextAction;
    status: IntakeDocumentStatus;
  };
  similarTickets: Array<{
    identifier: string;
    title: string;
    system?: string;
    rootCause?: string;
    resolution?: string;
    link?: string;
  }>;
  document: IntakeDocument;
}
