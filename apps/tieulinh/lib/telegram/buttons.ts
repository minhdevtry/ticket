import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "@vuihoc/bot-core/core";
import { alertAdmin } from "./alert";
import { MAX_CALLBACK_DATA_BYTES, type InlineButton } from "../gate/types";

export interface TelegramButton {
  text: string;
  callback_data: string;
}

/** Chuyển hàng nút channel-agnostic của `lib/gate/buttons.ts` sang định dạng dây Telegram. */
export function toTelegramButtons(rows: InlineButton[][]): TelegramButton[][] {
  return rows.map((row) => row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })));
}

const BUTTONS_DIR = path.join(os.homedir(), ".vhbot", "iris-nut-bam");

/**
 * Cửa cuối trước khi nút ra Telegram: loại nút nào Telegram sẽ từ chối.
 *
 * Telegram không bỏ riêng nút hỏng — nó trả `400 BUTTON_DATA_INVALID` và
 * **không gửi cả tin nhắn**. Người dùng thấy bot im, không thấy thiếu nút.
 * Nên ở đây mất một nút luôn tốt hơn mất cả câu trả lời.
 *
 * `assertCatalogIntegrity` đã chặn từ lúc dựng catalog, nhưng chỉ chặn được
 * nút sinh ra TỪ catalog. Chặn thêm ở đây để phủ mọi đường còn lại — nút xác
 * nhận, nút chọn nhánh, và bất kỳ đường nào thêm về sau.
 */
function dropUnsendable(buttons: TelegramButton[][]): TelegramButton[][] {
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

  if (rejected.length > 0) {
    alertAdmin(
      "callback-data-qua-dai",
      `Đã loại ${rejected.length} nút vì callback_data quá ${MAX_CALLBACK_DATA_BYTES} byte — ` +
        `để nguyên thì Telegram từ chối CẢ tin nhắn và bot sẽ im lặng. ` +
        `Khai nhãn ngắn trong \`_nhan_nut\`. Nút bị loại: ${rejected.join("; ")}`,
    );
  }
  return kept;
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
  if (!telegramId) return;
  const tid = String(telegramId).replace(/[^0-9]/g, "");
  if (!tid) return;

  try {
    fs.mkdirSync(BUTTONS_DIR, { recursive: true });
    const filePath = path.join(BUTTONS_DIR, `${tid}.json`);
    const sendable = buttons ? dropUnsendable(buttons) : null;
    if (sendable && sendable.length > 0) {
      fs.writeFileSync(filePath, JSON.stringify({ buttons: sendable, ts: Date.now() }), "utf-8");
    } else {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    // Không để lỗi ghi file tạm ảnh hưởng luồng chính — nhưng hỏng ở đây là
    // NÚT BIẾN MẤT, mà nút biến mất thì người dùng chỉ thấy một câu hỏi cụt.
    alertAdmin(
      "ghi-file-nut-hong",
      `Không ghi được file nút tạm cho ${tid}: ${err}. Người dùng sẽ thấy câu hỏi cụt, không có nút bấm.`,
    );
  }
}

/**
 * Xóa bộ nút bấm tạm thời (khi ticket đã tạo thành công hoặc luồng kết thúc)
 */
export function clearPendingButtons(telegramId?: string | number | null): void {
  if (!telegramId) return;
  const tid = String(telegramId).replace(/[^0-9]/g, "");
  if (!tid) return;

  try {
    const filePath = path.join(BUTTONS_DIR, `${tid}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    getLogger().warn(`Không xoá được file nút tạm cho ${tid}: ${err}`);
  }
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
