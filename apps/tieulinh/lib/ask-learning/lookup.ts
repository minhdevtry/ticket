/**
 * Cầu nối để checklist đọc mục học được mà không biết gì về kho: trả hàm
 * (hệ thống) → mục canonical. Không có ASK_LEARN_DB, hoặc mở kho lỗi → undefined
 * (checklist chạy như cũ). Lỗi khi tra cứu → [] (không chặn việc hỏi).
 */
import { getLogger } from "../logger";
import type { CanonItem } from "./items";
import { learnedItems, learnedShares } from "./learned";
import { openAskLearnStore, type AskLearnStore } from "./store";

export type AskLearnedLookupResult = CanonItem[] & {
  items: CanonItem[];
  shares: Partial<Record<CanonItem, number>>;
};

export function createAskLearnedLookup(
  dbPath: string | undefined,
  now: () => number = Date.now,
): ((system: string) => AskLearnedLookupResult) | undefined {
  if (!dbPath) return undefined;
  let store: AskLearnStore;
  try {
    store = openAskLearnStore(dbPath);
  } catch (err) {
    getLogger().warn(`[ask-learn] Không mở được kho ${dbPath}, checklist chạy như cũ — ${String(err)}`);
    return undefined;
  }
  return (system: string): AskLearnedLookupResult => {
    try {
      const s = system.trim();
      const items = learnedItems(store, s, now());
      const shares = learnedShares(store, s, now());
      return Object.assign([...items], { items, shares });
    } catch (err) {
      getLogger().warn(`[ask-learn] Tra mục học được lỗi, bỏ qua — ${String(err)}`);
      return Object.assign([] as CanonItem[], { items: [] as CanonItem[], shares: {} as Partial<Record<CanonItem, number>> });
    }
  };
}
