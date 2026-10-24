/**
 * Lỗi tool, dịch sang thứ người dùng cuối đọc được và chụp lại được.
 *
 * Trước đây tool ném lỗi thì model nhận một chuỗi stack rồi tự quyết định nói
 * gì — có lượt nó im luôn, có lượt nó nói "đang xử lý ạ" trong khi thật ra đã
 * hỏng. Người dùng ngồi chờ một thứ không bao giờ tới, và bên kỹ thuật không
 * có gì để lần.
 *
 * Team chốt 14/09/2026: "nếu có lỗi gì đó xảy ra thì truyền luôn lỗi cho
 * họ, họ sẽ chụp lại và gửi vào nhóm tôi". Nên lỗi phải ra tới màn hình, kèm
 * một mã tra được trong log — ảnh chụp mà không có mã thì vẫn phải đoán.
 */
import { getLogger } from "./logger";
import { alertAdmin } from "./telegram/alert";

export interface ToolFailure {
  /** Cờ để prompt nhận ra: thấy `loi: true` thì gửi nguyên văn thông báo. */
  loi: true;
  ma_loi: string;
  thong_bao_cho_nguoi_dung: string;
  chi_tiet: string;
}

/**
 * Mã ngắn, viết hoa, đủ để tra ngược trong log. Lấy theo thời điểm nên hai lỗi
 * cách nhau vài mili giây vẫn khác mã, và đọc qua điện thoại vẫn được.
 */
export function newErrorCode(now: number = Date.now()): string {
  return now.toString(36).slice(-6).toUpperCase();
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
  const code = newErrorCode(now);
  const detail = shorten(raw);

  getLogger().error(`[tool:${toolName}] lỗi ${code}: ${raw}`);
  alertAdmin(`tool-loi-${toolName}`, `Tool \`${toolName}\` lỗi (mã ${code}): ${detail}`);

  return {
    loi: true,
    ma_loi: code,
    chi_tiet: detail,
    thong_bao_cho_nguoi_dung:
      `⚠️ Dạ em gặp lỗi nên chưa xử lý xong bước này được ạ.\n\n` +
      `Mã lỗi: ${code}\n` +
      `Chi tiết: ${detail}\n\n` +
      `Anh/chị chụp màn hình tin nhắn này gửi vào nhóm kỹ thuật giúp em nhé ạ. ` +
      `Nội dung anh/chị vừa nhắn em vẫn giữ, không phải kể lại từ đầu đâu ạ.`,
  };
}
