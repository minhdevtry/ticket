/**
 * ADR-0008, quyết định 7 ý 2: kỹ thuật viên tuyên bố một ticket trùng ticket
 * khác bằng một bình luận trên chính ticket trùng — ví dụ trên TECH-944:
 * "@tieulinh Báo trùng TECH-943 => Hủy TECH-944" (X=944 trùng Y=943, gộp
 * TECH-944 vào TECH-943). Module này đọc bình luận đó, hỏi LLM để phân biệt
 * "tuyên bố trùng" khỏi "chỉ nhắc tới" (tham khảo, giống ca cũ, nhờ xử lý...),
 * và khi LLM khẳng định (có trích câu làm bằng chứng) mới:
 *   1. Chép phần "Mô tả" (+ ảnh đính kèm) của X sang một bình luận trên Y.
 *   2. Nối link X→Y loại "duplicates" nếu chưa có.
 *   3. Chuyển X sang cột canceled (nếu chưa) và ghi chú lại trên X.
 *
 * Đây KHÔNG trái ADR-0006 ("chỉ người xử lý đóng ticket"): ADR-0006 cấm bot tự
 * đóng một ticket ĐANG ĐƯỢC XỬ LÝ vì bot không có quyền kết luận việc đã xong.
 * Ở đây ticket X không "xong" — nó là TICKET RÁC do trùng lặp, và chính kỹ
 * thuật viên (người xử lý) đã xác nhận điều đó bằng lời trong bình luận; bot
 * chỉ thực thi đúng những gì người xử lý vừa tuyên bố, không tự suy đoán.
 *
 * Lọc thô bằng regex mã ticket trước khi gọi LLM — phần lớn bình luận không
 * nhắc ticket khác, không cần tốn lượt LLM cho chúng. LLM chỉ dùng để phân
 * loại phần còn lại; lỗi LLM/API thì chỉ log và bỏ qua, không đoán.
 */
import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import type { TicketBindingRepository } from "../lib/storage/binding-repository";
import { findIssueByIdentifier } from "@vuihoc/bot-core/itsaplan";
import { isSystemActor } from "../lib/kg/human-signals";
import { symptomsOfDescription } from "../lib/kg/similar-finder";
import {
  markBotComment,
  isBotComment,
  formatIctTimestamp,
  stripCommentHtml,
} from "@vuihoc/bot-core/core";
import { complete, extractJson, isLlmConfigured, type LlmConfig } from "./llm";
import { projectOfIdentifier } from "@vuihoc/bot-core/itsaplan";
import { getLogger } from "@vuihoc/bot-core/core";

/** Mã ticket dạng "TECH-123" nhắc trong một câu — dùng để lọc thô trước khi gọi LLM. */
const TICKET_MENTION = /\b([A-Za-z][A-Za-z0-9_]*-\d+)\b/g;

/** Các dòng ảnh markdown `![alt](url)` xuất hiện bất kỳ đâu trong mô tả — không chỉ dưới mục Mô tả. */
function markdownImageLines(description: string): string[] {
  const lines = new Set<string>();
  for (const m of String(description ?? "").matchAll(/!\[[^\]]*\]\([^)]*\)/g)) lines.add(m[0]);
  return [...lines];
}

