/**
 * Tool failures, turned into something the end user can read and screenshot,
 * and something the operators can trace.
 *
 * A tool that throws leaves the model free to say whatever it likes — some
 * turns it goes silent, some turns it says "đang xử lý ạ" while the call has in
 * fact failed. So a failure is turned into a normal tool result carrying a
 * `loi: true` flag plus a short code the operators can find in the log: a
 * screenshot with no code still has to be guessed at.
 *
 * MERGED (0.1.0):
 *  - signature + shape (`describeToolFailure`, `ToolFailure`, raw detail echoed
 *    into `thong_bao_cho_nguoi_dung`) come from INTAKE (the reference) so Tiểu
 *    Linh's call sites and tests are unchanged.
 *  - stable error codes (`CodedError`, `errorCodeFor`) come from CM: an error
 *    that declares `code: "E_TICKET_RATE_LIMITED"` keeps it as `ma_loi`.
 *  - the admin alert is now an INJECTED hook (`setToolFailureAlert`) — the
 *    library imports no Telegram. intake's `alertAdmin` call is wired in by the
 *    host at startup.
 */
import { getLogger } from "./logger";

export interface ToolFailure {
  /** Cờ để prompt và client nhận ra: thấy `loi: true` thì gửi nguyên văn thông báo. */
  loi: true;
  ma_loi: string;
  thong_bao_cho_nguoi_dung: string;
  /** Diễn giải kỹ thuật cho người đọc log — không phải thứ bot nói với người dùng. */
  chi_tiet: string;
}

/**
 * Lỗi nghiệp vụ có mã ổn định (CM). Lỗi mang `code` dạng chữ (vd
 * `E_TICKET_RATE_LIMITED`) được giữ nguyên làm `ma_loi`; lỗi khác dùng mã ngẫu
 * nhiên sinh theo thời điểm.
 */
export interface CodedError {
  code: string;
}

/** Hook báo admin được tiêm từ host — thư viện không import Telegram. */
export type ToolFailureAlert = (key: string, message: string) => void;

let alertHook: ToolFailureAlert | null = null;

/**
 * Tuỳ chọn hiển thị lỗi, cài một lần lúc khởi động.
 *
 * `hideDetailFromUser` (B3, bản vá của CM): mặc định `false` — giữ hành vi của
 * intake, tức ghép dòng `Chi tiết: <diễn giải kỹ thuật>` vào tin nhắn người dùng.
 * Bật `true` thì BỎ dòng đó khỏi tin nhắn — người dùng chỉ thấy mã lỗi và lời dặn
 * chụp màn hình, không thấy chuỗi kỹ thuật (vd "Itsaplan 503", tên bảng, stack).
 * `chi_tiet` và dòng log vẫn giữ nguyên để kỹ thuật tra ngược theo mã.
 */
export interface ToolFailureOptions {
  hideDetailFromUser: boolean;
}

let options: ToolFailureOptions = { hideDetailFromUser: false };

/** Cài tuỳ chọn hiển thị lỗi (vd bật ẩn chi tiết kỹ thuật khỏi người dùng). */
export function setToolFailureOptions(next: Partial<ToolFailureOptions>): void {
  options = { ...options, ...next };
}

/** Đọc tuỳ chọn hiện tại (chủ yếu cho test). */
export function getToolFailureOptions(): ToolFailureOptions {
  return { ...options };
}

/**
 * Cài hook báo admin. Host (vd Tiểu Linh) gọi một lần lúc khởi động:
 * `setToolFailureAlert((key, msg) => alertAdmin(key, msg))`. Không cài thì
 * `describeToolFailure` vẫn ghi log và trả kết quả như thường, chỉ không báo.
 */
export function setToolFailureAlert(fn: ToolFailureAlert | null): void {
  alertHook = fn;
}

/**
 * Mã ngắn, viết hoa, đủ để tra ngược trong log. Lấy theo thời điểm nên hai lỗi
 * cách nhau vài mili giây vẫn khác mã, và đọc qua điện thoại vẫn được.
 */
export function newErrorCode(now: number = Date.now()): string {
  return now.toString(36).slice(-6).toUpperCase();
}

/** Mã ổn định nếu lỗi tự khai `code`, không thì mã ngẫu nhiên để tra log. */
export function errorCodeFor(err: unknown, now?: number): string {
  const declared = (err as Partial<CodedError> | null)?.code;
  if (typeof declared === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(declared)) {
    return declared;
  }
  return newErrorCode(now);
}

/** Cắt cho vừa một tin nhắn chat — người ta chụp màn hình chứ không đọc stack. */
function shorten(message: string, max = 300): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Biến một lỗi ném ra thành kết quả tool bình thường, có nội dung nói được với
 * người dùng. Cố tình KHÔNG ném tiếp: ném thì model lại được tự do diễn giải.
 */
export function describeToolFailure(toolName: string, err: unknown, now?: number): ToolFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const code = errorCodeFor(err, now);
  const detail = shorten(raw);

  getLogger().error(`[tool:${toolName}] lỗi ${code}: ${raw}`);
  alertHook?.(`tool-loi-${toolName}`, `Tool \`${toolName}\` lỗi (mã ${code}): ${detail}`);

  const detailLine = options.hideDetailFromUser ? "" : `Chi tiết: ${detail}\n`;

  return {
    loi: true,
    ma_loi: code,
    chi_tiet: detail,
    thong_bao_cho_nguoi_dung:
      `⚠️ Dạ em gặp lỗi nên chưa xử lý xong bước này được ạ.\n\n` +
      `Mã lỗi: ${code}\n` +
      detailLine +
      `\nAnh/chị chụp màn hình tin nhắn này gửi vào nhóm kỹ thuật giúp em nhé ạ. ` +
      `Nội dung anh/chị vừa nhắn em vẫn giữ, không phải kể lại từ đầu đâu ạ.`,
  };
}
