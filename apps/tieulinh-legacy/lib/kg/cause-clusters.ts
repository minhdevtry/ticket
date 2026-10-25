/**
 * Cụm nguyên nhân — nhóm ticket mà NGƯỜI đã xác định cùng nguyên nhân lỗi
 * (ADR-0007). Ticket tương tự của một sự cố = các ticket cùng cụm; cùng hệ
 * thống hay sản phẩm thôi thì không tính.
 *
 * Dựng chỉ từ tín hiệu người: câu Nguyên nhân trong comment ghim, link/mã người
 * gắn (gộp), link/mã người gỡ (cấm gộp). Gộp theo thứ tự tin cậy: tín hiệu dương
 * của người trước, rồi các cặp câu nguyên nhân từ giống nhất trở xuống; hai nhóm
 * có bất kỳ cặp nào người đã gỡ thì không bao giờ gộp.
 *
 * Đo trên TECH 26/09 (ngưỡng 0,6): 0/116 cặp tech lead đã gỡ bị gộp chung;
 * 32 cụm ≥ 2 ticket phủ 144 ticket.
 */

export interface CauseClusterInput {
  id: string;
  /** Câu Nguyên nhân người viết (comment ghim). */
  humanCause?: string;
  positives: string[];
  negatives: string[];
}

export const DEFAULT_CAUSE_SIMILARITY = 0.6;

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

// Tiền tố mô tả mức chắc chắn / cách trình bày, không phải cơ chế lỗi.
const PREFIX = /^(chua ro nguyen nhan|issue \d+|loi du lieu|co the)\s+/;
const STOP = new Set([
  "do",
  "bi",
  "nen",
  "va",
  "cua",
  "cho",
  "khi",
  "o",
  "la",
  "ko",
  "khong",
  "thi",
  "da",
  "dang",
  "se",
  "co",
  "ben",
  "cac",
  "1",
  "2",
]);
/** Câu nguyên nhân hay có đuôi riêng từng ticket (tên HS, mã đơn) — chỉ so phần đầu. */
const HEAD_WORDS = 16;

export function causeTokens(cause: string | undefined): Set<string> {
  if (!cause) return new Set();
  let s = fold(cause)
    .replace(/<[^>]*>|https?:\/\/\S+|!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) s = s.replace(PREFIX, "");
  const words = s
    .split(" ")
    .filter((w) => w && !/^\d{4,}$/.test(w))
    .slice(0, HEAD_WORDS);
  return new Set(words.filter((w) => !STOP.has(w)));
}

export function causeSimilarity(a: string | undefined, b: string | undefined): number {
  const A = causeTokens(a);
  const B = causeTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Thứ tự tự nhiên TECH-9 < TECH-10, để mã cụm ổn định giữa các lần tính. */
function compareIdentifiers(a: string, b: string): number {
  const [pa, na] = [a.replace(/-\d+$/, ""), Number(a.match(/-(\d+)$/)?.[1] ?? NaN)];
  const [pb, nb] = [b.replace(/-\d+$/, ""), Number(b.match(/-(\d+)$/)?.[1] ?? NaN)];
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** id → mã cụm (ticket nhỏ nhất trong cụm). Ticket không cùng cụm với ai là cụm của riêng nó. */
export function buildCauseClusters(
  nodes: CauseClusterInput[],
  options: { similarity?: number } = {},
): Map<string, string> {
  const threshold = options.similarity ?? DEFAULT_CAUSE_SIMILARITY;
  const ordered = [...nodes].sort((x, y) => compareIdentifiers(x.id, y.id));
  const known = new Set(ordered.map((n) => n.id));

  const parent = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  const forbidden = new Map<string, Set<string>>();
  for (const n of ordered) {
    parent.set(n.id, n.id);
    members.set(n.id, new Set([n.id]));
    forbidden.set(n.id, new Set());
  }
  for (const n of ordered) {
    for (const other of n.negatives) {
      if (!known.has(other) || other === n.id) continue;
      forbidden.get(n.id)!.add(other);
      forbidden.get(other)!.add(n.id);
    }
  }

  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const merge = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const small = members.get(ra)!.size <= members.get(rb)!.size ? ra : rb;
    const big = small === ra ? rb : ra;
    for (const m of members.get(small)!) {
      for (const f of forbidden.get(m)!) if (members.get(big)!.has(f)) return;
    }
    parent.set(small, big);
    for (const m of members.get(small)!) members.get(big)!.add(m);
    members.delete(small);
  };

  for (const n of ordered) {
    for (const other of n.positives) if (known.has(other) && other !== n.id) merge(n.id, other);
  }

  const withCause = ordered.filter((n) => causeTokens(n.humanCause).size > 0);
  const pairs: Array<[number, string, string]> = [];
  for (let i = 0; i < withCause.length; i++) {
    for (let j = i + 1; j < withCause.length; j++) {
      const s = causeSimilarity(withCause[i].humanCause, withCause[j].humanCause);
      if (s >= threshold) pairs.push([s, withCause[i].id, withCause[j].id]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0]);
  for (const [, a, b] of pairs) merge(a, b);

  const clusterId = new Map<string, string>();
  for (const [root, set] of members) {
    const id = [...set].sort(compareIdentifiers)[0] ?? root;
    for (const m of set) clusterId.set(m, id);
  }
  return new Map(ordered.map((n) => [n.id, clusterId.get(find(n.id)) ?? n.id]));
}
