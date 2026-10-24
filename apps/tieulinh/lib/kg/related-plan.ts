/**
 * Kế hoạch ticket tương tự cho MỘT ticket lúc đã có nguyên nhân người viết
 * (comment ghim) — bước chốt sau gợi ý lúc tạo ticket (ADR-0007).
 *
 * Đo trên TECH 26/09 (leave-one-out): đúng 97%, đủ 95%, 0/28 ghi nhầm — lúc
 * tạo ticket chỉ đạt ~91% vì lời người báo chưa có nguyên nhân.
 *
 * Hàm thuần: chỉ tính, không ghi. worker/related-curator.ts ghi lên Itsaplan.
 */
import { causeSimilarity, DEFAULT_CAUSE_SIMILARITY } from "./cause-clusters";
import type { CorpusTicket, SimilarMatch } from "./similar-finder";

/**
 * Bỏ vùng xám (người dùng chốt 26/09: không cùng nguyên nhân thì tự bỏ).
 * Ngưỡng gỡ = DEFAULT_CAUSE_SIMILARITY (0.6): lúc chốt, link/mã do bot gắn sang ticket
 * không cùng nguyên nhân sẽ tự động bị gỡ để dọn dẹp các gợi ý rộng lúc tạo ticket.
 */
export const DIFFERENT_CAUSE_SIMILARITY = DEFAULT_CAUSE_SIMILARITY;

export interface RelatedTarget {
  identifier: string;
  humanCause?: string;
  /** Tín hiệu người trên ticket (xem human-signals.ts). */
  positives: string[];
  negatives: string[];
  /** Mã đang có trong trường Related Tickets. */
  fieldKeys: string[];
  /** Link đang có; `addedByHuman` = lần gắn cuối cùng là của người. */
  links: Array<{ identifier: string; linkId: number; addedByHuman: boolean }>;
  /**
   * Mã do THUẬT TOÁN CŨ ghi hàng loạt (rác 26/09) — chỉ những mã này mới được nhánh
   * "suggested" gỡ/bỏ. Không truyền = coi mọi link/mã bot là gỡ được (hành vi cũ, dùng trong test).
   */
  junk?: string[];
  title?: string;
  description?: string;
}

export interface RelatedPlan {
  clusterId: string | null;
  /** Ticket cùng nguyên nhân cần có (không gồm chính nó). */
  desired: string[];
  /** Giá trị mới của Related Tickets (có cả mã chính nó); null = không đổi. */
  fieldValue: string | null;
  addLinks: string[];
  /** Chỉ link BOT gắn sang ticket đã biết là khác nguyên nhân. */
  removeLinks: Array<{ identifier: string; linkId: number }>;
}

const projectOf = (id: string) => id.replace(/-\d+$/, "");
const byIdentifier = (a: string, b: string) => {
  const pa = projectOf(a);
  const pb = projectOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return Number(a.match(/-(\d+)$/)?.[1] ?? 0) - Number(b.match(/-(\d+)$/)?.[1] ?? 0);
};

