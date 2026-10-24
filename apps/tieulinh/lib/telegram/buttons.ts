import * as os from "node:os";
import * as path from "node:path";
import type { InlineButton } from "@vuihoc/bot-core/intake";
import {
  type TelegramButton,
  clearPendingButtons as clearPendingButtonsIn,
  savePendingButtons as savePendingButtonsIn,
} from "@vuihoc/bot-core/telegram";
import { alertAdmin } from "./alert";

export type { TelegramButton };

/** Chuyển hàng nút channel-agnostic của `lib/gate/buttons.ts` sang định dạng dây Telegram. */
export function toTelegramButtons(rows: InlineButton[][]): TelegramButton[][] {
  return rows.map((row) => row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })));
}

const BUTTONS_DIR = path.join(os.homedir(), ".vhbot", "iris-nut-bam");

/**
 * Luật cuối trước khi nút ra Telegram (loại nút `callback_data` quá 64 byte —
 * Telegram từ chối CẢ tin nhắn nếu để lọt) nằm ở `savePendingButtons` của
 * `@vuihoc/bot-core/telegram`. Thư viện báo qua callback; ở đây nối vào
 * `alertAdmin` với hai khoá chống lặp riêng như trước: nút quá dài / ghi file hỏng.
 */
function alertButtonProblem(reason: string): void {
  const key = reason.startsWith("Không ghi được") ? "ghi-file-nut-hong" : "callback-data-qua-dai";
  alertAdmin(key, reason);
}

let lastActiveChatId: string | null = null;

export function setLastActiveChatId(id?: string | number | null): void {
  if (!id) return;
  const tid = String(id).replace(/[^0-9]/g, "");
  if (tid) lastActiveChatId = tid;
}

export function getLastActiveChatId(): string | null {
  return lastActiveChatId;
}

/**
 * Nút chọn nhánh ban đầu cho IRIS.
 */
export function getBranchButtons(): TelegramButton[][] {
  return [
    [
      { text: "📋 Order tính năng", callback_data: "Order tính năng" },
      { text: "💡 Đề xuất ý tưởng mới", callback_data: "Đề xuất ý tưởng mới" },
    ],
    [{ text: "🔍 Kiểm tra trạng thái ticket", callback_data: "Kiểm tra trạng thái ticket" }],
  ];
}

/**
 * Lưu bộ nút bấm tạm thời để plugin OpenClaw đính kèm vào tin nhắn outbound của Telegram.
 */
export function savePendingButtons(
  telegramId?: string | number | null,
  buttons?: TelegramButton[][] | null,
): void {
  savePendingButtonsIn(telegramId, buttons, { dir: BUTTONS_DIR, onDrop: alertButtonProblem });
}

/**
 * Xóa bộ nút bấm tạm thời (khi ticket đã tạo thành công hoặc luồng kết thúc)
 */
export function clearPendingButtons(telegramId?: string | number | null): void {
  clearPendingButtonsIn(telegramId, { dir: BUTTONS_DIR });
}

/**
 * Nút xác nhận ghi bản ghi. `callback_data` cố định "đúng rồi" — skill prompt
 * của cả hai bot đã coi đây là tín hiệu đồng ý, đừng đổi. Chỉ chữ hiển thị là
 * theo từng bot (Tiểu Linh: "tạo ticket", IRIS: "gửi Product team"...).
 */
export function getConfirmationButtons(label: string): TelegramButton[][] {
  return [[{ text: label, callback_data: "đúng rồi" }]];
}

export interface DepartmentOption {
  /** Chữ hiển thị trên nút — bot có thể thêm icon riêng vào đây. */
  label: string;
  /** Giá trị gửi về khi bấm — phải khớp nguyên văn giá trị enum của bot đó. */
  callbackData: string;
}

/**
 * Nút chọn nhanh phòng ban. Trước đây hard-code cứng đúng 5 trong 7 giá trị
 * của Tiểu Linh (thiếu "Vận đơn", "CSHV") và IRIS dùng chung thì ăn luôn bộ
 * phòng ban của Tiểu Linh — sai hẳn danh sách của IRIS. Giờ mỗi bot tự truyền
 * đúng danh sách của mình, một nguồn sự thật duy nhất (bảng enum của bot đó).
 */
export function getDepartmentButtons(options: DepartmentOption[]): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((o) => ({ text: o.label, callback_data: o.callbackData })),
    );
  }
  return rows;
}
