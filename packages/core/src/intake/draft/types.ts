/**
 * The intake draft aggregate (ticket 08) — a trimmed, engine-owned relative of
 * intake's `IntakeDocument`. It carries only what the WRITE path needs: the
 * reporter's verbatim text, resolved ticket fields, confirmation timing marks,
 * and the created-ticket pointer. Conversation/collection state (gate fields,
 * similar tickets, KG advice, pending actions) is ticket 09's concern and is
 * deliberately NOT modelled here.
 *
 * NGUỒN: intake `lib/intake-document/types.ts` — `IntakeDocument`,
 * `IntakeDocumentStatus`, `CLOSED_STATUSES`, `summaryShownAt`, `confirmingSince`,
 * `issueCreatedAt`.
 */
import type { Priority } from "../ports";
import { DRAFT_VERSION } from "./version";

export type DraftStatus =
  | "collecting"
  | "ready_for_confirmation"
  | "confirmed"
  | "created"
  | "canceled"
  | "expired";

/** A closed draft takes no further input; a later message is a new matter. */
export const CLOSED_STATUSES: ReadonlySet<DraftStatus> = new Set([
  "created",
  "canceled",
  "expired",
]);

/** The resolved, ready-to-write ticket content held in the draft. */
export interface DraftTicket {
  title: string;
  /** True when the reporter explicitly requested a specific title (locked against auto-summaries). */
  titleExplicit?: boolean;
  /** Reporter's VERBATIM words — becomes the ticket description (ADR-0010). */
  rawText: string;
  priority: Priority;
  category?: string;
  labels?: string[];
  /** Bot inference — written as a SEPARATE marked comment, never the description. */
  diagnosis?: string;
  /** Media file paths / references gathered across the conversation. */
  mediaPaths: string[];
}

/** Một khối sự cố trong báo cáo nhiều người (tách/gộp — W29-SPLIT). */
export interface SplitBlock {
  text: string;
  studentName?: string;
  customerId?: string;
  studentAccount?: string;
  reportingDept?: string;
  title?: string;
  mediaPaths?: string[];
}

/** Tin đang chờ người báo chọn "sự cố mới" hay "bổ sung" (định danh xung đột). */
export interface PendingNewIncident {
  message: string;
  mediaPaths: string[];
  askedAt: string;
}

/** Báo cáo nhiều sự cố đang chờ người báo chọn "tách" hay "gộp 1 ticket". */
export interface PendingSplit {
  blocks: SplitBlock[];
  mediaPaths: string[];
  askedAt: string;
  /** Chữ của những tin CHƯA RÕ Ý ở câu hỏi tách — không bao giờ bị đánh rơi. */
  extraText?: string[];
  /** Số lần đã hỏi lại câu tách vì câu trả lời chưa rõ ý (tối đa 1). */
  clarifyCount?: number;
}

export interface IntakeDraft {
  docId: string;
  chatId: string;
  revision: number;
  status: DraftStatus;
  /**
   * Phiên bản HÌNH DẠNG tờ khai (2 = đủ trường hội thoại). Bản cũ không có
   * trường này nên mặc định là 1; khi đọc, `migrateDraft` nâng lên bản hiện hành.
   */
  version?: number;
  ticket: DraftTicket;
  reporter?: { name?: string; username?: string; nameCode?: string };

  /** When the summary was shown (ISO) — gates confirm-too-soon. */
  summaryShownAt?: string;
  /** When a `confirmed` claim was taken (ISO) — a stuck claim is released after staleMs. */
  confirmingSince?: string;

  /** Created-ticket pointer, set once status is `created`. */
  issueId?: number;
  issueIdentifier?: string;
  issueUrl?: string;
  /** When the ticket was created (ISO) — bounds idempotent re-confirmation. */
  issueCreatedAt?: string;