export function planRelatedTickets(
  target: RelatedTarget,
  corpus: CorpusTicket[],
  options: { similarity?: number; differentSimilarity?: number } = {},
): RelatedPlan {
  const none: RelatedPlan = {
    clusterId: null,
    desired: [],
    fieldValue: null,
    addLinks: [],
    removeLinks: [],
  };
  if (!target.humanCause?.trim()) return none;

  const self = target.identifier.toUpperCase();
  const threshold = options.similarity ?? DEFAULT_CAUSE_SIMILARITY;
  const differentThreshold = options.differentSimilarity ?? DIFFERENT_CAUSE_SIMILARITY;

  // Ba luật siết gỡ link bot & dùng tín hiệu âm hai chiều (ADR-0007):
  // 1. Tín hiệu âm hai chiều: người đã gỡ link ở bất kỳ phía nào thì cả hai phía
  //    đều phải tôn trọng (ví dụ: tech lead gỡ 728 khỏi 922 thì khi chốt cho 728 cũng
  //    loại 922, không nối 728↔922).
  // 2. Không gỡ link sang ticket cùng cụm KG của self: nếu ticket được link cùng
  //    causeCluster với target trong corpus (dựng từ tín hiệu người) thì giữ nguyên,
  //    không gỡ dù câu chữ khác nhau (ví dụ: TECH-728 cùng cụm TECH-369 với
  //    454/546/570/848, không gỡ link 728→454/546/570/848).
  // 3. Không gỡ link khi câu nguyên nhân chỉ lệch nhẹ: nếu bất kỳ câu nào trong
  //    cụm của id có causeSimilarity >= threshold với bất kỳ câu nào trong
  //    {target.humanCause} ∪ {câu thuộc cụm clusterId đã chọn} ∪ {câu thuộc cụm KG của self}
  //    thì coi như có thể liên quan, không gỡ (ví dụ: TECH-489 "Bị gắn trùng tk học do cts
  //    có nhiều con trùng tên" cùng cụm với 337 "Bị gắn trùng tk học do cùng tên"
  //    sẽ không gỡ link sang TECH-909 "Bị gắn trùng tk học do cùng tên").
  const negatives = new Set(target.negatives.map((x) => x.toUpperCase()));
  for (const t of corpus) {
    if (t.negatives?.some((n) => n.toUpperCase() === self)) {
      negatives.add(t.identifier.toUpperCase());
    }
  }

  // Link người gắn là tín hiệu dương dù tín hiệu truyền vào có sót.
  const positives = new Set([
    ...target.positives.map((x) => x.toUpperCase()),
    ...target.links.filter((l) => l.addedByHuman).map((l) => l.identifier.toUpperCase()),
  ]);
  const others = corpus.filter((t) => t.identifier.toUpperCase() !== self);
  const selfTicket = corpus.find((t) => t.identifier.toUpperCase() === self);
  const selfCluster = selfTicket?.causeCluster;

  const membersOf = (cluster: string) =>
    others.filter((t) => t.causeCluster === cluster).map((t) => t.identifier.toUpperCase());

  // Dựng Map cụm→câu một lần cho toàn bộ corpus
  const causesByCluster = new Map<string, string[]>();
  for (const t of corpus) {
    if (!t.causeCluster || !t.humanCause?.trim()) continue;
    const list = causesByCluster.get(t.causeCluster);
    if (list) list.push(t.humanCause);
    else causesByCluster.set(t.causeCluster, [t.humanCause]);
  }

  // Chọn cụm nguyên nhân:
  // a) Nếu self có trong corpus, có causeCluster, và cụm đó còn >= 1 thành viên khác
  //    (trừ negatives hiệu lực) -> clusterId = cụm của self (KG đã tính đúng ràng buộc).
  //    Vẫn áp luật âm cho thành viên (desired.delete(n)), KHÔNG bỏ cả cụm.
  // b) Không có (a) thì dò theo độ giống câu nguyên nhân, hoà điểm thì ưu tiên cụm
  //    nhiều thành viên hơn, rồi mới theo mã cụm (ổn định, xác định).
  let clusterId: string | null = null;
  const selfOtherMembers = selfCluster
    ? membersOf(selfCluster).filter((m) => !negatives.has(m))
    : [];
  if (selfTicket && selfCluster && selfOtherMembers.length >= 1) {
    clusterId = selfCluster;
  } else {
    const best = new Map<string, number>();
    for (const t of others) {
      if (!t.causeCluster || !t.humanCause) continue;
      const s = causeSimilarity(target.humanCause, t.humanCause);
      if (s >= threshold && s > (best.get(t.causeCluster) ?? 0)) best.set(t.causeCluster, s);
    }
    const candidates = [...best.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const sizeDiff = membersOf(b[0]).length - membersOf(a[0]).length;
      if (sizeDiff !== 0) return sizeDiff;
      return byIdentifier(a[0], b[0]);
    });
    for (const [c] of candidates) {
      if (membersOf(c).some((m) => negatives.has(m))) continue;
      clusterId = c;
      break;
    }
  }

  const desired = new Set<string>(clusterId ? membersOf(clusterId) : []);
  for (const p of positives) desired.add(p);
  for (const n of negatives) desired.delete(n);
  desired.delete(self);

  // Tập câu nguyên nhân tham chiếu của target:
  // {target.humanCause} ∪ {các câu của clusterId đã chọn} ∪ {các câu của cụm KG của self}
  const targetCauses = new Set<string>();
  if (target.humanCause.trim()) targetCauses.add(target.humanCause.trim());
  if (clusterId) {
    for (const c of causesByCluster.get(clusterId) ?? []) {
      if (c?.trim()) targetCauses.add(c.trim());
    }
  }
  if (selfCluster) {
    for (const c of causesByCluster.get(selfCluster) ?? []) {
      if (c?.trim()) targetCauses.add(c.trim());
    }
  }

  // "Đã biết là khác nguyên nhân": cụm có câu nguyên nhân người viết khác cụm này,
  // và KHÔNG câu nào trong cụm có độ tương đồng >= differentThreshold (0.6) với
  // tập câu tham chiếu của target. Bỏ vùng xám: không cùng nguyên nhân thì tự bỏ.
  // Không bao giờ gỡ thứ người gắn, người chốt hoặc ticket chưa có nguyên nhân người viết.
  const clusterOf = new Map(corpus.map((t) => [t.identifier.toUpperCase(), t.causeCluster]));
  const knownDifferent = (id: string) => {
    const c = clusterOf.get(id);
    const causes = c ? causesByCluster.get(c) : undefined;
    if (!c || !causes || causes.length === 0) return false;
    if (c === clusterId) return false;
    // Luật 2: cùng cụm KG với self
    if (selfCluster && c === selfCluster) return false;
    if (desired.has(id)) return false;
    if (positives.has(id)) return false;
    // Luật 3: bất kỳ câu nguyên nhân nào trong cụm của id tương đồng với targetCauses
    for (const cause of causes) {
      for (const ref of targetCauses) {
        if (causeSimilarity(cause, ref) >= differentThreshold) return false;
      }
    }
    return true;
  };

  const shouldDrop = (id: string) => negatives.has(id) || knownDifferent(id);

  const removeLinks = target.links
    .filter((l) => !l.addedByHuman && shouldDrop(l.identifier.toUpperCase()))
    .map((l) => ({ identifier: l.identifier.toUpperCase(), linkId: l.linkId }));

  const selfProject = projectOf(self);
  const current = new Set(target.fieldKeys.map((k) => k.toUpperCase()));
  const next = new Set<string>();
  for (const k of current) {
    if (projectOf(k) !== selfProject && !positives.has(k)) continue; // mã test / dự án khác
    if (shouldDrop(k)) continue;
    next.add(k);
  }
  for (const d of desired) next.add(d);
  if (desired.size) next.add(self);

  const same = next.size === current.size && [...next].every((k) => current.has(k));
  const linked = new Set(target.links.map((l) => l.identifier.toUpperCase()));
  return {
    clusterId,
    desired: [...desired].sort(byIdentifier),
    fieldValue: same ? null : [...next].sort(byIdentifier).join(", "),
    addLinks: [...desired].filter((d) => !linked.has(d)).sort(byIdentifier),
    removeLinks,
  };
}

