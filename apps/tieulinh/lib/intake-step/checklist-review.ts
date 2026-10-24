/**
 * Soát dữ kiện kiểu "hỏi hết một lượt": không LLM, không đoán xem kỹ thuật có cần hay
 * không. Mỗi sự cố đều cần ảnh màn hình, bước thao tác, mã/link định danh… nên cứ xin
 * hết những gì CHƯA có trong lời báo, gộp một tin. Người báo không có thì nhắn "không
 * có" (nút có sẵn ở pipeline), ticket vẫn được tạo.
 *
 * 16/10 (team): Tiểu Linh trước đây có hỏi ảnh màn hình và các dữ kiện này, bị gỡ
 * vì "phiền", giờ kỹ thuật viên phải tự hỏi lại người báo. Quay lại: hỏi hết, ngắn gọn,
 * không chọn A/B/C, cái nào không cấp thì thôi.
 *
 * Chỉ bỏ những thứ rõ ràng đã có (ảnh đính kèm, mã/link đã nằm trong lời báo hoặc
 * trường đã trích) và sự cố rõ ràng không thuộc TECH (chấm công, lương…) — loại đó
 * để các bước khác lo. Không hỏi nguyên nhân, không xin mật khẩu TeamViewer.
 *
 * Tự học (W25): các mục người báo hay phải bổ sung theo từng hệ thống (học từ bình
 * luận kỹ thuật viên, xem lib/ask-learning) được nối thêm vào CUỐI tin, trừ những mục
 * danh sách cố định đã hỏi/đã có sẵn. Không có mục học được thì kết quả y như cũ.
 */
import type { TechReviewer, TechReviewInput, TechReviewResult } from "./tech-review";
import { ASK_LINE, CHECKLIST_KEY_ITEMS, isCanonItem, type CanonItem } from "../ask-learning/items";

interface Item {
  /** Tên ngắn trong `missing` (log). */
  key: string;
  /** Dòng hỏi gửi người báo. */
  ask: string;
  /** Đã có sẵn thì khỏi hỏi. */
  have: (c: Ctx) => boolean;
  /** Chỉ hỏi với sự cố thuộc nhóm này (mặc định: mọi sự cố). */
  when?: (c: Ctx) => boolean;
}

interface Ctx {
  text: string;
  low: string;
  system: string;
  input: TechReviewInput;
}

const NOT_TECH = /chấm công|amis|vân tay|bảng lương|\blương\b|nhân sự|c&b/i;
const hasKnown = (c: Ctx, ...labels: string[]) =>
  labels.some((l) => (c.input.known[l] ?? "").trim() !== "");

