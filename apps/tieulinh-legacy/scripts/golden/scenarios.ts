/**
 * Kịch bản của bản ghi vàng (RFC 0002 mục 5, PR 2): chỉ là DỮ LIỆU, không import code legacy, nên
 * engine mới đọc lại được cùng đầu vào qua fixture JSON. Sáu kịch bản lấy từ
 * `lib/intake-step/pipeline.flow.test.ts`, giữ đúng thứ tự tin và dữ liệu tổng hợp của test gốc.
 *
 * `extract` là kết quả trích xuất ghim cho bộ trích xuất giả của engine mới (engine mới chưa có bộ
 * heuristic; PR 5 sẽ thay). Lúc ghi, `userIntent` của nó bị đối chiếu với bộ trích xuất thật của
 * legacy (xem `record.ts`), nên ghim không trôi khỏi hành vi legacy.
 *
 * Giá trị `values` theo catalog thử của engine: `van_de` (mô tả sự cố) và `bo_phan` (bộ phận người báo).
 */
import type { ExtractedFields } from "@vuihoc/bot-core/intake";

export interface ScenarioTurn {
  /** Đồng hồ đi thêm từng này ms trước lượt (mặc định 10 giây: người thật không bấm trong 5 giây). */
  advanceMs?: number;
  message: string;
  mediaPaths?: string[];
  extract: ExtractedFields;
}

export interface Scenario {
  scenario: string;
  description: string;
  /** Tên file test và tên test legacy mà kịch bản bắt nguồn. */
  source: string;
  turns: ScenarioTurn[];
}

/** Production dùng 5 giây (`MIN_CONFIRM_DELAY_MS`); mọi kịch bản chạy với giá trị đó. */
export const MIN_CONFIRM_DELAY_MS = 5_000;
/** Mốc đồng hồ ban đầu: 2026-01-01T00:00:00Z. */
export const START_MS = Date.UTC(2026, 0, 1);

const FLOW = "apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts";
const REPORT = "Lỗi app Duo học sinh 0900000005 không làm bài được";
const CRM = "CRM bị lỗi 500 khi mở đơn hàng của phụ huynh 0900000014";

const report = (): ExtractedFields => ({
  userIntent: "report_issue",
  title: "Lỗi app Duo không làm bài được",
  symptoms: ["không làm bài được"],
  identifiers: { studentAccount: "0900000005" },
  values: { van_de: "không làm bài được" },
});
const crm = (): ExtractedFields => ({
  userIntent: "report_issue",
  title: "CRM lỗi 500 khi mở đơn hàng",
  symptoms: ["lỗi 500 khi mở đơn hàng"],
  identifiers: { studentAccount: "0900000014" },
  values: { van_de: "lỗi 500 khi mở đơn hàng" },
});
const dept = (bo_phan: string): ExtractedFields => ({
  userIntent: "provide_info",
  symptoms: [],
  values: { bo_phan },
});
const confirm = (): ExtractedFields => ({ userIntent: "confirm" });

const toSummary = [
  { message: REPORT, extract: report() },
  { message: "Em bên Vận hành nhé", extract: dept("Vận hành") },
];

export const SCENARIOS: Scenario[] = [
  {
    scenario: "premature-confirm",
    description:
      "Model tự bấm xác nhận 1,1 giây sau tóm tắt: không tạo ticket. Người thật xác nhận sau đó thì tạo (bug 24/09).",
    source: `${FLOW}: "xác nhận tới ngay sau tóm tắt (model tự gọi) KHÔNG tạo ticket; người thật xác nhận sau đó thì tạo"`,
    turns: [
      ...toSummary,
      { advanceMs: 1_100, message: "đúng rồi", extract: confirm() },
      { advanceMs: 8_000, message: "đúng rồi", extract: confirm() },
    ],
  },
  {
    scenario: "first-ok",
    description:
      '"ok" khi tài liệu chưa từng được tóm tắt không tạo ticket (bug 3: xác nhận nhầm).',
    source: `${FLOW}: "'ok' khi tài liệu chưa từng được tóm tắt không tạo ticket"`,
    turns: [
      { message: REPORT, extract: report() },
      { message: "ok", extract: confirm() },
    ],
  },
  {
    scenario: "ticket-creation",
    description: "Báo sự cố, trả lời bộ phận, nhận tóm tắt, bấm xác nhận: tạo đúng một ticket.",
    source: `${FLOW}: "tạo ticket: có binding, dọn bản nháp, nút xác nhận hiện lúc tóm tắt và bị xoá sau khi tạo"`,
    turns: [...toSummary, { message: "đúng rồi", extract: confirm() }],
  },
  {
    scenario: "double-click",
    description:
      "Bấm xác nhận lần hai ngay sau khi đã tạo: không tạo thêm ticket, trả lại ticket cũ.",
    source: `${FLOW}: "xác nhận lần hai: không tạo thêm, không comment rác"`,
    turns: [
      ...toSummary,
      { message: "đúng rồi", extract: confirm() },
      { advanceMs: 1_000, message: "đúng rồi", extract: confirm() },
    ],
  },
  {
    scenario: "cancel-then-new",
    description:
      "Huỷ giữa chừng, rồi tin sau mở tờ khai mới và vẫn nhớ thông tin các lượt sau (bug 2).",
    source: `${FLOW}: "sau khi huỷ, lượt tiếp theo mở tài liệu mới và KHÔNG quên thông tin các lượt sau"`,
    turns: [
      { message: REPORT, extract: report() },
      ...[1, 2, 3].map(() => ({
        message: "máy iPad iOS 17",
        extract: { userIntent: "provide_info", symptoms: ["máy iPad iOS 17"] } as ExtractedFields,
      })),
      { message: "thôi hủy đi em", extract: { userIntent: "cancel" } },
      { message: CRM, extract: crm() },
      { message: "Em bên Sale ạ", extract: dept("Sale") },
    ],
  },
  {
    scenario: "expiry-24h",
    description: "Tờ khai im lặng quá 24 giờ hết hạn; tin mới mở tờ khai mới, không dính tin cũ.",
    source: `${FLOW}: "bản nháp im lặng quá 24h hết hạn, tin mới mở tài liệu mới"`,
    turns: [
      { message: REPORT, extract: report() },
      { advanceMs: 25 * 3_600_000, message: "CRM bị lỗi 500 khi mở đơn hàng", extract: crm() },
    ],
  },
];