  // ── ticket 09: conversation state (optional; the write path never reads it) ──
  /**
   * The gate's captured field values + ask counts for this chat's conversation.
   * Opaque to the write path; the conversation engine owns it. (The variant key
   * and per-field question counts live here so ask-back budgets survive turns.)
   */
  record?: {
    variant: string;
    values: Record<string, string>;
    questionCount: Record<string, number>;
    explicitlyMissing: string[];
  };
  /** Priority evidence accumulated across turns (never downgraded). */
  evidence?: Record<string, unknown>;
  /**
   * A write to an EXISTING ticket awaiting the reporter's confirm button
   * (ADR-0008). Set when a preview is shown; cleared on confirm/cancel.
   */
  pendingTicketAction?: {
    kind: "append" | "edit" | "move" | "suggest" | "cancel_ticket" | "close_ticket";
    identifier: string;
    issueId?: number;
    content?: string;
    message?: string;
    mediaPaths?: string[];
    instruction?: string;
    from?: string;
    lead?: string;
    alternatives?: Array<{ identifier: string; issueId: number; title?: string }>;
    edit?: {
      baseTitle: string;
      baseDescription: string;
      title: string;
      description: string;
      changes: Array<{ what: string; before: string; after: string }>;
    };
    /** The exact button label the reporter must send to execute it. */
    confirmLabel: string;
    askedAt?: string;
  };
  /**
   * A conflicting-identifier or full-report park (TECH-928 / E2E 28/09): this
   * message would have been silently merged, so it is held and the reporter is
   * asked "new incident or append?". `docId` of the draft that was parked.
   */
  parkedDocId?: string;
  /** The held message/fields that triggered a park, replayed if "new incident". */
  parkedPayload?: { text: string; mediaPaths: string[] };
  /** Unrecognized department name if mentioned but not in catalog (TECH-1146). */
  unrecognizedDept?: string;
  /** Danh sách triệu chứng đã gộp qua các lượt (B4). */
  symptoms?: string[];

  // ── draft v2 (RFC 0002 PR 4): trạng thái hội thoại mà legacy giữ ──────────
  /**
   * Trường vừa hỏi ở lượt trước — để biết câu "không biết" là trả lời cho
   * trường nào (A13).
   */
  lastAskedFields?: string[];
  /**
   * Người báo xin mức ưu tiên kèm lý do (quyết định 29/09): có lý do thì cho
   * đúng mức xin, không hạ mức bằng chứng.
   */
  requestedPriority?: { level: "high" | "urgent"; reason?: string };
  /** Đã soát tờ khai bằng cổng dữ kiện kỹ thuật (chỉ một lần). */
  techReviewDone?: boolean;
  /** Câu hỏi dữ kiện kỹ thuật vừa hỏi — tin kế tiếp là câu trả lời. */
  techQuestion?: string;
  /** Báo cáo nhiều sự cố đang chờ chọn "tách" hay "gộp 1 ticket" (W29-SPLIT). */
  pendingSplit?: PendingSplit;
  /** Các khối sự cố chờ tạo lần lượt sau khi sự cố hiện tại tạo xong. */
  pendingSplitQueue?: SplitBlock[];
  /** Ảnh đính kèm chung cho nhiều sự cố — mô tả phải nói rõ (W29-SPLIT). */
  mediaAmbiguous?: boolean;
  /** Tin đang chờ chọn "sự cố mới" hay "bổ sung" (định danh xung đột). */
  pendingNewIncident?: PendingNewIncident;
  /**
   * Dấu của VIỆC NỀN (tra ticket tương tự, KG…) — để không chạy lặp lại cho
   * cùng một tờ khai.
   */
  backgroundWork?: { kind: string; startedAt: string; finishedAt?: string };

  createdAt: string;
  updatedAt: string;
}

/** A blank draft at revision 1 for a fresh chat. */
export function newDraft(docId: string, chatId: string, nowIso: string): IntakeDraft {
  return {
    docId,
    chatId,
    revision: 1,
    status: "collecting",
    version: DRAFT_VERSION,
    ticket: { title: "", rawText: "", priority: "medium", mediaPaths: [] },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
