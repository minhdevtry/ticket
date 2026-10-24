/**
 * Chốt ticket tương tự khi người (tech lead) đã ghim Nguyên nhân / Cách khắc phục
 * — bước cuối của vòng: gợi ý lúc tạo ticket → cập nhật → chốt lúc có nguyên
 * nhân (ADR-0007, spec docs/superpowers/specs/2026-09-26-ticket-tuong-tu-design.md).
 *
 * Itsaplan bắn `comment.updated` khi ghim/sửa comment và `comment.created` khi
 * viết mới; worker gọi `schedule(issueId)`, đợi một lúc (người thường viết rồi
 * mới ghim) rồi chạy một lần:
 * - Related Tickets = cả cụm cùng nguyên nhân + chính nó (tech lead dặn 22/09);
 * - thêm link còn thiếu; gỡ link BOT gắn sang ticket đã biết là khác nguyên nhân;
 * - thêm mã ticket này vào Related Tickets của các ticket cũ cùng cụm (23/09:
 *   "vẫn phải làm tay những ticket cũ đã đóng rồi nhưng có thêm ticket tương tự").
 * Không bao giờ gỡ thứ người đã gắn. Ticket IT Support xử lý như mọi ticket TECH (người dùng chốt 27/09).
 */
import type { ItsaplanClient, ItsaplanIssue, ProjectColumn } from "../lib/itsaplan/client";
import { classifyColumn } from "../lib/itsaplan/ticket-state";
import { findIssueByIdentifier } from "../lib/itsaplan/project";
import { humanKnowledgeOf, isSystemActor } from "../lib/kg/human-signals";
import { planRelatedTickets, planSuggestedTickets, type RelatedPlan } from "../lib/kg/related-plan";
import { symptomsOfDescription, type CorpusTicket } from "../lib/kg/similar-finder";
import type { SimilarTicketSource } from "../lib/kg/similar-ticket-source";
import { getLogger } from "../lib/logger";
import { identifierInProject } from "./project-lock";
import { resolveRelatedTicketsFieldId } from "./related-tickets-sync";

export type CuratorStatus =
  | "applied"
  | "dry_run"
  | "unchanged"
  | "no_human_cause"
  | "other_project"
  | "error";

export interface CuratorResult {
  status: CuratorStatus;
  mode?: "pinned" | "suggested";
  identifier?: string;
  fieldBefore?: string;
  plan?: RelatedPlan;
  /** Ticket cũ cùng cụm chưa có mã ticket này trong Related Tickets. */
  propagate?: string[];
  error?: string;
}

export interface RelatedTicketsCuratorOptions {
  itsaplan: Pick<
    ItsaplanClient,
    | "getIssue"
    | "getIssueTimeline"
    | "getIssueByNumber"
    | "getProject"
    | "listCustomFields"
    | "setCustomFieldValue"
    | "addLink"
    | "deleteLink"
    | "listProjectColumns"
  >;
  corpus: { loadSimilarityCorpus(projectKey: string): Promise<CorpusTicket[]> };
  projectKey: string;
  /**
   * Nguồn ticket tương tự cho ticket CHƯA ghim (mode "suggested") — KG + Onyx +
   * BM25 + LLM xác minh từng cặp (lib/kg/similar-ticket-source.ts). Không có
   * thì nhánh suggested không gợi ý gì (chỉ dọn theo mã/link người đã gắn).
   * Ticket ĐÃ ghim (mode "pinned") dùng planRelatedTickets, không đụng tới đây.
   */
  similarSource?: SimilarTicketSource;
  /** Chỉ tính và ghi log, không ghi Itsaplan. */
  dryRun?: boolean;
  /** Chỉ xử lý ticket đúng nhánh này (chạy chốt hàng loạt từng đợt); ticket nhánh kia trả "unchanged". */
  onlyMode?: "pinned" | "suggested";
  /** Đợi sau sự kiện cuối trước khi chạy. Mặc định 90 giây. */
  delayMs?: number;
  /** TTL cache corpus (mặc định 5 phút). */
  ttlMs?: number;
  now?: () => number;
}

