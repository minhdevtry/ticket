/**
 * Phát hiện ticket trùng, theo cách legacy: KHÔNG tự dò khi tạo ticket (cần truy hồi liên quan/KG,
 * nằm ngoài phạm vi), mà bắt tín hiệu của người xử lý. Khi một comment của người nhắc mã ticket
 * anh em trong cùng dự án ("trùng TECH2-7"), LLM phán xem comment đó có thật sự tuyên bố trùng
 * không hay chỉ tham chiếu.
 *
 * Mặc định (sandbox) chỉ để lại MỘT comment gợi ý, không đổi gì khác. Cờ `TIEULINH_DUPLICATE_MERGE`
 * bật hành vi legacy: chép mô tả gốc sang ticket đích, nối link `duplicates`, đưa ticket trùng về
 * cột huỷ. Cờ TẮT mặc định vì nó làm bot huỷ ticket, trái tinh thần ADR-0006 nếu không có người
 * xác nhận (ở đây "xác nhận" là chính comment của người xử lý).
 *
 * Chặn thêm so với legacy: `evidence` do LLM trả phải là đoạn TRÍCH THẬT từ comment của người xử
 * lý. Không có trích dẫn khớp thì coi như không trùng (chống phán bừa và chống chỉ dẫn gài trong mô tả).
 */
import type { RuleAction } from "@vuihoc/bot-core/backoffice";
import { foldForComparison } from "@vuihoc/bot-core/core";
import { extract } from "@vuihoc/bot-core/llm";
import type { Llm } from "@vuihoc/bot-core/llm";
import { z } from "zod";
import { duplicateSuggestionText, mergedFromText, mergedIntoText } from "./copy";
import type { TieulinhConfig } from "./env";

const MAX_SIBLINGS = 3;
const MAX_TEXT = 1500;

const Verdict = z.object({
  duplicate: z.boolean().describe("true nếu comment tuyên bố ticket nguồn trùng với ticket đích"),
  evidence: z
    .string()
    .default("")
    .describe("Đoạn trích NGUYÊN VĂN từ comment của người xử lý cho thấy họ nói trùng"),
});

const INSTRUCTION = [
  "Người xử lý vừa viết một comment trên ticket NGUỒN có nhắc tới ticket ĐÍCH.",
  "Quyết định comment đó có TUYÊN BỐ ticket nguồn trùng (cùng một vấn đề) với ticket đích hay không.",
  "Chỉ nhắc tới, so sánh, hoặc nói 'liên quan' thì KHÔNG phải trùng.",
  "Nếu trùng, trả `evidence` là đoạn trích nguyên văn từ COMMENT (không phải từ mô tả).",
  'Trả JSON: {"duplicate": boolean, "evidence": string}.',
].join("\n");

/** Mã ticket anh em (cùng dự án, khác ticket hiện tại) được nhắc trong comment. */
export function siblingIdentifiers(
  text: string,
  projectKey: string,
  self?: string | null,
): string[] {
  const re = new RegExp(`\\b${projectKey}-(\\d+)\\b`, "gi");
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(`${projectKey}-${m[1]}`.toUpperCase());
  if (self) found.delete(self.toUpperCase());
  return [...found];
}

/** `evidence` có thật sự nằm trong comment không (so khớp bỏ dấu, hoa thường, khoảng trắng). */
export function evidenceInComment(evidence: string, comment: string): boolean {
  const e = foldForComparison(evidence);
  return e.length >= 3 && foldForComparison(comment).includes(e);
}

const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

async function judge(
  llm: Llm,
  comment: string,
  source: { identifier: string; title: string; description: string },
  target: { identifier: string; title: string; description: string },
) {
  const { data } = await extract({
    llm,
    schema: Verdict,
    instruction: INSTRUCTION,
    input: [
      `COMMENT của người xử lý (trên ${source.identifier}):\n${clip(comment)}`,
      `Ticket NGUỒN ${source.identifier}: ${source.title}\n${clip(source.description)}`,
      `Ticket ĐÍCH ${target.identifier}: ${target.title}\n${clip(target.description)}`,
    ].join("\n\n---\n\n"),
  });
  return data;
}

/** Hành động của luật `comment.created`; cờ merge đọc từ `ctx.config.TIEULINH_DUPLICATE_MERGE`. */
export function detectDuplicate(): RuleAction<TieulinhConfig> {
  return async (ctx) => {
    const comment = ctx.event.comment;
    if (!comment) return;
    const source = await ctx.issue();
    if (!source) return;
    const siblings = siblingIdentifiers(
      comment.text,
      ctx.tracker.projectKey,
      source.identifier,
    ).slice(0, MAX_SIBLINGS);
    if (siblings.length === 0) return;
    if (!ctx.llm) {
      ctx.logger.info("[duplicates] chưa cấu hình LLM_*, bỏ qua phát hiện trùng");
      return;
    }

    const columns = await ctx.tracker.columns();
    const sourceState = columns.find((c) => c.id === source.columnId)?.stateType;
    if (sourceState === "completed" || sourceState === "canceled") return;

    for (const identifier of siblings) {
      const target = await ctx.tracker.getIssue(identifier);
      if (!target || target.id === source.id) continue;
      let verdict: z.output<typeof Verdict>;
      try {
        verdict = await judge(ctx.llm, comment.text, source, target);
      } catch (err) {
        // LLM lỗi: không đoán, không thử lại ở đây. Người xử lý vẫn tự gộp được.
        ctx.logger.warn(
          `[duplicates] LLM lỗi khi xét ${source.identifier} ~ ${identifier}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!verdict.duplicate || !evidenceInComment(verdict.evidence, comment.text)) continue;

      if (!ctx.config.TIEULINH_DUPLICATE_MERGE) {
        await ctx.tracker.comment(
          source.id,
          duplicateSuggestionText({ target: target.identifier, evidence: verdict.evidence }),
          { idempotencyKey: `dup:${source.id}:${target.id}` },
        );
        return;
      }

      // Hành vi legacy (cờ bật): chép mô tả gốc (ADR-0010 nguyên văn), nối link, huỷ ticket trùng.
      await ctx.tracker.comment(
        target.id,
        mergedFromText({ source: source.identifier, description: source.description }),
        { idempotencyKey: `dup-merge:${source.id}:${target.id}` },
      );
      try {
        await ctx.tracker.unscopedClient.linkIssues(source.id, target.id, "duplicates");
      } catch (err) {
        ctx.logger.warn(
          `[duplicates] không nối link ${source.identifier} -> ${identifier}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const canceled = columns.find((c) => c.stateType === "canceled");
      if (canceled) {
        await ctx.tracker.moveTo(source.id, canceled.id);
      } else {
        ctx.logger.warn("[duplicates] dự án không có cột huỷ: chỉ ghi chú, không chuyển cột");
      }
      await ctx.tracker.comment(source.id, mergedIntoText({ target: target.identifier }), {
        idempotencyKey: `dup-merged:${source.id}:${target.id}`,
      });
      return;
    }
  };
}