/**
 * Kế hoạch ticket tương tự cho ticket CHƯA có nguyên nhân người viết (chưa có comment ghim).
 *
 * Gợi ý bot = kết quả `SimilarTicketSource.find()` (KG + Onyx + BM25 + LLM xác
 * minh từng cặp, xem lib/kg/similar-ticket-source.ts) mà caller (related-curator.ts)
 * đã tính sẵn và truyền vào qua `suggested` — hàm này KHÔNG tự tính lại (không gọi
 * LLM/Onyx): `suggested` là `null` khi không đủ tự tin, hoặc `SimilarMatch` khi có.
 *
 * desired = members của gợi ý ∪ positives (tín hiệu người) − negatives hiệu lực (hai phía) − chính nó.
 * Khi options.cleanupOnly = true (ticket đã xong Done/huỷ chưa ghim):
 * desired = (gợi ý ∩ mã/link đang có) ∪ positives − negatives;
 * addLinks = [];
 * trường = desired (+ self nếu desired không rỗng) — tức chỉ bớt, không thêm.
 *
 * Link: thêm link còn thiếu tới desired (trừ khi cleanupOnly); gỡ link BOT gắn tới mã không thuộc desired.
 * Không bao giờ gỡ link người gắn.
 * KHÔNG lan sang ticket cũ (propagate) cho nhánh này.
 */
