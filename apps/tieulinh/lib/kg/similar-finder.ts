/**
 * Truy hồi văn bản (BM25) cho ticket tương tự (ADR-0007, spec
 * docs/superpowers/specs/2026-09-26-ticket-tuong-tu-design.md).
 *
 * CHỈ còn là một kênh sinh ứng viên thuần theo chữ — không còn bỏ phiếu cụm
 * hay ngưỡng tự quyết định (minShare/rankDecay/…, xem lib/kg/similar-ticket-source.ts
 * và lib/kg/similar-judge.ts): quyết định "cùng nguyên nhân" giờ do LLM xác minh
 * từng cặp + chốt chặn bằng chữ ký lỗi (quote-gate.ts) + cụm KG, không còn suy
 * ra từ điểm BM25 nữa (kiến trúc mới đo 52% đúng trên benchmark mù, so với 33%
 * của thuật toán bỏ phiếu cũ — xem docs/superpowers/specs/2026-09-26-ticket-tuong-tu-design.md).
 */

export interface CorpusTicket {
  identifier: string;
  title: string;
  /** Phần "Mô tả" của ticket — lời người báo. */
  symptomsText?: string;
  /** Mã cụm nguyên nhân (xem cause-clusters.ts). Thiếu = chưa có tín hiệu người. */
  causeCluster?: string;
  humanCause?: string;
  humanFix?: string;
  resolvedAt?: string;
  /** Mã ticket có REJECTED_RELATION với nó, CẢ HAI CHIỀU. */
  negatives?: string[];
  /**
   * Ngữ cảnh giàu hơn (tuỳ chọn) — mô tả gốc đầy đủ + toàn bộ comment của
   * NGƯỜI (không phải bot), hệ thống/sản phẩm. KG (loadSimilarityCorpus) hiện
   * KHÔNG lưu các trường này (chỉ symptomsText/humanCause/humanFix); chỉ
   * scripts/eval-similar-bench.ts dựng từ kb.json mới điền — cho BM25 và
   * LLM xác minh (similar-judge.ts) nhiều căn cứ hơn khi có, giữ nguyên hành
   * vi cũ (dùng symptomsText) khi không có.
   */
  description?: string;
  humanNotes?: string;
  system?: string;
  product?: string;
}

export interface SimilarMember extends CorpusTicket {
  /** Điểm BM25 nếu ticket nằm trong top N. */
  score?: number;
}

/**
 * Một cụm nguyên nhân KHÔNG được ghi vào Related Tickets/link — chỉ để HIỂN THỊ
 * cho người xử lý biết còn khả năng khác, gắn nhãn rõ "chưa chắc" (xem TECH-956,
 * lib/kg/similar-ticket-source.ts).
 */
export interface PossibleCluster {
  clusterId: string;
  cause?: string;
  fix?: string;
  /** Tối đa 3 ticket ví dụ cho cụm này. */
  sampleIds: string[];
}

