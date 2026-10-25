/**
 * Ticket tương tự lúc tiếp nhận (ADR-0007, spec
 * docs/superpowers/specs/2026-09-26-ticket-tuong-tu-design.md) — kiến trúc mới
 * (26/09→27/09), thay hẳn bỏ phiếu cụm theo ngưỡng BM25 cũ (similar-finder.ts
 * trước đây), theo thiết kế đo được của researcher A (benchmark mù, xem
 * báo cáo nghiên cứu nội bộ): 52% đúng / 64% đủ / 1 ghi sai
 * trên 47 lượt, so với 33% đúng của thuật toán cũ.
 *
 * Vai trò tách bạch:
 * - KG (Memgraph) = SỰ THẬT: cụm nguyên nhân người đã xác nhận (causeCluster),
 *   nguyên nhân/cách khắc phục người viết, tín hiệu âm (negatives). Giãn cụm =
 *   tra KG, không phải suy luận theo chữ.
 * - Onyx (RAG) = ứng viên NGỮ NGHĨA (semantic), qua client REST có sẵn
 *   (lib/onyx/rest-search.ts), lọc lại chỉ giữ ticket có trong kho KG.
 * - BM25 (similar-finder.ts::SimilarityIndex.search) = ứng viên LEXICAL thuần.
 * - LLM = NGƯỜI PHÁN XỬ DUY NHẤT, xác minh 1-1 (similar-judge.ts), quyết định
 *   cuối luôn qua chốt chặn xác định (quote-gate.ts) + yêu cầu cụm đã lặp lại.
 */
import { getLogger } from "@vuihoc/bot-core/core";
import type { LlmConfig } from "../../worker/llm";
import type { MemgraphClient } from "./memgraph-client";
import type { OnyxRestSearchClient } from "../onyx/rest-search";
import {
  SimilarityIndex,
  type CorpusTicket,
  type PossibleCluster,
  type SimilarMatch,
  type SimilarMember,
} from "./similar-finder";
import { extractQuotedErrors, quoteGate } from "./quote-gate";
import {
  askDiscriminatingQuestion,
  candidateQuotesOf,
  verifyCandidate,
  type ClusterCard,
  type JudgeMode,
  type OnyxSnippet,
} from "./similar-judge";

export interface FindOptions {
  excludeIds?: string[];
}

