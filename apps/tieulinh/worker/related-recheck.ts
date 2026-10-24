/**
 * Tra lại "ticket tương tự" cho ticket ĐANG MỞ chưa ghim nguyên nhân mỗi khi kho kiến
 * thức (KG — cụm nguyên nhân tech lead xác nhận) lớn thêm.
 *
 * 29/09: bộ tra lúc tạo ticket gần như không gắn gì từ 27/09 — không phải vì hỏng mà vì
 * lúc đó kho chưa có cụm tương ứng. Chạy LẠI đúng bộ tra khắt khe hiện tại (judge
 * "mechanism") trên 90 ticket gần đây với kho hôm nay: trả lời 47%, đúng 73%, gắn sai
 * 0/15 (scripts/eval-similar-recent.ts). Mỗi ticket trước đây chỉ được tra MỘT lần lúc
 * tạo; giờ tra lại khi kho đổi. Thử đổi câu hỏi LLM ("applicability") thì gắn sai tăng
 * trên cả 3 bộ đo nên KHÔNG dùng — thứ quyết định là kho lớn dần, không phải câu hỏi.
 *
 * Việc ghi dùng nguyên chế độ "suggested" của RelatedTicketsCurator (chỉ thêm cụm chắc
 * chắn, chỉ gỡ rác thuật toán cũ, giữ mọi mã người gắn). Không tra lại khi kho chưa đổi
 * kể từ lần tra trước của ticket đó.
 */
import type { ItsaplanClient } from "../lib/itsaplan/client";
import type { CorpusTicket } from "../lib/kg/similar-finder";
import { getLogger } from "@vuihoc/bot-core/core";
import type { CuratorResult } from "./related-curator";

export interface RelatedRecheckOptions {
  itsaplan: Pick<ItsaplanClient, "listProjectIssues" | "listProjectColumns" | "getIssue">;
  corpus: { loadSimilarityCorpus(projectKey: string): Promise<CorpusTicket[]> };
  curator: { run(issueId: number): Promise<CuratorResult> };
  projectKey: string;
  /** Chỉ ticket tạo trong chừng này ngày (mặc định 14). */
  windowDays?: number;
  /** Quét định kỳ (mặc định 6 giờ). */
  intervalMs?: number;
  /** Sau sự kiện kiến thức đổi, đợi chừng này rồi quét (gom nhiều lần ghim liền nhau; mặc định 30 phút). */
  debounceMs?: number;
  now?: () => number;
}

/** Chữ ký kho: đổi khi có ticket mới vào kho hoặc cụm/nguyên nhân đổi. */
export function corpusSignature(corpus: CorpusTicket[]): string {
  const parts = corpus
    .map((c) => `${c.identifier}:${c.causeCluster ?? ""}:${(c.humanCause ?? "").length}`)
    .sort();
  let h = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0;
  return `${corpus.length}:${h}`;
}

export class RelatedRecheck {
  private readonly lastChecked = new Map<number, string>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;

  constructor(private readonly options: RelatedRecheckOptions) {}

  start(): void {
    const every = this.options.intervalMs ?? 6 * 3600 * 1000;
    this.interval = setInterval(() => void this.sweep(), every);
    (this.interval as any).unref?.();
    this.scheduleSoon();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
  }

  /** Kiến thức vừa có thể đổi (ghim nguyên nhân, ticket Done vào KG…) → quét sau một lúc. */
  scheduleSoon(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sweep(), this.options.debounceMs ?? 30 * 60 * 1000);
    (this.debounce as any).unref?.();
  }

  /** Một lượt quét; lượt đang chạy thì không chạy chồng. */
  sweep(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doSweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doSweep(): Promise<void> {
    const log = getLogger();
    const { itsaplan, projectKey } = this.options;
    const now = (this.options.now ?? Date.now)();
    try {
      const signature = corpusSignature(await this.options.corpus.loadSimilarityCorpus(projectKey));
      const columns = await itsaplan.listProjectColumns(projectKey);
      const closed = new Set(
        columns
          .filter((c) => c.stateType === "completed" || c.stateType === "canceled")
          .map((c) => c.id),
      );
      const since = now - (this.options.windowDays ?? 14) * 24 * 3600 * 1000;
      // Danh sách Itsaplan KHÔNG trả createdAt (29/09: lọc theo nó thì loại sạch) → lọc ticket
      // đang mở trước, rồi đọc ngày tạo từ chi tiết từng ticket.
      const listed = (await itsaplan.listProjectIssues(projectKey, { limit: 1000 })).filter(
        (i) => !closed.has(i.columnId) && i.stateType !== "completed" && i.stateType !== "canceled",
      );
      const open: typeof listed = [];
      for (const i of listed) {
        const createdAt =
          i.createdAt ?? (await itsaplan.getIssue(i.id).catch(() => null))?.createdAt;
        if (createdAt && Date.parse(createdAt) >= since) open.push(i);
      }
      const todo = open.filter((i) => this.lastChecked.get(i.id) !== signature);
      if (!todo.length) return;
      log.info(
        `[RelatedRecheck] Bắt đầu tra lại ${todo.length}/${open.length} ticket đang mở (≤ ${this.options.windowDays ?? 14} ngày).`,
      );
      const counts: Record<string, number> = {};
      for (const issue of todo) {
        const r = await this.options.curator.run(issue.id);
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        // Lỗi thì để lượt sau thử lại; còn lại ghi nhận đã tra với kho này.
        if (r.status !== "error") this.lastChecked.set(issue.id, signature);
      }
      log.info(
        `[RelatedRecheck] Tra lại ${todo.length}/${open.length} ticket đang mở với kho ${signature}: ${JSON.stringify(counts)}.`,
      );
    } catch (err: any) {
      log.warn(`[RelatedRecheck] Lượt quét lỗi: ${err?.message ?? err}`);
    }
  }
}