export interface SimilarMatch {
  clusterId: string | null;
  /** Tỉ lệ điểm của cụm thắng — giữ lại cho tương thích type cũ; kiến trúc mới luôn 1 khi có members. */
  share: number;
  members: SimilarMember[];
  /** Nguyên nhân + cách khắc phục người viết, lấy từ ticket khớp nhất có đủ hai mục. */
  advice?: { cause: string; fix: string; from: string };
  /**
   * Khi ứng viên được chấp nhận rơi vào ≥ 2 cụm nguyên nhân khác nhau: không ghi
   * gì (members rỗng), thay vào đó một câu hỏi phân biệt ngắn cho người xử lý
   * (lib/kg/similar-judge.ts::askDiscriminatingQuestion).
   */
  question?: string;
  /**
   * Cụm "có thể liên quan nhưng chưa chắc" — LLM nói same_root_cause=true (và
   * quote-gate không bác thẳng) nhưng chưa đạt ngưỡng ghi Related Tickets, hoặc
   * các cụm accepted rơi vào ≥ 2 cụm khác nhau ở trên. CHỈ để hiển thị, không
   * bao giờ ghi link/field (xem TECH-956).
   */
  possible?: PossibleCluster[];
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

const ABBR: Record<string, string> = {
  tk: "tai khoan",
  hs: "hoc sinh",
  ko: "khong",
  k: "khong",
  kh: "khong",
  dc: "duoc",
  ph: "phu huynh",
  sdt: "so dien thoai",
  gs: "gia su",
  cts: "contact",
  bt: "binh thuong",
  ng: "nguoi",
};
const STOP = new Set(
  "va la cua cho khi thi da dang se co ben cac nhung duoc bi do nen em anh chi oi nhe voi tren trong mot nay lai vao ra thay giup".split(" "),
);

/** Từ đơn (bỏ dấu, mở viết tắt) + cặp từ đôi `a_b` — tiếng Việt nghĩa nằm ở cụm hai âm tiết. */
export function searchTokens(text: string): string[] {
  const words: string[] = [];
  const cleaned = fold(String(text ?? ""))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ");
  for (const w of cleaned.split(" ")) {
    if (!w || /^\d+$/.test(w)) continue;
    for (const part of (ABBR[w] ?? w).split(" ")) {
      if (part.length > 1 && !STOP.has(part)) words.push(part);
    }
  }
  const pairs = words.slice(1).map((w, i) => `${words[i]}_${w}`);
  return [...words, ...pairs];
}

/**
 * Lời người báo trong mô tả ticket (mục "### Mô tả", dạng trích dẫn `> …`).
 * Bỏ mục "Chẩn đoán & Gợi ý" — đó là chữ bot sinh từ ticket khác, lẫn vào là
 * tìm kiếm tự khớp với gợi ý cũ của chính nó.
 */
export function symptomsOfDescription(description: string | null | undefined): string {
  const m = String(description ?? "").match(/###\s*Mô tả\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/);
  if (!m) return "";
  return m[1]
    .split("\n")
    .filter((l) => !/callback_data/i.test(l))
    .map((l) => l.replace(/^\s*>\s?/, "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

interface IndexedDoc {
  ticket: CorpusTicket;
  tf: Map<string, number>;
  length: number;
}

const K1 = 1.2;
const B = 0.75;

export const DEFAULT_TOP_N = 14;

/** Kho ticket hoàn tất + chỉ mục BM25 trên tiêu đề + mô tả — kênh ứng viên lexical thuần. */
export class SimilarityIndex {
  private readonly docs: IndexedDoc[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(corpus: CorpusTicket[]) {
    this.docs = corpus.map((ticket) => {
      // Tiêu đề x2 (nhấn trọng số) + mô tả gốc đầy đủ (khi có, ưu tiên hơn
      // symptomsText đã cắt) + ghi chú xử lý của người — khớp đúng tài liệu
      // BM25 mà researcher A dùng (title×2 + description + human notes).
      const body = ticket.description ?? ticket.symptomsText ?? "";
      const tokens = searchTokens(`${ticket.title ?? ""}\n${ticket.title ?? ""}\n${body}\n${ticket.humanNotes ?? ""}`);
      const tf = new Map<string, number>();
      for (const tk of tokens) tf.set(tk, (tf.get(tk) ?? 0) + 1);
      for (const tk of tf.keys()) this.df.set(tk, (this.df.get(tk) ?? 0) + 1);
      return { ticket, tf, length: tokens.length };
    });
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  get corpus(): CorpusTicket[] {
    return this.docs.map((d) => d.ticket);
  }

  /** Top N ticket khớp chữ nhất (BM25), đã bỏ `excludeIds`. */
  search(queryText: string, options: { excludeIds?: string[]; topN?: number } = {}): Array<{ ticket: CorpusTicket; score: number }> {
    const topN = options.topN ?? DEFAULT_TOP_N;
    const excluded = new Set((options.excludeIds ?? []).map((x) => x.toUpperCase()));
    const query = new Set(searchTokens(queryText));
    if (!query.size) return [];
    const N = this.docs.length;
    const scored: Array<{ ticket: CorpusTicket; score: number }> = [];
    for (const doc of this.docs) {
      if (excluded.has(doc.ticket.identifier.toUpperCase())) continue;
      let score = 0;
      for (const tk of query) {
        const f = doc.tf.get(tk);
        if (!f) continue;
        const df = this.df.get(tk) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / this.avgLength));
      }
      if (score > 0) scored.push({ ticket: doc.ticket, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topN);
  }
}
