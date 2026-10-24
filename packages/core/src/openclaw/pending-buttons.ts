/**
 * Hợp đồng FILE NÚT BẤM có kiểu — nơi plugin OpenClaw và MCP server trao nhau bộ
 * nút Telegram để đính vào tin outbound.
 *
 * Nguồn: `intake-agents/intake/lib/telegram/buttons.ts`
 * (`savePendingButtons`/`clearPendingButtons`/`dropUnsendable`). KHÁC bản gốc:
 * thư mục do NGƯỜI GỌI truyền vào (thay đường cứng `~/.vhbot/iris-nut-bam/`), và
 * cảnh báo khi loại nút đi qua callback TIÊM VÀO (thay `alertAdmin` gắn cứng).
 *
 * GIỮ NGUYÊN luật phòng thủ của Tiểu Linh: Telegram KHÔNG bỏ riêng một nút hỏng —
 * nó trả `400 BUTTON_DATA_INVALID` và BỎ CẢ TIN NHẮN. Người dùng thấy bot im,
 * không thấy thiếu nút. Nên ở cửa cuối, loại một nút `callback_data` quá dài còn
 * tốt hơn mất cả câu trả lời.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Trần kích thước `callback_data` của Telegram Bot API: 1–64 BYTE (không phải ký
 * tự). Nguồn: `intake/lib/gate/types.ts` `MAX_CALLBACK_DATA_BYTES`.
 */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** Một nút Telegram ở dạng dây. Khớp `TelegramButton` của `buttons.ts`. */
export interface TelegramButton {
  text: string;
  callback_data: string;
}

/** Nội dung file nút chờ. `ts` để plugin bỏ bộ nút quá cũ (nguồn: cửa 90s ở iris). */
export interface PendingButtonsFile {
  buttons: TelegramButton[][];
  ts: number;
}

/** Nhận cảnh báo khi có nút bị loại — TIÊM VÀO thay `alertAdmin` gắn cứng. */
export type ButtonDropAlert = (reason: string) => void;

export interface PendingButtonsOptions {
  /** Thư mục chứa file nút — NGƯỜI GỌI truyền (thay `~/.vhbot/iris-nut-bam/`). */
  dir: string;
  /** Cảnh báo khi loại nút quá dài. Mặc định im lặng. */
  onDrop?: ButtonDropAlert;
  /** Đồng hồ, tiêm vào để test cố định `ts`. */
  now?: () => number;
}

/** Chỉ giữ chữ số của id Telegram — khớp `String(id).replace(/[^0-9]/g, "")` bản gốc. */
export function normalizeTelegramId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const tid = String(id).replace(/[^0-9]/g, "");
  return tid || null;
}

/**
 * Cửa cuối trước khi nút ra Telegram: loại nút có `callback_data` quá
 * `MAX_CALLBACK_DATA_BYTES` byte, và loại luôn hàng rỗng sau khi lọc.
 *
 * Giữ nguyên hành vi `dropUnsendable`: gom tất cả nút bị loại rồi cảnh báo MỘT
 * lần (nhãn ngắn phải khai ở nơi dựng catalog), không ném.
 */
export function dropUnsendableButtons(
  buttons: TelegramButton[][],
  onDrop?: ButtonDropAlert,
): TelegramButton[][] {
  const rejected: string[] = [];
  const kept = buttons
    .map((row) =>
      row.filter((btn) => {
        const bytes = Buffer.byteLength(btn.callback_data, "utf8");
        if (bytes <= MAX_CALLBACK_DATA_BYTES) return true;
        rejected.push(`${btn.callback_data} (${bytes} byte)`);
        return false;
      }),
    )
    .filter((row) => row.length > 0);

  if (rejected.length > 0 && onDrop) {
    onDrop(
      `Đã loại ${rejected.length} nút vì callback_data quá ${MAX_CALLBACK_DATA_BYTES} byte — ` +
        `để nguyên thì Telegram từ chối CẢ tin nhắn và bot sẽ im lặng. ` +
        `Khai nhãn ngắn. Nút bị loại: ${rejected.join("; ")}`,
    );
  }
  return kept;
}

/** Đường file nút của một id trong thư mục đã cho. */
function fileFor(dir: string, tid: string): string {
  return join(dir, `${tid}.json`);
}

/**
 * Ghi bộ nút chờ cho `telegramId`. Lọc nút không gửi được TRƯỚC khi ghi; không
 * còn nút nào ⇒ XOÁ file (khớp bản gốc: bộ rỗng thì bỏ file để không đính nút cũ).
 *
 * Trả về số HÀNG đã ghi (0 = đã xoá/không ghi) để test và caller biết kết quả.
 * Lỗi ghi đĩa ⇒ cảnh báo qua `onDrop` và trả 0 — KHÔNG ném (hỏng ở đây là "nút
 * biến mất", người dùng thấy câu hỏi cụt; không được làm hỏng luồng chính).
 */
export function savePendingButtons(
  telegramId: string | number | null | undefined,
  buttons: TelegramButton[][] | null | undefined,
  opts: PendingButtonsOptions,
): number {
  const tid = normalizeTelegramId(telegramId);
  if (!tid) return 0;

  const now = opts.now ?? Date.now;
  try {
    mkdirSync(opts.dir, { recursive: true });
    const filePath = fileFor(opts.dir, tid);
    const sendable = buttons ? dropUnsendableButtons(buttons, opts.onDrop) : null;
    if (sendable && sendable.length > 0) {
      const payload: PendingButtonsFile = { buttons: sendable, ts: now() };
      writeFileSync(filePath, JSON.stringify(payload), "utf8");
      return sendable.length;
    }
    if (existsSync(filePath)) rmSync(filePath, { force: true });
    return 0;
  } catch (err) {
    opts.onDrop?.(
      `Không ghi được file nút tạm cho ${tid}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Người dùng sẽ thấy câu hỏi cụt, không có nút bấm.`,
    );
    return 0;
  }
}

/**
 * Đọc bộ nút chờ của `telegramId`. Không có file / JSON hỏng / sai cấu trúc ⇒
 * null (đọc nút là đường phụ, hỏng thì coi như không có nút, không ném).
 */
export function readPendingButtons(
  telegramId: string | number | null | undefined,
  opts: Pick<PendingButtonsOptions, "dir">,
): PendingButtonsFile | null {
  const tid = normalizeTelegramId(telegramId);
  if (!tid) return null;
  const filePath = fileFor(opts.dir, tid);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!data || typeof data !== "object") return null;
    const buttons = (data as PendingButtonsFile).buttons;
    const ts = (data as PendingButtonsFile).ts;
    if (!Array.isArray(buttons) || typeof ts !== "number") return null;
    return { buttons, ts };
  } catch {
    return null;
  }
}

/** Xoá bộ nút chờ (ticket đã tạo xong / luồng kết thúc). Không có file ⇒ no-op. */
export function clearPendingButtons(
  telegramId: string | number | null | undefined,
  opts: Pick<PendingButtonsOptions, "dir">,
): void {
  const tid = normalizeTelegramId(telegramId);
  if (!tid) return;
  const filePath = fileFor(opts.dir, tid);
  try {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  } catch {
    /* xoá hỏng thì kệ — không làm hỏng luồng chính */
  }
}