const ITEMS: Item[] = [
  {
    key: "ảnh màn hình",
    ask: ASK_LINE.SCREENSHOT,
    have: (c) => c.input.attachments > 0,
  },
  {
    key: "link chi tiết CARE",
    ask: ASK_LINE.CARE_STUDENT_LINK,
    have: (c) => /se-care\.[\w.-]+\S*student-detail/i.test(c.text),
    when: (c) => /care/i.test(c.system) || /\bcare\b/i.test(c.text),
  },
  {
    key: "link contact CRM",
    ask: ASK_LINE.CRM_CONTACT_LINK,
    have: (c) => /se-crm\.[\w.-]+\S*(contact|detail)/i.test(c.text),
    when: (c) => /crm/i.test(c.system) || /\bcrm\b/i.test(c.text),
  },
  {
    key: "UID/link LMS",
    ask: ASK_LINE.LMS_UID_LINK,
    have: (c) =>
      /se-lms\.[\w.-]+/i.test(c.text) || /\b(uid|cid|sid)\s*[:=]?\s*\d{4,}/i.test(c.text),
    when: (c) => /lms|duo|tự học|khoá|khóa|hạn học|hết hạn/i.test(c.system + " " + c.low),
  },
  {
    key: "mã đơn hàng",
    ask: ASK_LINE.ORDER_CODE,
    have: (c) => /\bDH\d{4,}/i.test(c.text) || hasKnown(c, "Mã giao dịch", "Mã đơn hàng"),
    when: (c) =>
      /đơn|hạn|gia hạn|thanh toán|chuyển phí|chuyển nhượng|gói|khoá|khóa|hoàn/i.test(c.low),
  },
  {
    key: "học sinh/khoá/lớp",
    ask: ASK_LINE.COURSE_CLASS_SCOPE,
    have: (c) =>
      hasKnown(c, "Tài khoản HS / SĐT", "Mã khách hàng") && /khoá|khóa|lớp|buổi|môn/i.test(c.low),
  },
  {
    key: "bước thao tác",
    ask: ASK_LINE.STEPS,
    have: (c) => /\b(bước|sau khi|khi (bấm|click|nhấn|vào|đăng nhập|thao tác))\b/i.test(c.low),
  },
  {
    key: "đang hiện vs đúng",
    ask: ASK_LINE.EXPECTED_VS_ACTUAL,
    have: (c) => /đúng ra|phải là|mong muốn|kỳ vọng/i.test(c.low),
  },
  {
    key: "thời điểm",
    ask: ASK_LINE.TIME,
    have: (c) =>
      /\d{1,2}[h:]\d{0,2}|\d{1,2}\/\d{1,2}|hôm (nay|qua)|sáng nay|chiều nay|tối qua|ngày \d/i.test(
        c.low,
      ),
  },
  {
    key: "thiết bị/app",
    ask: ASK_LINE.DEVICE_APP,
    have: (c) =>
      hasKnown(c, "Thiết bị") ||
      /android|ios|iphone|ipad|chrome|safari|firefox|edge|phiên bản/i.test(c.low),
    when: (c) =>
      /app|mobile|web|trình duyệt|điện thoại|máy tính bảng|video|đăng nhập|zalo|máy tính/i.test(
        c.system + " " + c.low,
      ),
  },
];

export const CHECKLIST_CLOSING =
  'Cái nào không có thì anh/chị nhắn "không có", em tạo ticket luôn ạ.';

/**
 * Mục học được (canonical) cần thêm vào tin. Mỗi dòng cố định đang áp dụng cho sự cố
 * này thì hoặc đã được hỏi, hoặc đã có sẵn trong lời báo — cả hai đều được tính là
 * "đã phủ", nên bỏ các mục đó; bỏ thêm OTHER và trùng lặp.
 */
function learnedAsks(
  ctx: Ctx,
  learned: readonly string[],
): Array<{ item: CanonItem; ask: string }> {
  const covered = new Set<CanonItem>();
  for (const it of ITEMS) {
    if (it.when && !it.when(ctx)) continue;
    for (const item of CHECKLIST_KEY_ITEMS[it.key] ?? []) covered.add(item);
  }
  const out: Array<{ item: CanonItem; ask: string }> = [];
  for (const raw of learned) {
    if (!isCanonItem(raw) || raw === "OTHER" || covered.has(raw)) continue;
    if (out.some((o) => o.item === raw)) continue;
    out.push({ item: raw, ask: ASK_LINE[raw] });
  }
  return out;
}

export interface ChecklistLearnedResult {
  items?: readonly string[];
  shares?: Partial<Record<CanonItem, number>>;
}

export type ChecklistLearnedProvider = (
  system: string,
) => readonly string[] | ChecklistLearnedResult;

