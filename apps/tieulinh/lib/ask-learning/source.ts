/**
 * Nguồn ticket cho ingest, dùng chung cho script và test. Hai nguồn:
 * - itsaplan: đọc qua ItsaplanClient (chỉ listProjectIssues + listComments).
 * - jsonl: file offline dạng nghiên cứu (ticket_id, created_at, title, description,
 *   system_reported, human_comments[{actor_name, created_at, body}]).
 */
import { createHash } from "node:crypto";
import { parseIncidentMeta } from "../kg/incident-meta";

export interface SourceComment {
  /** Mã ổn định để khoá trong kho (sha256 của ticket + vị trí/mã gốc). */
  commentId: string;
  actor: string;
  createdAt: string;
  body: string;
}

export interface SourceTicket {
  issueKey: string;
  createdAt: string;
  title: string;
  description: string;
  /** Hệ thống thô (chưa chuẩn hoá). */
  systemRaw: string;
  comments: SourceComment[];
}

export function commentIdOf(issueKey: string, marker: string | number): string {
  return createHash("sha256").update(`${issueKey}#${marker}`).digest("hex").slice(0, 32);
}

/** Trích xuất hệ thống từ mô tả sự cố (JSON meta hoặc Markdown "## Thông tin sự cố", fallback "- Hệ thống:"). */
export function systemFromDescription(description: string): string {
  if (!description) return "";
  const meta = parseIncidentMeta(description);
  const sys = meta.system || "";
  if (typeof sys === "string" && sys.trim()) return sys.trim();
  const m = description.match(/-\s*Hệ thống:\s*([^\n]+)/);
  return m ? m[1].trim() : "";
}

export function ticketsFromJsonl(lines: string[]): SourceTicket[] {
  const out: SourceTicket[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    const issueKey = String(r.ticket_id);
    const description = String(r.description ?? "");
    const humanComments = Array.isArray(r.human_comments) ? (r.human_comments as Array<Record<string, unknown>>) : [];
    out.push({
      issueKey,
      createdAt: String(r.created_at ?? ""),
      title: String(r.title ?? ""),
      description,
      systemRaw: String(r.system_reported ?? systemFromDescription(description)),
      comments: humanComments.map((c, i) => ({
        commentId: commentIdOf(issueKey, i),
        actor: String(c.actor_name ?? ""),
        createdAt: String(c.created_at ?? ""),
        body: String(c.body ?? ""),
      })),
    });
  }
  return out;
}

export interface ItsaplanCommentItem {
  id: number;
  body: string;
  author?: { name?: string; id?: string };
  createdAt?: string;
}

export interface ItsaplanTimelineItem {
  id: number;
  kind: string;
  actorName?: string;
  actorUserId?: string;
  createdAt?: string;
  body?: string;
}

export interface ItsaplanIssueItem {
  id: number;
  identifier?: string;
  sequenceNumber?: number;
  title?: string;
  description?: string;
  createdAt?: string;
  archivedAt?: string | null;
  [key: string]: unknown;
}

/** Đọc ticket từ ItsaplanClient (chỉ đọc). */
export interface ItsaplanReadSource {
  listProjectIssues(projectKey: string, options?: { limit?: number; page?: number }): Promise<Array<{ id: number; description?: string; createdAt?: string; identifier?: string; sequenceNumber?: number; title?: string; archivedAt?: string | null }>>;
  getIssue?(issueId: number): Promise<{ id: number; description?: string; createdAt?: string; identifier?: string; sequenceNumber?: number; title?: string }>;
  listComments?(issueId: number): Promise<Array<{ id: number; body: string; author?: { name?: string; id?: string }; createdAt?: string }>>;
  getIssueTimeline?(issueId: number): Promise<unknown[]>;
}

export interface TicketsFromItsaplanOptions {
  limit?: number;
  concurrency?: number;
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 6): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await Bun.sleep(1200);
    }
  }
  throw new Error("retry exhausted");
}

