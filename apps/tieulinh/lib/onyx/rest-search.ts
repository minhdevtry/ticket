import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import { findIssueByIdentifier, parseIdentifier } from "@vuihoc/bot-core/itsaplan";
import { ProjectColumnStates } from "@vuihoc/bot-core/itsaplan";
import { gonCauHoi } from "./client";
import { redactIncidentPII } from "@vuihoc/bot-core/core";
import { getLogger } from "@vuihoc/bot-core/core";
import { systemAliasesFor } from "../kg/system-taxonomy";
import type { SimilarTicketItem } from "../intake-document/types";

/**
 * Trích NGUYÊN NHÂN/GIẢI PHÁP từ nội dung tài liệu Onyx đã ingest (hỗ trợ cả
 * format cũ lẫn mới có dấu hai chấm). Xuất riêng để dùng lại làm "tóm tắt bổ
 * sung" khi LLM xác minh ticket tương tự (lib/kg/similar-ticket-source.ts) —
 * đây là dữ liệu Onyx đã trích sẵn (pipeline ingest khác, ngoài phạm vi module
 * này), không phải KG, nên không đảm bảo là tín hiệu người đã xác nhận.
 */
export function extractRootCauseAndResolution(fullText: string): {
  rootCause?: string;
  resolution?: string;
} {
  const rootCauseMatch = fullText.match(
    /NGUYÊN NHÂN(?:\s*GỐC\s*RỄ)?:?\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nGIẢI\s*PHÁP|\nCÁCH\s*KHẮC\s*PHỤC|$)/i,
  );
  const fixMatch = fullText.match(
    /(?:GIẢI\s*PHÁP\s*XỬ\s*LÝ|CÁCH\s*KHẮC\s*PHỤC)[^:\n]*:?\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nHƯỚNG\s*DẪN|\nCÁCH\s*PHÒNG\s*TRÁNH|$)/i,
  );
  // 1500 (không phải 300 trước đây): cắt ngắn hơn hay cắt đứt câu "thông báo
  // lỗi nguyên văn" (trong ngoặc kép) ở cuối đoạn — quote-gate.ts cần ngoặc
  // đóng nguyên vẹn để nhận diện, cắt hụt là mất luôn bằng chứng khớp chữ ký.
  return {
    rootCause: rootCauseMatch ? rootCauseMatch[1].trim().slice(0, 1500) : undefined,
    resolution: fixMatch ? fixMatch[1].trim().slice(0, 1500) : undefined,
  };
}

export interface OnyxRestSearchConfig {
  baseUrl: string;
  apiKey: string;
  documentSets?: string[];
  maxResults?: number;
}