/** Nguồn ticket tương tự cho luồng tiếp nhận — tách ra để pipeline test không cần Memgraph/Onyx/LLM. */
export interface SimilarTicketSource {
  find(text: string, options?: FindOptions): Promise<SimilarMatch | null>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Ngưỡng/độ trễ có thể chỉnh qua env (xem tieulinh/index.ts, worker/index.ts). */
export const SIMILAR_DEFAULTS = {
  /** SIMILAR_MAX_CANDIDATES — trần số ứng viên đưa vào LLM xác minh (BM25 ∪ Onyx, ưu tiên thứ tự gộp). */
  maxCandidates: 14,
  /** SIMILAR_LLM_CONCURRENCY — số lời gọi LLM chạy song song. */
  llmConcurrency: 5,
  /** SIMILAR_TIMEOUT_MS — timeout tổng cho cả vòng xác minh; hết giờ = không gợi ý (không trả kết quả nửa vời). */
  timeoutMs: 60_000,
} as const;

export interface LlmSimilarTicketsOptions {
  memgraph: Pick<MemgraphClient, "loadSimilarityCorpus">;
  onyx?: Pick<OnyxRestSearchClient, "searchSimilar">;
  llm: LlmConfig;
  projectKey: string;
  maxCandidates?: number;
  llmConcurrency?: number;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
  /** SIMILAR_JUDGE_MODE — "mechanism" hoặc "applicability" (xem similar-judge.ts::JudgeMode). Mặc định "mechanism" nếu bỏ trống. */
  judgeMode?: JudgeMode;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}

const TIMED_OUT = Symbol("similar-ticket-source:timeout");

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Ticket khác cùng `clusterId` trong kho, trừ `excludeIds` và trừ `negatives`
 * (REJECTED_RELATION của (các) ứng viên được chấp nhận — đã lưu 2 chiều sẵn
 * trong corpus, xem memgraph-client.ts::loadSimilarityCorpus) — đúng "giãn cụm
 * qua KG, minus negatives, minus self" theo thiết kế.
 */
function membersOfCluster(
  corpus: CorpusTicket[],
  clusterId: string,
  excludeIds: Set<string>,
  negatives: Set<string>,
): SimilarMember[] {
  return corpus.filter(
    (t) =>
      t.causeCluster === clusterId &&
      !excludeIds.has(t.identifier.toUpperCase()) &&
      !negatives.has(t.identifier.toUpperCase()),
  );
}

/** Số thành viên KHÁC trong cụm — "đã lặp lại ≥ 2 lần" nghĩa là cụm có >= 2 thành viên (kể cả candidate). */
function clusterSize(corpus: CorpusTicket[], clusterId: string): number {
  return corpus.filter((t) => t.causeCluster === clusterId).length;
}

function bestAdvice(members: SimilarMember[]): SimilarMatch["advice"] {
  const withAdvice = members.find((m) => m.humanCause?.trim() && m.humanFix?.trim());
  return withAdvice
    ? {
        cause: withAdvice.humanCause!.trim(),
        fix: withAdvice.humanFix!.trim(),
        from: withAdvice.identifier,
      }
    : undefined;
}

interface ClusterGroup {
  key: string;
  ids: string[];
  sample: CorpusTicket;
  negatives: Set<string>;
}

/** Gộp các ứng viên (đã accepted, hoặc đã "possible") theo `causeCluster` — dùng chung cho cả hai đường. */
function groupByCluster(
  entries: Array<{ id: string; cand: CorpusTicket }>,
): Map<string, ClusterGroup> {
  const groups = new Map<string, ClusterGroup>();
  for (const { id, cand } of entries) {
    const key = cand.causeCluster ?? `SELF:${id}`;
    const g = groups.get(key);
    if (g) {
      g.ids.push(id);
      for (const n of cand.negatives ?? []) g.negatives.add(n.toUpperCase());
    } else {
      groups.set(key, {
        key,
        ids: [id],
        sample: cand,
        negatives: new Set((cand.negatives ?? []).map((n) => n.toUpperCase())),
      });
    }
  }
  return groups;
}

/** Thẻ hiển thị cho 1 cụm — tối đa 3 ticket ví dụ (đủ cho cả UI "chưa chắc" lẫn prompt câu hỏi phân biệt). */
function cardOf(corpus: CorpusTicket[], g: ClusterGroup): ClusterCard {
  const ids = g.sample.causeCluster
    ? membersOfCluster(corpus, g.sample.causeCluster, new Set(), g.negatives).map(
        (m) => m.identifier,
      )
    : g.ids;
  return {
    clusterId: g.key,
    cause: g.sample.humanCause,
    fix: g.sample.humanFix,
    sampleIds: ids.slice(0, 3),
  };
}

/**
 * Nạp kho ticket hoàn tất của MỘT dự án từ KG (kèm causeCluster/humanCause/
 * humanFix/negatives — xem memgraph-client.ts::loadSimilarityCorpus), sinh ứng
 * viên (BM25 + Onyx), nhờ LLM xác minh TỪNG cặp, áp chốt chặn xác định, rồi
 * giãn theo cụm KG. Lỗi ở bất kỳ bước nào (Memgraph/Onyx/LLM/timeout) đều trả
 * null — không chặn tiếp nhận, không bao giờ trả kết quả nửa vời.
 */
export class LlmSimilarTickets implements SimilarTicketSource {
  private corpus: CorpusTicket[] | null = null;
  private index: SimilarityIndex | null = null;
  private loadedAt = 0;

  constructor(private readonly options: LlmSimilarTicketsOptions) {}

  private async getCorpus(): Promise<{ corpus: CorpusTicket[]; index: SimilarityIndex }> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (!this.corpus || !this.index || now - this.loadedAt > ttl) {
      this.corpus = await this.options.memgraph.loadSimilarityCorpus(this.options.projectKey);
      this.index = new SimilarityIndex(this.corpus);
      this.loadedAt = now;
    }
    return { corpus: this.corpus, index: this.index };
  }

