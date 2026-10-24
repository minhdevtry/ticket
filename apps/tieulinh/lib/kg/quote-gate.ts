/**
 * Chốt chặn quyết định bằng "thông báo lỗi nguyên văn" (chữ trong ngoặc kép) —
 * chữ ký đặc trưng nhất để phân biệt đúng loại lỗi cụ thể trong một chủ đề rộng
 * (nhiều ticket cùng nói "trùng tài khoản" nhưng khác cơ chế). Deterministic,
 * KHÔNG phụ thuộc LLM có tuân thủ prompt hay không — thắng cả khi LLM nói khác.
 *
 * Cổng từ nghiên cứu researcher A (research-similar/A/REPORT.md mục "các hướng
 * đã thử"): chỉ dùng gate này thì đúng 100% nhưng chỉ trả lời 5/18 (quá thận
 * trọng) → dùng làm lớp CHẤP NHẬN/TỪ CHỐI cứng, còn lại (gate "none") rơi về
 * fallback cần LLM "high" + cụm đã có ≥ 2 thành viên (similar-judge.ts).
 */

/** Câu trích dẫn nguyên văn (trong ngoặc kép, 10–200 ký tự) tìm thấy trong các đoạn văn bản. */
export function extractQuotedErrors(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const re = /["“]([^"”]{10,200})["”]/g;
  for (const t of texts) {
    if (!t) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

function normalizeQuote(s: string): Set<string> {
  const toks = s
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .match(/[\p{L}]+/gu) ?? [];
  return new Set(toks.filter((w) => w.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export type QuoteGate = "match" | "conflict" | "none";

/**
 * So khớp "thông báo lỗi nguyên văn" giữa ticket mới và 1 ứng viên:
 * - "none": một trong hai bên (hoặc cả hai) không có câu trích dẫn nào — không
 *   đủ bằng chứng để đối chiếu, rơi về fallback dựa vào LLM + cụm.
 * - "match": có câu trích dẫn ở cả hai bên, và giống nhau (Jaccard ≥ 0.5) —
 *   bằng chứng đủ mạnh để CHẤP NHẬN dù LLM chỉ nói "medium".
 * - "conflict": có câu trích dẫn ở cả hai bên nhưng KHÁC nhau — TỪ CHỐI dù LLM
 *   nói same_root_cause=true (thắng cả LLM).
 */
export function quoteGate(newQuotes: string[], candidateQuotes: string[]): QuoteGate {
  if (candidateQuotes.length === 0 || newQuotes.length === 0) return "none";
  let best = 0;
  for (const q of newQuotes) {
    const qs = normalizeQuote(q);
    for (const c of candidateQuotes) best = Math.max(best, jaccard(qs, normalizeQuote(c)));
  }
  return best >= 0.5 ? "match" : "conflict";
}
