/**
 * Tự học: mục nào người báo của MỘT hệ thống hay phải bổ sung, theo độ mới của bình luận.
 *
 * Trọng số một bình luận/ticket: w = 0.5 ^ (tuổi_ngày / H), H = 90 ngày mặc định
 * (nghiên cứu W23/W24: H=90 cho kết quả tốt nhất). Mẫu số = tổng trọng số các ticket
 * của hệ thống đó đã quét. Tử số = với mỗi ticket, trọng số của bình luận đòi mục đó
 * mới nhất (mỗi ticket một lần cho mỗi mục). Mục được học khi tử số >= minTickets (2)
 * VÀ tỉ lệ >= minShare (8%). Mục cũ tự rơi ra vì trọng số giảm dần.
 *
 * Không dùng JEV ở lớp này (nghiên cứu: không đo được lợi ích).
 */
import type { AskLearnStore } from "./store";
import { CANON_ITEMS, isCanonItem, type CanonItem } from "./items";
import { CANONICAL_SYSTEMS, systemAliasesFor } from "../kg/system-taxonomy";

const DAY_MS = 86_400_000;

export interface LearnOptions {
  halfLifeDays?: number;
  minTickets?: number;
  minShare?: number;
}

export const DEFAULT_LEARN_OPTIONS = { halfLifeDays: 90, minTickets: 2, minShare: 0.08 } as const;

export interface ItemStat {
  item: CanonItem;
  /** Trọng số số ticket của hệ thống đã cần mục này. */
  weightedTickets: number;
  /** weightedTickets / tổng trọng số ticket của hệ thống. */
  share: number;
}

export interface SystemReport {
  system: string;
  /** Nhãn thô đã gộp vào hệ thống này (có thể nhiều nhãn). */
  labels: string[];
  tickets: number;
  weightedTickets: number;
  /** Mọi mục có ít nhất một ticket, sắp theo tỉ lệ giảm dần. */
  stats: ItemStat[];
  /** Các mục thực sự được đưa vào checklist (qua ngưỡng). */
  learned: CanonItem[];
}

/** Khoá so khớp nhãn: bỏ khoảng trắng thừa, không phân biệt hoa thường. */
const labelKey = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Nhãn "App/Web Vuihoc" chưa rõ là DUO hay VH_Tự học (ranh giới chưa chốt, xem
 * system-taxonomy.json). Theo quyết định W25: đếm cho CẢ HAI hệ thống.
 */
const AMBIGUOUS_APP_WEB = new Set(
  ["Vuihoc (App/Web_Vuihoc + ERP_DUO)", "App/Web_Vuihoc", "Web_Vuihoc", "APP/WEB/CARE_Vuihoc"].map(
    labelKey,
  ),
);

/**
 * Nhãn thô (như lúc ticket được tạo/nhập) → hệ thống chuẩn của intake (9 mục trong
 * validation-rules.json). Dựa trên `absorbs` của system-taxonomy.json. Trả về [] nếu
 * không khớp (nhãn chưa được map), 2 phần tử nếu là nhãn App/Web chưa rõ.
 * Chuẩn hoá lúc truy vấn, nên không cần ingest lại khi bảng map đổi.
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
  store: AskLearnStore,
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
  store: AskLearnStore,
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
  store: AskLearnStore,
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
 * chưa map được. Nhãn App/Web chưa rõ được đếm vào cả DUO_Vuihoc và VH_Tự học, nên
 * tổng cộng các dòng có thể lớn hơn số ticket thật.
 */
export function learnedReport(
  store: AskLearnStore,
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
