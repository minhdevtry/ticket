/**
 * Cầu nối để checklist đọc mục học được mà không biết gì về kho: trả hàm
 * (hệ thống) → mục canonical. Không có ASK_LEARN_DB, hoặc mở kho lỗi → undefined
 * (checklist chạy như cũ). Lỗi khi tra cứu → [] (không chặn việc hỏi).
 *
 * Cài đặt ở app (Tiểu Linh), cung cấp LearnedItemsPort cho engine.
 */
import { getLogger } from "@vuihoc/bot-core/core";
import {
  learnedItems,
  learnedShares,
  type CanonItem,
  type LearnedItemsPort,
} from "@vuihoc/bot-core/intake";
import { openAskLearnStore, type AskLearnStore } from "./store";

export type AskLearnedLookupResult = CanonItem[] & {
  items: CanonItem[];
  shares: Partial<Record<CanonItem, number>>;
};

export interface AskLearnedLookupFn {
  (system: string): AskLearnedLookupResult;
  learned(system: string): AskLearnedLookupResult;
  getLearnedItems(system: string): AskLearnedLookupResult;
}

export class SqliteLearnedItemsPort implements LearnedItemsPort {
  constructor(
    private readonly store: AskLearnStore,
    private readonly now: () => number = Date.now,
  ) {}

  learned(system: string): AskLearnedLookupResult {
    try {
      const s = system.trim();
      const items = learnedItems(this.store, s, this.now());
      const shares = learnedShares(this.store, s, this.now());
      return Object.assign([...items], { items, shares });
    } catch (err) {
      getLogger().warn(`[ask-learn] Tra mục học được lỗi, bỏ qua — ${String(err)}`);
      return Object.assign([] as CanonItem[], {
        items: [] as CanonItem[],
        shares: {} as Partial<Record<CanonItem, number>>,
      });
    }
  }

  getLearnedItems(system: string): AskLearnedLookupResult {
    return this.learned(system);
  }
}

export function createAskLearnedLookup(
  dbPath: string | undefined,
  now: () => number = Date.now,
): AskLearnedLookupFn | undefined {
  if (!dbPath) return undefined;
  let store: AskLearnStore;
  try {
    store = openAskLearnStore(dbPath);
  } catch (err) {
    getLogger().warn(
      `[ask-learn] Không mở được kho ${dbPath}, checklist chạy như cũ — ${String(err)}`,
    );
    return undefined;
  }
  const port = new SqliteLearnedItemsPort(store, now);
  const fn = ((system: string): AskLearnedLookupResult => {
    return port.learned(system);
  }) as AskLearnedLookupFn;
  fn.learned = (system: string) => port.learned(system);
  fn.getLearnedItems = (system: string) => port.learned(system);
  return fn;
}
