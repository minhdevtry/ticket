/**
 * Tự học: mục nào người báo của MỘT hệ thống hay phải bổ sung, theo độ mới của bình luận.
 *
 * Nghiên cứu W23/W24/W25:
 * - Suy giảm theo thời gian: halfLife 90 ngày (bình luận 90 ngày trước có trọng số 0.5,
 *   180 ngày trước 0.25).
 * - Mẫu số là TỔNG số ticket của hệ thống đó (đã áp suy giảm theo mốc tạo ticket).
 * - Ngưỡng: tối thiểu 2 ticket có hỏi, và tỉ lệ ≥ 8% (minTickets=2, minShare=0.08).
 * - Sắp xếp theo tỉ lệ giảm dần.
 *
 * Hàm thuần tuý: nhận dữ liệu qua `AskLearnDataProvider` (rows), không phụ thuộc vào kho SQLite hay I/O.
 */
import { AMBIGUOUS_APP_WEB_LABELS, CANONICAL_SYSTEMS, systemAliasesFor } from "./system-taxonomy";
import { CANON_ITEMS, isCanonItem, type CanonItem } from "./items";

const DAY_MS = 86_400_000;

export interface LearnOptions {
  halfLifeDays?: number;
  minTickets?: number;
  minShare?: number;
}

export const DEFAULT_LEARN_OPTIONS = { halfLifeDays: 90, minTickets: 2, minShare: 0.08 } as const;

export interface AskTicketRow {
  issueKey: string;
  system: string;
  createdAt: number;
}

export interface AskCommentRow {
  commentId: string;
  issueKey: string;
  system: string;
  createdAt: number;
  needsInfo: boolean;
  kind: string;
  items: CanonItem[];
  alreadyInReport: boolean;
}

export interface AskLearnDataProvider {
  ticketsOf(system: string): AskTicketRow[];
  needsCommentsOf(system: string): AskCommentRow[];
  systems(): string[];
}

export interface ItemStat {
  item: CanonItem;
  weightedTickets: number;
  share: number;
}

export interface SystemReport {
  system: string;
  labels: string[];
  tickets: number;
  weightedTickets: number;
  stats: ItemStat[];
  learned: CanonItem[];
}

/** Khoá so khớp nhãn: bỏ khoảng trắng thừa, không phân biệt hoa thường. */
const labelKey = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Nhãn "App/Web Vuihoc" chưa rõ là DUO hay VH_Tự học.
 * Theo quyết định W25: đếm cho CẢ HAI hệ thống.
 */
const AMBIGUOUS_APP_WEB = new Set(AMBIGUOUS_APP_WEB_LABELS.map(labelKey));

/**
 * Nhãn thô (như lúc ticket được tạo/nhập) → hệ thống chuẩn của intake (9 mục).
 * Dựa trên `absorbs` của system-taxonomy. Trả về [] nếu không khớp (nhãn chưa được map),
 * 2 phần tử nếu là nhãn App/Web chưa rõ.
 */
export function intakeSystemsOf(raw: string | null | undefined): string[] {
  const key = labelKey(raw ?? "");
  if (!key) return [];
  if (AMBIGUOUS_APP_WEB.has(key)) return ["DUO_Vuihoc", "VH_Tự học"];
  for (const canon of CANONICAL_SYSTEMS) {
    if (labelKey(canon) === key) return [canon];
  }
  for (const canon of CANONICAL_SYSTEMS) {
    if (systemAliasesFor(canon).some((a) => labelKey(a) === key)) return [canon];
  }
  return [];
}

function weight(createdAt: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - createdAt) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

/** Thống kê đầy đủ cho một hệ thống (dùng cho cả learnedItems và learnedReport). */
export function systemReport(
  store: AskLearnDataProvider,
  system: string,
  nowMs: number,
  opts: LearnOptions = {},
): SystemReport {
  const o = { ...DEFAULT_LEARN_OPTIONS, ...opts };
  const labels = store.systems().filter((l) => intakeSystemsOf(l).includes(system));
  const tickets = labels.flatMap((l) => store.ticketsOf(l));
  const total = tickets.reduce((sum, t) => sum + weight(t.createdAt, nowMs, o.halfLifeDays), 0);

  // ticket → mục → trọng số bình luận mới nhất đòi mục đó
  const best = new Map<string, Map<CanonItem, number>>();
  for (const c of labels.flatMap((l) => store.needsCommentsOf(l))) {
    if (c.alreadyInReport) continue;
    const w = weight(c.createdAt, nowMs, o.halfLifeDays);
    let perItem = best.get(c.issueKey);
    if (!perItem) {
      perItem = new Map();
      best.set(c.issueKey, perItem);
    }
    for (const item of c.items) {
      if (!isCanonItem(item) || item === "OTHER") continue;
      perItem.set(item, Math.max(perItem.get(item) ?? 0, w));
    }
  }

  const sums = new Map<CanonItem, number>();
  for (const perItem of best.values()) {
    for (const [item, w] of perItem) sums.set(item, (sums.get(item) ?? 0) + w);
  }
  const stats: ItemStat[] = [...sums.entries()]
    .map(([item, weightedTickets]) => ({
      item,
      weightedTickets,
      share: total > 0 ? weightedTickets / total : 0,
    }))
    .sort((a, b) => b.share - a.share || CANON_ITEMS.indexOf(a.item) - CANON_ITEMS.indexOf(b.item));
  const learned = stats
    .filter((s) => s.weightedTickets >= o.minTickets && s.share >= o.minShare)
    .map((s) => s.item);

  return {
    system,
    labels,
    tickets: tickets.length,
    weightedTickets: total,
    stats,
    learned,
  };
}

/** Các mục canonical được học cho một hệ thống, sắp theo tỉ lệ giảm dần. */
export function learnedItems(
  store: AskLearnDataProvider,
  system: string,
  nowMs: number,
  opts: LearnOptions = {},
): CanonItem[] {
  if (!system) return [];
  return systemReport(store, system, nowMs, opts).learned;
}

/**
 * Tỉ lệ số ticket của một hệ thống đã cần từng mục canonical (recency-weighted share).
 * Trả về mọi mục có trọng số > 0 (kể cả không qua ngưỡng minTickets / minShare).
 */
export function learnedShares(
  store: AskLearnDataProvider,
  system: string,
  nowMs: number,
  opts: LearnOptions = {},
): Partial<Record<CanonItem, number>> {
  if (!system) return {};
  const rep = systemReport(store, system, nowMs, opts);
  const out: Partial<Record<CanonItem, number>> = {};
  for (const s of rep.stats) {
    if (s.weightedTickets > 0 && s.share > 0) {
      out[s.item] = s.share;
    }
  }
  return out;
}

/**
 * Bảng cho log/CLI: 9 hệ thống chuẩn của intake (kể cả chưa có ticket), cộng nhãn
 * chưa map được.
 */
export function learnedReport(
  store: AskLearnDataProvider,
  nowMs: number,
  opts: LearnOptions = {},
): { systems: SystemReport[]; unmapped: Array<{ label: string; tickets: number }> } {
  const systems = CANONICAL_SYSTEMS.map((c) => systemReport(store, c, nowMs, opts));
  const unmapped = store
    .systems()
    .filter((l) => intakeSystemsOf(l).length === 0)
    .map((l) => ({ label: l, tickets: store.ticketsOf(l).length }))
    .sort((a, b) => b.tickets - a.tickets);
  return { systems, unmapped };
}
