import type { GoldenAllow, GoldenField } from "../../testing";

/**
 * Chỗ engine hiện tại được phép lệch bản ghi vàng của lễ tân legacy. Mỗi nhóm nói vì sao lệch và
 * PR nào (theo RFC 0002 mục 5) sẽ xoá nó. Quy tắc:
 *
 * - Lệch KHÔNG có trong danh sách làm test đỏ (hồi quy hoặc lệch mới).
 * - Dòng trong danh sách mà không còn lệch nữa cũng làm test đỏ: PR làm engine khớp phải XOÁ dòng,
 *   để danh sách chỉ co lại. Dòng đứng trước thắng dòng đứng sau khi cùng khớp.
 *
 * PR 4 bỏ lệch `action` ở lượt huỷ (kết quả `canceled` khớp hành vi legacy), nên
 * `action` hiện khớp 100% các lượt; phần còn lại là chữ và nút.
 */

/** `{ kịch-bản: [số lượt] }`: số lượt đếm từ 1. */
type Turns = Record<string, number[]>;

const at = (field: GoldenField, turns: Turns, reason: string): GoldenAllow[] =>
  Object.entries(turns).flatMap(([scenario, list]) =>
    list.map((turn) => ({ scenario, turn, field, reason })),
  );

export const GOLDEN_ALLOWLIST: GoldenAllow[] = [
  // ── voiceText ───────────────────────────────────────────────────────────────
  ...at(
    "voiceText",
    { "cancel-then-new": [5] },
    "A9: engine đã báo đã huỷ (PR 4 thêm kết quả `canceled` và câu chữ), còn khác chữ tiếng Việt của legacy (PR 14 đưa CopyCatalog của Tiểu Linh)",
  ),
  {
    scenario: "*",
    turn: "*",
    field: "voiceText",
    reason:
      "Chữ: engine dùng chữ thử tiếng Anh và mẫu tóm tắt chung; chữ, câu hỏi và mẫu tóm tắt tiếng Việt của Tiểu Linh vào ở PR 7 (câu hỏi) và PR 14 (CopyCatalog, mẫu tóm tắt)",
  },

  ...at(
    "buttons",
    {
      "cancel-then-new": [3, 4, 7],
      "double-click": [2],
      "premature-confirm": [2],
      "ticket-creation": [2],
    },
    "Nút xác nhận: legacy là `✅ Đúng rồi, tạo ticket` với callbackData `đúng rồi`; engine dùng nhãn chữ thử làm cả callbackData (PR 14 đưa nhãn tiếng Việt; PR 4 chốt quy ước callbackData)",
  ),
  ...at(
    "buttons",
    { "premature-confirm": [3] },
    "A7: xác nhận tới quá sớm thì engine đã gửi lại nút xác nhận kèm lời nhắc (PR 4); còn khác nhãn nút tiếng Việt của legacy (PR 14)",
  ),
];