/** Mã ticket khác X, cùng dự án X, được nhắc trong bình luận (không trùng lặp, giữ thứ tự xuất hiện). */
export function mentionedSiblingTickets(commentBody: string, selfIdentifier: string): string[] {
  const self = selfIdentifier.toUpperCase();
  const project = projectOfIdentifier(selfIdentifier);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of stripCommentHtml(commentBody).toUpperCase().matchAll(TICKET_MENTION)) {
    const code = m[1];
    if (code === self || seen.has(code)) continue;
    if (project && projectOfIdentifier(code) !== project) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export interface DuplicateJudgement {
  duplicate: boolean;
  /** Câu trích nguyên văn làm bằng chứng — bắt buộc khi `duplicate` true. */
  evidence?: string;
}

/** Hỏi LLM: bình luận trên `xIdentifier` có tuyên bố X là bản trùng nên gộp vào `yIdentifier` không. */
export async function judgeDuplicateClaim(
  llm: LlmConfig,
  xIdentifier: string,
  yIdentifier: string,
  commentBody: string,
): Promise<DuplicateJudgement | null> {
  const systemPrompt =
    `Bạn đọc một bình luận của kỹ thuật viên trên hệ thống theo dõi lỗi VuiHoc (Itsaplan). ` +
    `Bình luận nằm trên ticket ${xIdentifier} và có nhắc tới ticket khác ${yIdentifier}. ` +
    `Xác định bình luận có TUYÊN BỐ RÕ RÀNG rằng ${xIdentifier} là bản trùng (duplicate) của ` +
    `${yIdentifier} và nên gộp/huỷ ${xIdentifier} hay không.\n\n` +
    `Ví dụ TUYÊN BỐ TRÙNG (duplicate=true): "Báo trùng TECH-943 => Hủy TECH-944" (viết trên TECH-944).\n` +
    `Ví dụ KHÔNG PHẢI (duplicate=false): "tham khảo TECH-722", "lỗi giống TECH-501 đã xử lý", ` +
    `"@techuser_b xử lý giúp em, liên quan TECH-795" — đây chỉ là tham khảo/nhờ xử lý, không tuyên bố trùng.\n\n` +
    `Chỉ trả duplicate=true khi có câu chữ rõ ràng ("trùng", "duplicate", "gộp vào", "huỷ vì trùng"...). ` +
    `Không suy đoán khi câu mơ hồ.\n\n` +
    `Trả về đúng một JSON: {"duplicate": true|false, "evidence": "<câu trích nguyên văn làm bằng chứng, rỗng nếu false>"}.`;
  const userPrompt = `Bình luận trên ${xIdentifier}:\n"""${stripCommentHtml(commentBody)}"""\n\nTicket được nhắc tới: ${yIdentifier}`;

  const raw = await complete(llm, systemPrompt, userPrompt);
  const parsed = extractJson<{ duplicate?: unknown; evidence?: unknown }>(raw);
  if (!parsed) return null;
  const duplicate = parsed.duplicate === true;
  const evidence = typeof parsed.evidence === "string" ? parsed.evidence.trim() : "";
  return { duplicate: duplicate && evidence.length > 0, evidence: evidence || undefined };
}

export type DuplicateMergeOutcome =
  | { merged: true; target: string }
  | {
      merged: false;
      reason: "no_mention" | "llm_unconfigured" | "not_duplicate" | "already_merged" | "error";
    };

export interface DuplicateMergerOptions {
  itsaplan: Pick<
    ItsaplanClient,
    | "getIssue"
    | "getIssueByNumber"
    | "addComment"
    | "linkIssues"
    | "updateIssue"
    | "listProjectColumns"
    | "getIssueTimeline"
  >;
  llm: LlmConfig;
  /** Dự án worker đang khoá — chỉ dùng để tra cột canceled; ứng viên đã được lọc theo dự án của X. */
  projectKey?: string;
  bindings?: Pick<TicketBindingRepository, "getBindingByIssueId">;
}

function reporterLabelOf(bindings: DuplicateMergerOptions["bindings"], issueId: number): string {
  const username = bindings?.getBindingByIssueId(issueId)?.reporterUsername;
  return username ? `@${username}` : "người báo";
}

/** Bình luận merge đã có trên Y trước đó chưa — chống xử lý lặp khi webhook gửi lại. */
async function alreadyMergedInto(
  itsaplan: DuplicateMergerOptions["itsaplan"],
  yIssueId: number,
  xIdentifier: string,
): Promise<boolean> {
  const marker = `Gộp từ ${xIdentifier}`;
  const timeline = await itsaplan.getIssueTimeline(yIssueId).catch(() => []);
  return timeline.some(
    (item: any) =>
      item?.kind === "comment" &&
      isBotComment(item.body) &&
      String(item.body ?? "").includes(marker),
  );
}

export class DuplicateMerger {
  constructor(private readonly options: DuplicateMergerOptions) {}

  /**
   * Xử lý một bình luận của người thật trên ticket X. Không throw ra ngoài —
   * lỗi LLM/API chỉ được log, không làm gì thêm (không đoán).
   */
  async handleComment(input: {
    issueId: number;
    identifier: string;
    commentBody: string;
    actorName?: string;
  }): Promise<DuplicateMergeOutcome> {
    const { issueId: xIssueId, identifier: xIdentifier, commentBody, actorName } = input;
    try {
      if (isSystemActor(actorName) || isBotComment(commentBody)) {
        return { merged: false, reason: "no_mention" };
      }

      const candidates = mentionedSiblingTickets(commentBody, xIdentifier);
      if (candidates.length === 0) return { merged: false, reason: "no_mention" };

      if (!isLlmConfigured(this.options.llm)) {
        getLogger().info(
          `[DuplicateMerger] ${xIdentifier} nhắc ${candidates.join(", ")} nhưng LLM chưa cấu hình, bỏ qua.`,
        );
        return { merged: false, reason: "llm_unconfigured" };
      }

      for (const yIdentifier of candidates) {
        const judgement = await judgeDuplicateClaim(
          this.options.llm,
          xIdentifier,
          yIdentifier,
          commentBody,
        );
        if (!judgement?.duplicate) continue;

        getLogger().info(
          `[DuplicateMerger] ${actorName ?? "?"} tuyên bố ${xIdentifier} trùng ${yIdentifier}: "${judgement.evidence}".`,
        );
        return await this.merge(xIssueId, xIdentifier, yIdentifier, actorName);
      }
      return { merged: false, reason: "not_duplicate" };
    } catch (err: any) {
      getLogger().error(
        `[DuplicateMerger] Lỗi xử lý bình luận trên ${xIdentifier}: ${err.message}`,
      );
      return { merged: false, reason: "error" };
    }
  }

  private async merge(
    xIssueId: number,
    xIdentifier: string,
    yIdentifier: string,
    actorName: string | undefined,
  ): Promise<DuplicateMergeOutcome> {
    const { itsaplan } = this.options;
    const project = projectOfIdentifier(xIdentifier) ?? this.options.projectKey;
    const ySeq = Number(yIdentifier.split("-").pop());
    if (!project || !Number.isFinite(ySeq)) {
      getLogger().warn(
        `[DuplicateMerger] Không đọc được dự án/số hiệu của ${yIdentifier}, bỏ qua.`,
      );
      return { merged: false, reason: "error" };
    }

    const [xIssue, yIssue] = await Promise.all([
      itsaplan.getIssue(xIssueId),
      findIssueByIdentifier(itsaplan, yIdentifier, project),
    ]);
    if (!yIssue) {
      getLogger().warn(
        `[DuplicateMerger] Không tìm thấy ${yIdentifier} trong dự án ${project} (hoặc đã chuyển dự án), bỏ qua.`,
      );
      return { merged: false, reason: "error" };
    }

    if (await alreadyMergedInto(itsaplan, yIssue.id, xIdentifier)) {
      getLogger().info(
        `[DuplicateMerger] ${xIdentifier} đã gộp vào ${yIdentifier} từ trước, bỏ qua (idempotent).`,
      );
      return { merged: false, reason: "already_merged" };
    }

    const description = symptomsOfDescription(xIssue.description);
    const images = markdownImageLines(xIssue.description);
    const created = xIssue.createdAt ? formatIctTimestamp(new Date(xIssue.createdAt)) : "";
    const who = reporterLabelOf(this.options.bindings, xIssueId);
    const header = `🔀 Gộp từ ${xIdentifier} (${who}${created ? `, ${created}` : ""}):`;
    const body = [
      header,
      "",
      description || "(không có mô tả)",
      ...(images.length ? ["", ...images] : []),
    ].join("\n");
    await itsaplan.addComment(yIssue.id, markBotComment(body));

    const alreadyLinked = (xIssue.links ?? []).some(
      (l) => l.kind === "duplicates" && l.issue?.identifier === yIdentifier,
    );
    if (!alreadyLinked) {
      await itsaplan.linkIssues(xIssueId, yIssue.id, "duplicates").catch((err: any) => {
        getLogger().warn(
          `[DuplicateMerger] Nối link ${xIdentifier}→${yIdentifier} lỗi: ${err.message}`,
        );
      });
    }

    const columns = await itsaplan.listProjectColumns(project).catch(() => []);
    const canceledColumn = columns.find((c) => c.stateType === "canceled");
    const currentColumn = columns.find((c) => c.id === xIssue.columnId);
    const alreadyCanceled = currentColumn?.stateType === "canceled";

    if (!alreadyCanceled && canceledColumn) {
      await itsaplan.updateIssue(xIssueId, { columnId: canceledColumn.id });
      await itsaplan.addComment(
        xIssueId,
        markBotComment(
          `ℹ️ Đã gộp vào ${yIdentifier} theo xác nhận của ${actorName?.trim() || "kỹ thuật"}.`,
        ),
      );
    } else if (!alreadyCanceled) {
      getLogger().warn(
        `[DuplicateMerger] Dự án ${project} không có cột canceled, không tự chuyển ${xIdentifier}.`,
      );
    }

    return { merged: true, target: yIdentifier };
  }
}
