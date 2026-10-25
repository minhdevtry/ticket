import type { GoldenAllow, GoldenField } from "../../testing";

/**
 * Chỗ engine hiện tại được phép lệch bản ghi vàng của lễ tân legacy. Mỗi nhóm nói vì sao lệch và
 * PR nào (theo RFC 0002 mục 5) sẽ xoá nó. Quy tắc:
 *
 * - Lệch KHÔNG có trong danh sách làm test đỏ (hồi quy hoặc lệch mới).
 * - Dòng trong danh sách mà không còn lệch nữa cũng làm test đỏ: PR làm engine khớp phải XOÁ dòng,
 *   để danh sách chỉ co lại. Dòng đứng trước thắng dòng đứng sau khi cùng khớp.
 *
 * Hiện `action` khớp ở mọi lượt trừ một chỗ (huỷ); phần còn lại là chữ và nút.
 */

/** `{ kịch-bản: [số lượt] }`: số lượt đếm từ 1. */
type Turns = Record<string, number[]>;

const at = (field: GoldenField, turns: Turns, reason: string): GoldenAllow[] =>
  Object.entries(turns).flatMap(([scenario, list]) =>
    list.map((turn) => ({ scenario, turn, field, reason })),
  );

export const GOLDEN_ALLOWLIST: GoldenAllow[] = [
  // ── action ──────────────────────────────────────────────────────────────────
  ...at(
    "action",
    { "cancel-then-new": [5] },
    "A9: engine huỷ tờ khai nhưng trả `chitchat` không kèm tin; legacy trả `canceled` (PR 4 thêm kết quả `canceled` và ánh xạ, PR 8 dọn trạng thái)",
  ),

  // ── voiceText ───────────────────────────────────────────────────────────────
  ...at(
    "voiceText",
    { "cancel-then-new": [5] },
    "A9: engine không nói gì khi huỷ (messages rỗng); legacy báo đã huỷ (PR 4)",
  ),
  {
    scenario: "*",
    turn: "*",
    field: "voiceText",
    reason:
      "Chữ: engine dùng chữ thử tiếng Anh và mẫu tóm tắt chung; chữ, câu hỏi và mẫu tóm tắt tiếng Việt của Tiểu Linh vào ở PR 7 (câu hỏi) và PR 14 (CopyCatalog, mẫu tóm tắt)",
  },

  // ── buttons ─────────────────────────────────────────────────────────────────
  ...at(
    "buttons",
    {
      "cancel-then-new": [1, 2, 6],
      "double-click": [1],
      "expiry-24h": [1, 2],
      "first-ok": [1, 2],
      "premature-confirm": [1],
      "ticket-creation": [1],
    },
    "A1: câu hỏi trường thiếu không kèm nút chọn (legacy kèm nút bộ phận); `StepOutput` có nút cho câu hỏi ở PR 4, nút theo trường ở PR 7",
  ),
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
    "A7: xác nhận tới quá sớm, legacy gửi lại nút xác nhận kèm lời nhắc; engine chỉ nhắc bằng chữ (PR 4)",
  ),
];