export function planSuggestedTickets(
  target: RelatedTarget,
  corpus: CorpusTicket[],
  suggested?:
    | SimilarMatch
    | { clusterId?: string | null; members?: Array<{ identifier: string }> }
    | null,
  options: { cleanupOnly?: boolean } = {},
): RelatedPlan {
  const self = target.identifier.toUpperCase();
  const cleanupOnly = Boolean(options.cleanupOnly);

  const match = suggested ?? null;
  const clusterId = match?.clusterId ?? null;
  const suggestedMembers = (match?.members ?? []).map((m) => m.identifier.toUpperCase());

  const negatives = new Set(target.negatives.map((x) => x.toUpperCase()));
  for (const t of corpus) {
    if (t.negatives?.some((n) => n.toUpperCase() === self)) {
      negatives.add(t.identifier.toUpperCase());
    }
  }

  const positives = new Set([
    ...target.positives.map((x) => x.toUpperCase()),
    ...target.links.filter((l) => l.addedByHuman).map((l) => l.identifier.toUpperCase()),
  ]);

  let desired: Set<string>;
  if (cleanupOnly) {
    const existing = new Set([
      ...target.fieldKeys.map((k) => k.toUpperCase()),
      ...target.links.map((l) => l.identifier.toUpperCase()),
    ]);
    const retainedSuggested = suggestedMembers.filter((m) => existing.has(m));
    desired = new Set<string>(retainedSuggested);
  } else {
    desired = new Set<string>(suggestedMembers);
  }
  for (const p of positives) desired.add(p);
  for (const n of negatives) desired.delete(n);
  desired.delete(self);

  const linked = new Set(target.links.map((l) => l.identifier.toUpperCase()));
  const addLinks = cleanupOnly ? [] : [...desired].filter((d) => !linked.has(d)).sort(byIdentifier);

  // Ticket chưa ghim nguyên nhân: chỉ dọn RÁC của thuật toán cũ (target.junk), không gỡ link bot
  // lẻ hay link bộ mới gắn chỉ vì lần tra này LLM không chắc (28/09: TECH-953 suýt mất 8 link PCM
  // đúng, TECH-873↔886 "Zalo lag" suýt bị tách).
  const junk = target.junk ? new Set(target.junk.map((x) => x.toUpperCase())) : null;
  const removable = (id: string) =>
    !desired.has(id) && (junk ? junk.has(id) || negatives.has(id) : true);
  const removeLinks = target.links
    .filter((l) => !l.addedByHuman && removable(l.identifier.toUpperCase()))
    .map((l) => ({ identifier: l.identifier.toUpperCase(), linkId: l.linkId }));

  const current = new Set(target.fieldKeys.map((k) => k.toUpperCase()));
  const next = new Set<string>();
  if (junk)
    for (const k of current) if (!removable(k) && projectOf(k) === projectOf(self)) next.add(k);
  for (const d of desired) next.add(d);
  if (next.size > 0 && (desired.size > 0 || current.has(self))) next.add(self);

  const same = next.size === current.size && [...next].every((k) => current.has(k));
  return {
    clusterId,
    desired: [...desired].sort(byIdentifier),
    fieldValue: same ? null : [...next].sort(byIdentifier).join(", "),
    addLinks,
    removeLinks,
  };
}