export function buildChecklist(
  input: TechReviewInput,
  learnedOrOptions: readonly string[] | ChecklistLearnedResult = [],
  sharesParam?: Partial<Record<CanonItem, number>>,
): TechReviewResult {
  const learned = Array.isArray(learnedOrOptions)
    ? learnedOrOptions
    : ((learnedOrOptions as ChecklistLearnedResult).items ?? []);
  const shares = Array.isArray(learnedOrOptions)
    ? sharesParam
    : ((learnedOrOptions as ChecklistLearnedResult).shares ?? sharesParam);

  const text = `${input.title ?? ""}\n${input.description}`;
  const ctx: Ctx = {
    text,
    low: text.toLowerCase(),
    system: `${input.system ?? ""} ${input.product ?? ""}`,
    input,
  };
  if (NOT_TECH.test(text)) return { missing: [] };
  const todo = ITEMS.filter((it) => (it.when ? it.when(ctx) : true) && !it.have(ctx));
  const extra = learnedAsks(ctx, learned);
  if (todo.length === 0 && extra.length === 0) return { missing: [] };

  const hasShares = Boolean(
    shares && Object.values(shares).some((v) => typeof v === "number" && v > 0),
  );

  let ordered: Array<{ key: string; ask: string }>;
  if (!hasShares) {
    ordered = [
      ...todo.map((it) => ({ key: it.key, ask: it.ask })),
      ...extra.map((e) => ({ key: `học thêm: ${e.item}`, ask: e.ask })),
    ];
  } else {
    const screenshot = todo.find((it) => CHECKLIST_KEY_ITEMS[it.key]?.includes("SCREENSHOT"));
    const nonScreenshotBase = todo.filter((it) => it !== screenshot);

    const baseCandidates = nonScreenshotBase.map((it, idx) => {
      const canonList = CHECKLIST_KEY_ITEMS[it.key] ?? [];
      const share = canonList.reduce((max, c) => Math.max(max, shares?.[c] ?? 0), 0);
      return {
        key: it.key,
        ask: it.ask,
        share,
        kind: "base" as const,
        originalIndex: idx,
      };
    });

    const learnedCandidates = extra.map((e, idx) => {
      const share = shares?.[e.item] ?? 0;
      return {
        key: `học thêm: ${e.item}`,
        ask: e.ask,
        share,
        kind: "learned" as const,
        originalIndex: idx,
      };
    });

    const others = [...baseCandidates, ...learnedCandidates].sort((a, b) => {
      if (b.share !== a.share) {
        return b.share - a.share;
      }
      if (a.kind !== b.kind) {
        return a.kind === "base" ? -1 : 1;
      }
      return a.originalIndex - b.originalIndex;
    });

    ordered = [];
    if (screenshot) {
      ordered.push({ key: screenshot.key, ask: screenshot.ask });
    }
    for (const o of others) {
      ordered.push({ key: o.key, ask: o.ask });
    }
  }

  const lines = ordered.map((item, i) => `${i + 1}. ${item.ask}`).join("\n");
  const question = `Dạ để kỹ thuật xử lý nhanh, anh/chị gửi giúp em những thông tin sau ạ:\n${lines}\n${CHECKLIST_CLOSING}`;
  return {
    missing: ordered.map((item) => item.key),
    question,
  };
}

export class ChecklistTechReviewer implements TechReviewer {
  /**
   * `learned` trả các mục học được (canonical) hoặc cả mục học được + tỉ lệ cho một hệ thống (xem lib/ask-learning).
   * Lỗi khi đọc bộ học không được chặn việc hỏi: coi như không có mục học được / không sắp xếp.
   */
  constructor(private readonly learned?: ChecklistLearnedProvider) {}

  async review(input: TechReviewInput): Promise<TechReviewResult> {
    let learned: readonly string[] = [];
    let shares: Partial<Record<CanonItem, number>> | undefined;
    try {
      const res = this.learned?.(input.system ?? "");
      if (res && "shares" in res && res.shares) {
        shares = res.shares;
        learned =
          "items" in res && Array.isArray(res.items) ? res.items : Array.isArray(res) ? res : [];
      } else if (Array.isArray(res)) {
        learned = res;
      } else if (res && "items" in res && Array.isArray(res.items)) {
        learned = res.items;
      }
    } catch {
      learned = [];
      shares = undefined;
    }
    return buildChecklist(input, learned, shares);
  }
}