export async function ticketsFromItsaplan(
  client: ItsaplanReadSource,
  projectKey: string,
  limitOrOptions: number | TicketsFromItsaplanOptions = 1000,
): Promise<SourceTicket[]> {
  const limit = typeof limitOrOptions === "number" ? limitOrOptions : (limitOrOptions.limit ?? 1000);
  const concurrency = Math.max(1, typeof limitOrOptions === "number" ? 4 : (limitOrOptions.concurrency ?? 4));

  // 1. Quét toàn bộ issue qua phân trang (mỗi trang tối đa 500)
  const allIssues: ItsaplanIssueItem[] = [];
  const pageSize = 500;
  let page = 1;
  const seenIds = new Set<number>();
  while (true) {
    const pageIssues = await client.listProjectIssues(projectKey, {
      limit: limit > 0 ? Math.min(limit - allIssues.length, pageSize) : pageSize,
      page,
    });
    if (!pageIssues || pageIssues.length === 0) break;
    let added = 0;
    for (const issue of pageIssues) {
      const id = typeof issue.id === "number" ? issue.id : Number(issue.id ?? 0);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allIssues.push(issue);
        added++;
      }
    }
    if (added === 0 || (limit > 0 && allIssues.length >= limit)) break;
    page++;
  }

  // 2. Tải chi tiết (description, createdAt, system) và timeline bình luận song song
  const detailCache = new Map<number, ItsaplanIssueItem>();
  const out: SourceTicket[] = new Array(allIssues.length);

  const fetchOne = async (issue: ItsaplanIssueItem): Promise<SourceTicket | null> => {
    if (issue.archivedAt) return null;

    let description = issue.description;
    let createdAt = issue.createdAt;
    let title = issue.title ?? "";

    if ((description === undefined || createdAt === undefined) && typeof client.getIssue === "function") {
      let detail = detailCache.get(issue.id);
      if (!detail) {
        detail = await retryWithBackoff(() => client.getIssue!(issue.id));
        detailCache.set(issue.id, detail);
      }
      if (description === undefined) description = detail?.description;
      if (createdAt === undefined) createdAt = detail?.createdAt;
      if (!title) title = detail?.title ?? "";
    }

    const descStr = String(description ?? "");
    const systemRaw = systemFromDescription(descStr);

    let rawComments: Array<{ id: number; actor: string; createdAt: string; body: string }> = [];
    if (typeof client.listComments === "function") {
      const list = await retryWithBackoff(() => client.listComments!(issue.id)).catch(() => []);
      rawComments = list.map((c) => ({
        id: c.id,
        actor: String(c.author?.name ?? ""),
        createdAt: String(c.createdAt ?? ""),
        body: String(c.body ?? ""),
      }));
    } else if (typeof client.getIssueTimeline === "function") {
      const tl = await retryWithBackoff(() => client.getIssueTimeline!(issue.id)).catch(() => []);
      rawComments = (tl as Array<Record<string, unknown>>)
        .filter((item) => item.kind === "comment")
        .map((item) => ({
          id: typeof item.id === "number" ? item.id : Number(item.id),
          actor: String(item.actorName ?? ""),
          createdAt: String(item.createdAt ?? ""),
          body: String(item.body ?? ""),
        }));
    }

    const issueKey = String(issue.identifier ?? `${projectKey}-${issue.sequenceNumber ?? issue.id}`);
    return {
      issueKey,
      createdAt: String(createdAt ?? ""),
      title: String(title),
      description: descStr,
      systemRaw,
      comments: rawComments.map((c) => ({
        commentId: commentIdOf(issueKey, c.id),
        actor: c.actor,
        createdAt: c.createdAt,
        body: c.body,
      })),
    };
  };

  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < allIssues.length) {
      const i = nextIdx++;
      await Bun.sleep(15);
      const res = await fetchOne(allIssues[i]);
      if (res) out[i] = res;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, allIssues.length) }, worker));
  return out.filter(Boolean);
}
