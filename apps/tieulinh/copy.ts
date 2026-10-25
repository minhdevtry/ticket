/**
 * Lời của Tiểu Linh với người báo (tiếng Việt). Logic không chứa chuỗi hiển thị: mọi câu nằm ở
 * đây và được tiêm vào `TicketClosure` / dispatcher.
 */
import type { ReporterOkCopy } from "@vuihoc/bot-core/backoffice";
import type { StateChangeCopyMap } from "@vuihoc/bot-core/intake";

/** Nhãn nút và tiền tố callback của nút "Đã ổn" (ADR-0006: nút chỉ ghi comment). */
export const REPORTER_OK_LABEL = "👍 Đã ổn";
export const REPORTER_OK_PREFIX = "reporter_ok:";

export const reporterOkCallback = (issueId: number): string => `${REPORTER_OK_PREFIX}${issueId}`;

export const stateCopy: StateChangeCopyMap = {
  describe: ({ state, columnName, identifier }) => {
    switch (state) {
      case "resolved":
        return `Ticket ${identifier} đã được xử lý. Anh/chị kiểm tra giúp em; nếu ổn thì bấm nút dưới đây, còn chưa ổn thì cứ nhắn lại vào tin này ạ.`;
      case "done":
        return `Ticket ${identifier} đã hoàn tất.`;
      case "canceled":
        return `Ticket ${identifier} đã được huỷ.`;
      default:
        return `${identifier} chuyển sang: "${columnName}"`;
    }
  },
};

/** Giờ Việt Nam dạng `25/10/2026 14:05`. */
export function vnTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}/${p("month")}/${p("year")} ${p("hour")}:${p("minute")}`;
}

export const reporterOkCopy: ReporterOkCopy = {
  comment: ({ who, time }) => `**${who}** phản hồi: đã ổn (${time}).`,
  ack: () => "Dạ em đã ghi nhận, chuyên viên sẽ kiểm tra lại và đóng ticket ạ.",
  unknown: () => "Dạ em không tìm thấy ticket này ạ.",
  notYourChat: () => "Dạ nút này không thuộc cuộc trò chuyện của ticket ạ.",
  done: ({ identifier }) => `Dạ ticket ${identifier} đã hoàn tất rồi ạ.`,
  canceled: ({ identifier }) => `Dạ ticket ${identifier} đã được huỷ ạ.`,
  reopened: ({ identifier }) =>
    `Dạ ticket ${identifier} đang được xử lý lại, em sẽ báo anh/chị khi xong ạ.`,
};

/** Cảnh báo trực ca khi ticket quá hạn SLA mà chưa ai nhận. */
export function slaAlertText(v: {
  identifier: string;
  title: string;
  priority: string;
  slaHours: number;
  elapsedHours: number;
}): string {
  return (
    `[CẢNH BÁO SLA QUÁ HẠN] ${v.identifier}: ${v.title}\n` +
    `Mức ưu tiên ${v.priority.toUpperCase()} (cam kết ${v.slaHours}h), đã ${v.elapsedHours}h mà chưa có người nhận.`
  );
}

export function duplicateSuggestionText(v: { target: string; evidence: string }): string {
  return (
    `Gợi ý (bot chưa gộp gì): comment trên cho thấy ticket này có thể trùng với ${v.target}` +
    ` ("${v.evidence}"). Người xử lý xem lại và tự quyết định gộp hay giữ.`
  );
}

export function mergedFromText(v: { source: string; description: string }): string {
  return `🔀 Gộp từ ${v.source}\n\n${v.description}`;
}

export function mergedIntoText(v: { target: string }): string {
  return `Ticket này trùng với ${v.target} nên đã được gộp vào đó và huỷ. Mô tả gốc đã được chép sang ${v.target}.`;
}