const RELATED_FIELD = /related.*ticket/i;
const KEY = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
const byIdentifier = (a: string, b: string) =>
  a.replace(/-\d+$/, "").localeCompare(b.replace(/-\d+$/, "")) ||
  Number(a.match(/-(\d+)$/)?.[1] ?? 0) - Number(b.match(/-(\d+)$/)?.[1] ?? 0);

function relatedField(issue: ItsaplanIssue) {
  return issue.fields?.find((f) => RELATED_FIELD.test(f.name ?? ""));
}

/** Server bỏ thuật toán ticket tương tự cũ lúc 15:08 26/09/2026 (GMT+7). */
const OLD_ALGORITHM_UNTIL = process.env.OLD_SIMILAR_ALGORITHM_UNTIL ?? "2026-09-26T08:08:00Z";
const BURST_MIN = 5;
const BURST_WINDOW_MS = 120_000;

/**
 * Mã do thuật toán cũ ghi hàng loạt: bot gắn ≥ 5 link trong 2 phút, hoặc một lần sửa trường
 * Related Tickets thêm ≥ 5 mã — trước mốc bỏ thuật toán cũ. Dấu hiệu rác 12–55 mã/ticket.
 */
export function oldAlgorithmJunk(timeline: any[], until = OLD_ALGORITHM_UNTIL): string[] {
  const out = new Set<string>();
  const botLinks = timeline
    .filter(
      (e) =>
        e?.action === "link_add" &&
        isSystemActor(String(e.actorName ?? "")) &&
        String(e.createdAt ?? "") < until,
    )
    .map((e) => ({
      t: Date.parse(String(e.createdAt)),
      id: String(e.payload?.to?.value ?? "").toUpperCase(),
    }))
    .filter((x) => x.id && !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  for (let i = 0; i < botLinks.length; i++) {
    const inWindow = botLinks.filter((x) => Math.abs(x.t - botLinks[i].t) <= BURST_WINDOW_MS);
    if (inWindow.length >= BURST_MIN) for (const x of inWindow) out.add(x.id);
  }
  for (const e of timeline) {
    if (
      e?.kind !== "activity" ||
      !isSystemActor(String(e.actorName ?? "")) ||
      String(e.createdAt ?? "") >= until
    )
      continue;
    if (!RELATED_FIELD.test(String(e.payload?.subject?.value ?? ""))) continue;
    const before = new Set(
      String(e.payload?.from?.value ?? "")
        .toUpperCase()
        .match(KEY) ?? [],
    );
    const added = (
      String(e.payload?.to?.value ?? "")
        .toUpperCase()
        .match(KEY) ?? []
    ).filter((k) => !before.has(k));
    if (added.length >= BURST_MIN) for (const k of added) out.add(k);
  }
  return [...out];
}

export class RelatedTicketsCurator {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private projectColumns: ProjectColumn[] | null = null;
  private relatedFieldId: number | null = null;
  private cachedCorpus: CorpusTicket[] | null = null;
  private loadedAt = 0;

  constructor(private readonly options: RelatedTicketsCuratorOptions) {}

  private async getCorpus(): Promise<CorpusTicket[]> {
    const nowFn = this.options.now ?? Date.now;
    const ttl = this.options.ttlMs ?? 5 * 60 * 1000;
    const now = nowFn();
    if (!this.cachedCorpus || now - this.loadedAt > ttl) {
      this.cachedCorpus = await this.options.corpus.loadSimilarityCorpus(this.options.projectKey);
      this.loadedAt = now;
    }
    return this.cachedCorpus;
  }

  /** Gộp các sự kiện liền nhau của cùng ticket thành một lần chạy. */
  schedule(issueId: number): void {
    const pending = this.timers.get(issueId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(issueId);
      this.run(issueId).catch((err) =>
        getLogger().warn(`[RelatedCurator] #${issueId} lỗi: ${err?.message ?? err}`),
      );
    }, this.options.delayMs ?? 90_000);
    (timer as any).unref?.();
    this.timers.set(issueId, timer);
  }

  private readonly junkCache = new Map<string, string[]>();

  /**
   * Rác của thuật toán cũ xét CẢ HAI đầu link: link lẻ ở phía này (vd TECH-529→934) vẫn là rác
   * nếu ở phía kia nó nằm trong đợt gắn hàng loạt (TECH-934 bị gắn 50 link một lúc).
   */
  private async junkBothSides(identifier: string, timeline: any[]): Promise<string[]> {
    const own = new Set(oldAlgorithmJunk(timeline));
    const self = identifier.toUpperCase();
    const oldBotTargets = new Set(
      timeline
        .filter(
          (e) =>
            e?.action === "link_add" &&
            isSystemActor(String(e.actorName ?? "")) &&
            String(e.createdAt ?? "") < OLD_ALGORITHM_UNTIL,
        )
        .map((e) => String(e.payload?.to?.value ?? "").toUpperCase())
        .filter((id) => id && !own.has(id)),
    );
    for (const other of oldBotTargets) {
      let theirs = this.junkCache.get(other);
      if (!theirs) {
        const issue = await findIssueByIdentifier(
          this.options.itsaplan,
          other,
          this.options.projectKey,
        );
        theirs = issue
          ? oldAlgorithmJunk(await this.options.itsaplan.getIssueTimeline(issue.id).catch(() => []))
          : [];
        this.junkCache.set(other, theirs);
      }
      if (theirs.includes(self)) own.add(other);
    }
    return [...own];
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async isDoneOrCanceled(issue: ItsaplanIssue): Promise<boolean> {
    if (!this.projectColumns) {
      this.projectColumns = await this.options.itsaplan.listProjectColumns(this.options.projectKey);
    }
    const col = this.projectColumns.find((c) => c.id === issue.columnId);
    if (!col) return false;
    const st = classifyColumn(col);
    return st === "done" || st === "canceled";
  }

  async run(issueId: number): Promise<CuratorResult> {
    const { itsaplan, projectKey } = this.options;
    try {
      const issue = await itsaplan.getIssue(issueId);
      const identifier = issue.identifier;
      if (!identifierInProject(identifier, projectKey))
        return { status: "other_project", identifier };

      const field = relatedField(issue);
      const fieldBefore = String(field?.value ?? "").trim();
      if (field) this.relatedFieldId = field.fieldId;

      const timeline = await itsaplan.getIssueTimeline(issueId);
      const human = humanKnowledgeOf(timeline, identifier);
      const isPinned = Boolean(human.cause?.trim());
      const mode: "pinned" | "suggested" = isPinned ? "pinned" : "suggested";
      if (this.options.onlyMode && this.options.onlyMode !== mode)
        return { status: "unchanged", identifier, mode, fieldBefore };

      // Ai gắn link: hành động link_add cuối cùng lên mã đó.
      const lastAdder = new Map<string, string>();
      for (const e of [...timeline].sort((a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
      )) {
        if (e?.action === "link_add")
          lastAdder.set(
            String(e.payload?.to?.value ?? "").toUpperCase(),
            String(e.actorName ?? ""),
          );
      }

      const corpus = await this.getCorpus();
      const junk = await this.junkBothSides(identifier, timeline);

      const targetData = {
        identifier,
        humanCause: human.cause,
        positives: human.positives,
        negatives: human.negatives,
        fieldKeys:
          String(field?.value ?? "")
            .toUpperCase()
            .match(/\b[A-Z][A-Z0-9_]*-[A-Z0-9-]*\d\b/g) ?? [],
        links: (issue.links ?? []).map((l) => {
          const id = l.issue.identifier.toUpperCase();
          return {
            identifier: id,
            linkId: l.id,
            addedByHuman: !isSystemActor(lastAdder.get(id) ?? ""),
          };
        }),
        title: issue.title,
        description: issue.description,
        junk,
      };

      let plan: RelatedPlan;
      if (isPinned) {
        plan = planRelatedTickets(targetData, corpus);
      } else {
        const cleanupOnly = await this.isDoneOrCanceled(issue);
        const queryText = `${issue.title ?? ""}\n${symptomsOfDescription(issue.description)}`;
        const match = this.options.similarSource
          ? await this.options.similarSource.find(queryText, { excludeIds: [identifier] })
          : null;
        plan = planSuggestedTickets(targetData, corpus, match, { cleanupOnly });
      }

      // Ticket cũ cùng cụm cần thêm mã ticket này (chỉ khi có nguyên nhân ghim).
      const needIssues = new Set<string>();
      if (isPinned) {
        for (const d of plan.desired) needIssues.add(d);
      } else {
        for (const d of plan.addLinks) needIssues.add(d);
      }
      const members: ItsaplanIssue[] = [];
      for (const d of needIssues) {
        const m = await findIssueByIdentifier(itsaplan, d, projectKey);
        if (m) members.push(m);
      }
      const keysIn = (m: ItsaplanIssue): string[] =>
        String(relatedField(m)?.value ?? "")
          .toUpperCase()
          .match(KEY) ?? [];
      const propagate = isPinned
        ? members.filter((m) => !keysIn(m).includes(identifier.toUpperCase()))
        : [];

      const nothing =
        plan.fieldValue === null &&
        !plan.addLinks.length &&
        !plan.removeLinks.length &&
        !propagate.length;
      if (nothing)
        return { status: "unchanged", mode, identifier, fieldBefore, plan, propagate: [] };
      const propagateIds = propagate.map((m) => m.identifier);
      getLogger().info(
        `[RelatedCurator] ${identifier}${this.options.dryRun ? " (chạy thử)" : ""} [${mode}]: cụm ${plan.clusterId ?? "none"} ${plan.desired.length} ticket | ` +
          `trường ${plan.fieldValue !== null ? "đổi" : "giữ"} | +link ${plan.addLinks.join(",") || "-"} | gỡ link bot ${plan.removeLinks.map((l) => l.identifier).join(",") || "-"} | ` +
          `thêm vào ticket cũ ${propagateIds.join(",") || "-"}`,
      );
      if (this.options.dryRun)
        return { status: "dry_run", mode, identifier, fieldBefore, plan, propagate: propagateIds };

      const fieldId =
        field?.fieldId ??
        this.relatedFieldId ??
        (await resolveRelatedTicketsFieldId(itsaplan as ItsaplanClient, projectKey));
      if (plan.fieldValue !== null && fieldId)
        await itsaplan.setCustomFieldValue(issue.id, fieldId, plan.fieldValue);
      for (const d of plan.addLinks) {
        const m = members.find((x) => x.identifier.toUpperCase() === d);
        if (m && m.id !== issue.id) await itsaplan.addLink(issue.id, m.id, "relates");
      }
      for (const l of plan.removeLinks) await itsaplan.deleteLink(issue.id, l.linkId);
      for (const m of propagate) {
        const f = relatedField(m);
        const id = f?.fieldId ?? fieldId;
        if (!id) continue;
        const raw = String(f?.value ?? "").trim();
        const keys = new Set([
          ...(raw.toUpperCase().match(KEY) ?? []),
          m.identifier.toUpperCase(),
          identifier.toUpperCase(),
        ]);
        // Trường chỉ gồm mã → viết lại gọn, có thứ tự; có chữ khác (người ghi chú) → chỉ nối thêm.
        const onlyKeys = !raw || /^[\sA-Z0-9_,;-]*$/i.test(raw);
        const value = onlyKeys ? [...keys].sort(byIdentifier).join(", ") : `${raw}, ${identifier}`;
        await itsaplan.setCustomFieldValue(m.id, id, value);
      }
      return { status: "applied", mode, identifier, fieldBefore, plan, propagate: propagateIds };
    } catch (err: any) {
      getLogger().warn(`[RelatedCurator] #${issueId} lỗi: ${err.message}`);
      return { status: "error", error: err.message };
    }
  }
}
