/**
 * Ngữ cảnh giàu cho ticket tương tự — MỘT nguồn duy nhất, gọi từ CẢ production
 * (worker/kg-sync.ts, lúc ghi ticket Done vào KG) LẪN benchmark
 * (scripts/eval-similar-bench.ts). Chốt 27/09 sau khi phát hiện: đo trên
 * benchmark mù, production (chỉ symptomsText/humanCause/humanFix cô đọng)
 * chỉ đạt 1-2/18 trả lời vì LLM hiếm khi đủ căn cứ báo confidence "high" —
 * thiếu hẳn mô tả gốc + ghi chú xử lý đầy đủ mà researcher A cho LLM xem.
 * Không tách riêng bản "cho eval" khác bản "cho production": benchmark phải
 * đo đúng cái production THẬT SỰ chạy, không thì số đo vô nghĩa.
 *
 * - description: lời người báo + xử lý, đã bỏ khối bot sinh ("## Thông tin sự
 *   cố", "### Chẩn đoán & Gợi ý", chữ ký nguồn) — không phải nguyên văn description.
 * - humanNotes: toàn bộ comment của NGƯỜI (isSystemActor loại bot), comment
 *   ghim xếp trước — không chỉ câu Nguyên nhân/Cách khắc phục cô đọng.
 * - system/product: bóc từ metadata description (incident-meta.ts).
 */
import { isSystemActor } from "./human-signals";
import { parseIncidentMeta } from "./incident-meta";
import { isBotComment, stripCommentHtml } from "@vuihoc/bot-core/core";

// Boilerplate Onyx tự sinh (thông báo nạp/không nạp bài học kinh nghiệm) —
// không mang dấu <!-- intake-bot --> nhưng vẫn không phải tín hiệu người.
const ONYX_BOILERPLATE_MARKERS = [
  "[Onyx Second Brain]",
  "Onyx Ingestion",
  "Không lưu vào kho tri thức",
  "Đã nạp bài học kinh nghiệm",
];

/**
 * Comment do BOT ghi — không phải tín hiệu người thật. Kết hợp 3 cách nhận
 * diện (dấu `<!-- intake-bot -->`, actor hệ thống theo tên, boilerplate Onyx)
 * vì một bot đôi khi bình luận dưới tên KHÔNG khớp isSystemActor (vd "Iris")
 * nhưng vẫn mang dấu marker — chỉ lọc theo tên actor sẽ bỏ sót, khiến comment
 * bot đổi nội dung "giả" (fingerprint đổi dù không có tín hiệu người mới),
 * làm ticketContentFingerprint nạp lại lãng phí.
 */
export function isBotAuthoredComment(item: {
  actorName?: unknown;
  actor?: unknown;
  body?: unknown;
}): boolean {
  const body = String(item.body ?? "");
  return (
    isBotComment(body) ||
    isSystemActor(item.actorName ?? item.actor) ||
    ONYX_BOILERPLATE_MARKERS.some((m) => body.includes(m))
  );
}

export interface SimilarContext {
  description: string;
  humanNotes: string;
  system?: string;
  product?: string;
}

/**
 * Trần AN TOÀN lúc lưu trữ (chặn ticket có luồng comment cực dài phình node
 * Memgraph) — KHÔNG phải trần "vừa khít prompt": lib/kg/similar-judge.ts đã
 * tự cắt còn 900/1400 ký tự lúc build prompt LLM. Để nguyên description ở
 * đây (không cắt sớm) vì worker/kg-sync.ts còn dùng lại giá trị này làm đầu
 * vào cho synthesizeTicketKnowledge (trích Nguyên nhân/Cách khắc phục) — cắt
 * sớm ở tầng dùng chung sẽ làm mất dữ kiện của bước đó với ticket dài.
 */
const MAX_DESCRIPTION = 6000;
const MAX_HUMAN_NOTES = 6000;

/** Bỏ thẻ HTML comment (<video>/<mark>/<span>), ảnh markdown, thẻ <img>, URL, gộp khoảng trắng thừa. */
export function cleanText(s: string | null | undefined): string {
  return stripCommentHtml(String(s ?? ""))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mô tả gốc đã bỏ các khối do BOT sinh — không phải lời người báo/xử lý thật:
 * comment ẩn <!-- --> (metadata JSON), khối "## Thông tin sự cố" (tóm tắt
 * trường dữ liệu), TOÀN BỘ mục "### Chẩn đoán & Gợi ý" (chẩn đoán bot suy ra
 * từ ticket KHÁC — lẫn vào là ticket tự "gợi ý" trùng khớp với chính nó), dòng
 * "Người báo:", chữ ký "*Nguồn: ...*".
 */
export function cleanIncidentDescription(description: string | null | undefined): string {
  const stripped = String(description ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^##\s*Thông tin sự cố[\s\S]*?(?=###\s*Mô tả)/m, "")
    // KHÔNG dùng flag /m ở đây: dưới /m, "$" trong lookahead khớp cuối MỖI
    // dòng (không phải cuối chuỗi), khiến [\s\S]*? (lazy) dừng ngay sau dòng
    // đầu tiên của mục thay vì tới hết mục — bot vẫn lọt qua. "(?:^|\n)" thay
    // cho "^" để vẫn khớp đầu dòng mà không cần /m.
    .replace(/(?:^|\n)###\s*(?:Chẩn đoán|Gợi ý)[^\n]*\n?([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/g, "")
    .replace(/^[-*]\s*Người báo:[^\n]*\n?/gm, "")
    .replace(/\*Nguồn:[^\n]*\*/g, "");
  return cleanText(stripped);
}

/**
 * Dựng ngữ cảnh giàu từ issue + timeline thô (đúng shape Itsaplan trả về, hoặc
 * dump/kb.json tương đương — xem scripts/eval-similar-bench.ts).
 */
export function similarContextOf(
  issue: { description?: string | null },
  timeline:
    | Array<{ kind?: string; actorName?: unknown; body?: unknown; pinned?: boolean }>
    | null
    | undefined,
): SimilarContext {
  const meta = parseIncidentMeta(issue.description ?? "");
  const comments = (timeline ?? [])
    .filter(
      (tl): tl is { kind?: string; actorName?: unknown; body: string; pinned?: boolean } =>
        tl?.kind === "comment" &&
        typeof tl.body === "string" &&
        tl.body.trim().length > 0 &&
        !isBotAuthoredComment(tl),
    )
    .slice()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const humanNotes = comments
    .map((c) => cleanText(c.body))
    .filter(Boolean)
    .join("\n---\n")
    .slice(0, MAX_HUMAN_NOTES);

  return {
    description: cleanIncidentDescription(issue.description).slice(0, MAX_DESCRIPTION),
    humanNotes,
    system: meta.system || undefined,
    product: meta.product || undefined,
  };
}
