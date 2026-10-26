/**
 * Draft v2 — hình dạng tờ khai có phiên bản (RFC 0002 PR 4, mục 2.1).
 *
 * Bản 1 (tờ khai của core trước PR 4) chỉ giữ phần đường ghi: chữ nguyên văn,
 * trường đã gom, mốc thời gian xác nhận và con trỏ ticket đã tạo. Bản 2 bổ sung
 * các trường hội thoại mà legacy giữ (`lastAskedFields`, `requestedPriority`,
 * `techReviewDone`/`techQuestion`, `unrecognizedDept`, `pendingSplit` kèm hàng
 * đợi, `mediaAmbiguous`, `pendingNewIncident`, dấu việc nền).
 *
 * Nguyên tắc: **cộng thêm, có phiên bản**. Đọc tờ khai cũ thì MIGRATE LÚC ĐỌC
 * (không viết lại kho), tờ khai mới thì ghi đủ phiên bản hiện hành. Tờ khai đọc
 * từ kho có phiên bản mới hơn thì giữ nguyên — không hạ cấp dữ liệu của bot
 * đã nâng cấp.
 *
 * NGUỒN: legacy `lib/intake-document/types.ts` (`IntakeDocument`) — các trường
 * `lastAskedFields`, `requestedPriority`, `techReviewDone`, `techQuestion`,
 * `unrecognizedDept`, `pendingSplit`, `pendingSplitQueue`, `mediaAmbiguous`,
 * `pendingNewIncident`, `kgAdvice`/`kgChecked` (dấu việc nền).
 */
import type { IntakeDraft, DraftStatus, DraftTicket } from "./types";

/** Phiên bản hình dạng tờ khai hiện hành. */
export const DRAFT_VERSION = 2;

/** Điền phần ticket cho tờ khai cũ thiếu trường. */
function migrateTicket(raw: unknown): DraftTicket {
  const ticket = (
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}
  ) as Partial<DraftTicket>;
  const priority = ticket.priority;
  return {
    ...ticket,
    title: typeof ticket.title === "string" ? ticket.title : "",
    rawText: typeof ticket.rawText === "string" ? ticket.rawText : "",
    priority:
      priority === "urgent" || priority === "high" || priority === "medium" || priority === "low"
        ? priority
        : "medium",
    mediaPaths: Array.isArray(ticket.mediaPaths)
      ? ticket.mediaPaths.filter((p): p is string => typeof p === "string")
      : [],
  };
}

/**
 * Nâng một tờ khai bất kỳ lên hình dạng hiện hành.
 *
 * - `null` khi dữ liệu không phải tờ khai (JSON hỏng, sai hình dạng).
 * - Tờ khai đã ở phiên bản mới hơn thì GIỮ NGUYÊN (không hạ cấp).
 * - Hàm idempotent: nâng hai lần cho cùng kết quả.
 */
export function migrateDraft(value: unknown): IntakeDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Partial<IntakeDraft>;

  const docId = typeof raw.docId === "string" ? raw.docId : "";
  const chatId = typeof raw.chatId === "string" ? raw.chatId : "";
  if (!docId || !chatId) return null;

  const version = typeof raw.version === "number" ? raw.version : 1;
  const status = raw.status;
  const draft: IntakeDraft = {
    ...raw,
    docId,
    chatId,
    revision: typeof raw.revision === "number" ? raw.revision : 1,
    status:
      status === "collecting" ||
      status === "ready_for_confirmation" ||
      status === "confirmed" ||
      status === "created" ||
      status === "canceled" ||
      status === "expired"
        ? status
        : "collecting",
    ticket: migrateTicket(raw.ticket),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };

  if (version > DRAFT_VERSION) {
    // Bản mới hơn: không biết trường nào của nó — giữ nguyên, không hạ cấp.
    return { ...draft, version };
  }

  return {
    ...draft,
    version: DRAFT_VERSION,
    lastAskedFields: Array.isArray(draft.lastAskedFields) ? draft.lastAskedFields : [],
    techReviewDone: draft.techReviewDone === true,
    mediaAmbiguous: draft.mediaAmbiguous === true,
    pendingSplitQueue: Array.isArray(draft.pendingSplitQueue) ? draft.pendingSplitQueue : [],
    evidence: draft.evidence ?? {},
  };
}

/** `true` khi tờ khai đã ở hình dạng hiện hành. */
export function isCurrentDraft(draft: IntakeDraft): boolean {
  return (draft.version ?? 1) === DRAFT_VERSION;
}