export class OnyxRestSearchClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly documentSets: string[];
  private readonly maxResults: number;
  /**
   * Cache trạng thái cột theo dự án. Giữ ở instance (không tạo mới mỗi lượt
   * search) vì client này sống suốt vòng đời worker/MCP — mỗi lượt search chỉ
   * tốn thêm 1 request listProjectColumns cho mỗi dự án, không phải mỗi ứng viên.
   */
  private columnStates?: ProjectColumnStates;

  constructor(
    config: OnyxRestSearchConfig,
    private readonly itsaplan?: ItsaplanClient,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.documentSets = config.documentSets || [
      "ticket-history",
      "tech-done-tickets",
      "intake-test-done",
      "kg-cause-taxonomy",
    ];
    this.maxResults = config.maxResults || 20;
  }

  /**
   * Tra cứu vé tương tự qua REST POST /api/search có hỗ trợ tags lọc hệ thống
   */
  async searchSimilar(
    queryText: string,
    system?: string,
    excludeIdentifier?: string,
  ): Promise<SimilarTicketItem[]> {
    if (!this.apiKey || !queryText.trim()) return [];

    const cleanQuery = gonCauHoi(redactIncidentPII(queryText));
    if (!cleanQuery) return [];

    const tagsList: Array<Array<{ tag_key: string; tag_value: string }>> = [];
    if (system && system.trim()) {
      // Hệ thống chuẩn hoá 9 giá trị (taxonomy.ts) nhưng Onyx ingest KHÔNG gắn
      // `tag_key=system` lúc ingest (worker/ingest.service.ts chỉ ghi
      // ticket_id/status/root_cause/resolution), và ingest cũ từng ghi nhãn hệ
      // thống dưới dạng plain text trong content. Tìm theo EQUAL chỉ 1 alias sẽ
      // trả 0 với phần lớn vé — phải hỏi theo UNION alias (chuẩn + absorbs cũ).
      // Nếu vẫn 0, fallback bỏ tag filter để candidate vẫn chảy qua soft-filter
      // phía sau (header `TECH-NN · <system> ·` regex đã có ở client.ts:266).
      const aliases = systemAliasesFor(system);
      if (aliases.length > 0) {
        // Một truy vấn / alias — Onyx EQUAL trên tag_value (không substring).
        for (const alias of aliases) {
          tagsList.push([{ tag_key: "system", tag_value: alias }]);
        }
        tagsList.push([]); // fallback no-tags để chắt lọc còn hơn 0
      }
    }
    // Khi không có system, vẫn phải gọi Onyx 1 lần không tag để tương thích test
    // cũ + caller không truyền system. Tránh tạo mảng [[]] rỗng gây skip loop.
    if (tagsList.length === 0) {
      tagsList.push([]);
    }

    const rawResults: any[] = [];
    for (const tags of tagsList) {
      if (tagsList.length > 1 && rawResults.length >= this.maxResults) break;
      const payload: Record<string, any> = {
        query: cleanQuery,
        document_sets: this.documentSets,
        skip_query_expansion: true,
      };
      if (tags.length > 0) {
        payload.tags = tags;
      }
      try {
        const res = await fetch(`${this.baseUrl}/api/search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });

        if (res.ok) {
          const body = (await res.json()) as { results?: any[] };
          rawResults.push(...(body.results || []));
        } else {
          getLogger().warn(
            `[OnyxRestSearch] /api/search non-2xx (status=${res.status}) query=${cleanQuery.slice(0, 80)}`,
          );
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        getLogger().warn(
          `[OnyxRestSearch] search failed (${e.name}: ${e.message?.slice(0, 120) ?? "unknown"}); query=${cleanQuery.slice(0, 80)}`,
        );
        return [];
      }
    }

    const seen = new Set<string>();
    if (excludeIdentifier) {
      seen.add(excludeIdentifier.toUpperCase());
    }

    const candidates: SimilarTicketItem[] = [];

    // Từ dừng tiếng Việt cơ bản để tính lexical overlap
    const STOPWORDS = new Set([
      "a",
      "à",
      "ạ",
      "ơi",
      "em",
      "anh",
      "chị",
      "bị",
      "là",
      "và",
      "có",
      "của",
      "cho",
      "các",
      "được",
      "không",
      "khi",
      "thì",
      "với",
      "đã",
      "đang",
      "sẽ",
      "nhưng",
      "do",
      "ở",
      "vào",
      "ra",
      "lại",
      "này",
      "đó",
      "nào",
      "gì",
      "sao",
      "thế",
      "hãy",
      "giúp",
    ]);
    const queryTokens = cleanQuery
      .toLowerCase()
      .replace(
        /[^a-z0-9àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ\s_-]/g,
        " ",
      )
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

    for (const r of rawResults) {
      const fullText = `${r.title ?? ""} ${r.content ?? ""}`;
      const matches = fullText.match(/\b(TECH-\d+)\b/gi);
      if (!matches) continue;

      // Bài học tech lead (audit 25/09 — bot đúng ~40%, 59% bị gỡ): Onyx dense search
      // luôn trả đủ maxResults kể cả khi query off-topic hoặc gibberish.
      // Chặn bot đoán mò theo word-boundary: yêu cầu ≥ OVERLAP_RATIO_MIN (40%)
      // tổng số token thực chất của query phải có mặt trong doc — không chỉ 1 từ
      // duy nhất vì doc rất dài chứa đủ từ ngữ chung (học, sinh, app, bộ phận...).
      // Đặt ngưỡng thấp (40%) để giữ khả năng đa ngữ nghĩa nhưng đủ khắc chế
      // trường hợp off-topic/gibberish (0 từ khớp → loại).
      // Bổ sung thêm ngưỡng tuyệt đối: ít nhất MIN_ABSOLUTE_MATCHES từ thực chất
      // khớp để chặn kiểu query dài có nhiều từ ngữ chung lĩnh vực (học, sinh,
      // app, lỗi...) ăn may tỷ lệ 40% mà thực chất là câu khác nghiệp vụ.
      // Stopwords mở rộng: từ xuất hiện trong HẦU HẾT doc giáo dục trực tuyến
      // (học, sinh, app, lỗi, ...) — bỏ để match phải vào từ ngữ nghĩa riêng.
      const DOMAIN_STOPWORDS = new Set([
        "học",
        "sinh",
        "phụ",
        "huynh",
        "báo",
        "lỗi",
        "app",
        "vuihoc",
        "vui",
        "học",
        "làm",
        "được",
        "phải",
        "cần",
        "tôi",
        "mình",
        "chị",
        "em",
        "anh",
        "hệ",
        "thống",
        "trường",
        "lớp",
        "video",
        "xem",
        "đã",
        "vẫn",
      ]);
      const filteredQueryTokens = queryTokens.filter((t) => !DOMAIN_STOPWORDS.has(t));
      const effTokens = filteredQueryTokens.length > 0 ? filteredQueryTokens : queryTokens;
      const OVERLAP_RATIO_MIN = 0.4;
      const MIN_ABSOLUTE_MATCHES = 2;
      if (effTokens.length > 0) {
        const docWords = new Set(
          fullText
            .toLowerCase()
            .replace(
              /[^a-z0-9àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ\s_-]/g,
              " ",
            )
            .split(/\s+/)
            .filter((w) => w.length >= 2),
        );
        const matched = effTokens.filter((tok) => docWords.has(tok)).length;
        const ratio = matched / effTokens.length;
        // Đạt yêu cầu khi: tỷ lệ ≥ ngưỡng VÀ số từ tuyệt đối ≥ MIN_ABSOLUTE_MATCHES
        // Query rất ngắn (≤2 token) chỉ cần ≥ ratio + matched ≥ 1.
        if (
          ratio < OVERLAP_RATIO_MIN &&
          (matched < MIN_ABSOLUTE_MATCHES || effTokens.length < MIN_ABSOLUTE_MATCHES)
        )
          continue;
      }

      for (const m of matches) {
        const code = m.toUpperCase();
        if (seen.has(code)) continue;
        seen.add(code);

        const { rootCause, resolution } = extractRootCauseAndResolution(fullText);
        const candidate: SimilarTicketItem = {
          identifier: code,
          title: r.title || `Sự cố ${code}`,
          system,
          rootCause,
          resolution,
          link:
            r.link ||
            r.url ||
            `${process.env.ITSAPLAN_WEB_URL?.replace(/\/+$/, "") || "https://itsaplan.example.com"}/workbench/vuihoc/tracker/${code}`,
          verifiedOnTracker: false,
          source: "onyx",
        };

        candidates.push(candidate);
        if (candidates.length >= this.maxResults * 2) break;
      }
    }

    // Xác thực tồn tại trên Itsaplan (loại bỏ vé ảo/hallucination)
    if (!this.itsaplan || candidates.length === 0) {
      return candidates.slice(0, this.maxResults);
    }

    // Bài học tech lead (25/09): "tồn tại trên tracker" KHÁC "đáng gợi ý" — vé đã
    // huỷ vẫn tồn tại nên lọt nguyên 5/5 vào Related Tickets rồi bị người gỡ tay.
    // Tra trạng thái thật theo columnId (cùng cách phân loại với ticket-closure)
    // và bỏ hẳn vé canceled. Vé Done mà tài liệu Onyx không trích được
    // rootCause/resolution chỉ còn cái mã — không hạ bậc bằng lọc cứng (eval gold
    // cho thấy lọc cứng làm rớt recall) mà xếp sau vé có tri thức thật.
    this.columnStates ??= new ProjectColumnStates(this.itsaplan);
    const columnStates = this.columnStates;
    const verifiedList: SimilarTicketItem[] = [];

    for (const cand of candidates) {
      const parsed = parseIdentifier(cand.identifier);
      if (!parsed) continue;

      try {
        const issue = await findIssueByIdentifier(this.itsaplan, cand.identifier);
        if (issue && issue.id) {
          // Bài học tech lead (audit 25/09): vé đã huỷ/archived vẫn tồn tại trên
          // tracker nhưng KHÔNG còn là tri thức đáng gợi ý. Lọc sớm tại đây
          // (cùng nguyên tắc với memgraph-client.queryRelatedTickets) — trước
          // đây chỉ dựa vào columnStates (cần gọi API), giờ kết hợp cả
          // stateType Itsaplan trả sẵn để chặn ngay trước khi đụng cache cột.
          if (issue.stateType === "canceled" || issue.archivedAt) continue;
          const state = await columnStates
            .stateOf(parsed.projectKey, issue.columnId)
            .catch(() => null);
          if (state?.state === "canceled") continue;
          cand.verifiedOnTracker = true;
          if (issue.title) cand.title = issue.title;
          verifiedList.push(cand);
        }
      } catch {
        // Vé không tồn tại trên tracker -> Bỏ qua
      }

      if (verifiedList.length >= this.maxResults * 2) break;
    }

    // Xác thực tồn tại xong mới xếp hạng: vé có rootCause/resolution lên trước.
    const rank = (t: SimilarTicketItem) => (t.rootCause || t.resolution ? 0 : 1);
    const ordered = verifiedList
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
      .map((x) => x.t);

    return ordered.slice(0, this.maxResults);
  }
}