  async find(text: string, options: FindOptions = {}): Promise<SimilarMatch | null> {
    const log = getLogger();
    const maxCandidates = this.options.maxCandidates ?? SIMILAR_DEFAULTS.maxCandidates;
    const concurrency = this.options.llmConcurrency ?? SIMILAR_DEFAULTS.llmConcurrency;
    const timeoutMs = this.options.timeoutMs ?? SIMILAR_DEFAULTS.timeoutMs;
    const judgeMode: JudgeMode = this.options.judgeMode ?? "mechanism";
    const excludeIds = new Set((options.excludeIds ?? []).map((x) => x.toUpperCase()));

    let corpus: CorpusTicket[];
    let index: SimilarityIndex;
    try {
      ({ corpus, index } = await this.getCorpus());
    } catch (err: any) {
      log.warn(
        `[LlmSimilarTickets] Không nạp được kho KG (${this.options.projectKey}): ${err?.message ?? err}`,
      );
      return null;
    }
    if (!corpus.length) return null;

    // 1) Ứng viên: BM25 cục bộ ∪ Onyx (đã lọc chỉ giữ ticket có trong kho KG).
    //    Giữ lại rootCause/resolution Onyx đã trích sẵn (nguồn ingest khác,
    //    không phải KG) làm "tóm tắt bổ sung" cho LLM xác minh — đây là phần
    //    ngữ cảnh giàu hơn corpus KG thuần (chỉ có symptomsText/humanCause/
    //    humanFix), giúp LLM đủ căn cứ báo confidence "high" hơn khi có.
    const localHits = index.search(text, { excludeIds: [...excludeIds], topN: maxCandidates });
    const onyxIds: string[] = [];
    const onyxSnippets = new Map<string, OnyxSnippet>();
    if (this.options.onyx) {
      try {
        const onyxHits = await this.options.onyx.searchSimilar(text);
        const corpusIds = new Set(corpus.map((c) => c.identifier.toUpperCase()));
        for (const h of onyxHits) {
          const id = h.identifier.toUpperCase();
          if (!corpusIds.has(id) || excludeIds.has(id)) continue;
          onyxIds.push(id);
          if ((h.rootCause || h.resolution) && !onyxSnippets.has(id)) {
            onyxSnippets.set(id, { rootCause: h.rootCause, resolution: h.resolution });
          }
        }
      } catch (err: any) {
        log.warn(`[LlmSimilarTickets] Onyx lỗi, chỉ dùng BM25: ${err?.message ?? err}`);
      }
    }
    const byId = new Map(corpus.map((c) => [c.identifier.toUpperCase(), c]));
    const order: string[] = [];
    const seen = new Set<string>();
    for (const h of localHits) {
      const id = h.ticket.identifier.toUpperCase();
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    for (const id of onyxIds) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    const candidateIds = order.slice(0, maxCandidates);
    if (!candidateIds.length) return null;

    // 2) LLM xác minh 1-1, đồng thời có giới hạn + timeout tổng — hết giờ thì bỏ, không trả nửa vời.
    const newQuotes = extractQuotedErrors(text);
    const verifyAll = mapWithConcurrency(candidateIds, concurrency, async (id) => {
      const cand = byId.get(id)!;
      const result = await verifyCandidate(
        this.options.llm,
        text,
        cand,
        onyxSnippets.get(id),
        1,
        judgeMode,
      );
      return { id, cand, result };
    });
    const verified = await withTimeout(verifyAll, timeoutMs);
    if (verified === TIMED_OUT) {
      log.warn(
        `[LlmSimilarTickets] Hết giờ (${timeoutMs}ms) xác minh ${candidateIds.length} ứng viên — không gợi ý.`,
      );
      return null;
    }

    // 3) Chốt chặn quyết định (deterministic): quote-gate thắng LLM; không có quote thì cần
    //    LLM "high" VÀ cụm ứng viên đã có >= 2 thành viên (dạng lỗi đã lặp lại, không phải suy đoán đơn lẻ).
    const accepted: Array<{ id: string; cand: CorpusTicket }> = [];
    // Ứng viên LLM nói true, quote-gate không bác thẳng, nhưng KHÔNG đạt ngưỡng ghi ở
    // trên — "có thể liên quan nhưng chưa chắc" (TECH-956), khác accepted ở chỗ không
    // bao giờ được ghi vào Related Tickets/link, chỉ hiển thị.
    const maybeCandidates: Array<{ id: string; cand: CorpusTicket }> = [];
    // Nhánh "high" (không có quote đối chiếu) phải ổn định: LLM thỉnh thoảng lật sang "high"
    // (đo 28/09 trên TECH-956: ~1/5 lần) — hỏi lại 2 lần độc lập, đủ 3/3 "cùng nguyên nhân"
    // mới ghi; lật thì hạ xuống "chưa chắc" (chỉ hiển thị).
    const stable: Array<{ id: string; cand: CorpusTicket }> = [];
    for (const { id, cand, result } of verified) {
      // Quote-gate xét TRƯỚC LLM, như nghiên cứu A: trùng nguyên văn câu báo lỗi hệ thống là
      // bằng chứng đủ mạnh dù LLM chê (test E2E 28/09 TECH-958: cùng "Không tìm thấy gói chuyển
      // phí bên PCM" với 8 ticket cụm TECH-714, LLM nói khác vì khác môn học).
      const candQuotes = candidateQuotesOf(cand, onyxSnippets.get(id));
      const gate = quoteGate(newQuotes, candQuotes);
      if (gate === "conflict") continue;
      if (gate === "match") {
        accepted.push({ id, cand });
        continue;
      }
      if (!result || !result.sameRootCause) continue;
      if (
        result.confidence === "high" &&
        cand.causeCluster &&
        clusterSize(corpus, cand.causeCluster) >= 2
      ) {
        stable.push({ id, cand });
      } else {
        maybeCandidates.push({ id, cand });
      }
    }
    if (stable.length) {
      const rechecked = await withTimeout(
        Promise.all(
          stable.map(async ({ id, cand }) => {
            const again = await Promise.all(
              [2, 3].map((n) =>
                verifyCandidate(this.options.llm, text, cand, onyxSnippets.get(id), n, judgeMode),
              ),
            );
            return { id, cand, ok: again.every((r) => r?.sameRootCause) };
          }),
        ),
        timeoutMs,
      );
      if (rechecked === TIMED_OUT) {
        log.warn(
          `[LlmSimilarTickets] Hết giờ khi kiểm lại ${stable.length} ứng viên — không ghi, chỉ hiển thị.`,
        );
        maybeCandidates.push(...stable);
      } else {
        for (const r of rechecked)
          (r.ok ? accepted : maybeCandidates).push({ id: r.id, cand: r.cand });
        const flipped = rechecked.filter((r) => !r.ok).map((r) => r.id);
        if (flipped.length)
          log.info(
            `[LlmSimilarTickets] Hạ xuống "chưa chắc" vì kiểm lại không ổn định: ${flipped.join(", ")}`,
          );
      }
    }

    // 4) Nhóm theo cụm nguyên nhân. Ứng viên chưa có causeCluster (chấp nhận qua quote-match với
    //    1 ticket lẻ) coi là cụm-của-riêng-nó (khoá theo mã) để vẫn tách bạch khỏi cụm khác.
    const groups = groupByCluster(accepted);

    if (groups.size === 1) {
      const [{ key, sample, negatives }] = groups.values();
      const members = sample.causeCluster
        ? membersOfCluster(corpus, sample.causeCluster, excludeIds, negatives)
        : [sample];
      return { clusterId: key, share: 1, members, advice: bestAdvice(members) };
    }

    // 5) Không có gì chắc chắn để ghi. Hai đường tới đây:
    //    - accepted rơi vào ≥ 2 cụm khác nhau (đường cũ: xung đột, không đoán liều), hoặc
    //    - accepted rỗng nhưng có ứng viên "chưa chắc" (đường mới, TECH-956: trước đây bị
    //      bỏ hoàn toàn dù LLM đã nói same_root_cause=true cho ít nhất một ứng viên).
    //    Cả hai đều hiển thị (không ghi) danh sách cụm + MỘT câu hỏi phân biệt.
    const maybeGroups = groupByCluster(maybeCandidates);
    if (groups.size === 0 && maybeGroups.size === 0) return null;

    const sourceGroups = groups.size >= 2 ? groups : maybeGroups;
    const possibleCards: ClusterCard[] = [...sourceGroups.values()].map((g) => cardOf(corpus, g));

    // Chỉ 1 thẻ thì LLM không có gì để đối chiếu — bù thêm cụm ứng viên phổ biến kế
    // tiếp trong danh sách đã truy hồi (BM25 ∪ Onyx, không nhất thiết đã qua LLM) để
    // có ≥ 2 thẻ đối chiếu. Không tìm được thẻ thứ hai thì bỏ hẳn (không hỏi liều với 1 thẻ).
    const questionCards = [...possibleCards];
    if (questionCards.length === 1) {
      const excludeKey = questionCards[0].clusterId;
      const freq = new Map<string, number>();
      for (const id of candidateIds) {
        const key = byId.get(id)?.causeCluster;
        if (!key || key === excludeKey) continue;
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
      const nextKey = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const nextMembers = nextKey ? membersOfCluster(corpus, nextKey, new Set(), new Set()) : [];
      if (nextKey && nextMembers.length > 0) {
        questionCards.push({
          clusterId: nextKey,
          cause: nextMembers[0].humanCause,
          fix: nextMembers[0].humanFix,
          sampleIds: nextMembers.slice(0, 3).map((m) => m.identifier),
        });
      }
    }
    if (questionCards.length < 2) return null;

    const questionResult = await withTimeout(
      askDiscriminatingQuestion(this.options.llm, text, questionCards),
      timeoutMs,
    );
    if (questionResult === TIMED_OUT) {
      log.warn(
        `[LlmSimilarTickets] Hết giờ khi hỏi câu phân biệt (${questionCards.length} thẻ) — không gợi ý.`,
      );
      return null;
    }
    const possible: PossibleCluster[] = possibleCards.map((c) => ({
      clusterId: c.clusterId,
      cause: c.cause,
      fix: c.fix,
      sampleIds: c.sampleIds,
    }));
    return { clusterId: null, share: 0, members: [], question: questionResult, possible };
  }
}
