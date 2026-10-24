/**
 * Tracker client bị khoá vào MỘT dự án: bot hậu cần chỉ được đọc/ghi issue của
 * dự án mình khai trong `tracker.project`. Issue dự án khác (hoặc đã bị chuyển đi
 * dự án khác) bị từ chối, không phải đoán.
 *
 * Mỗi lệnh ghi lên một issue đều kiểm issue thuộc dự án trước (kết quả được nhớ
 * trong một tập có chặn kích thước, nên không tốn thêm request cho issue đã kiểm).
 */
import { foldForComparison, markBotComment } from "../core/formatting";
import {
  type ItsaplanClient,
  type ItsaplanIssue,
  type ProjectColumn,
  findIssueByIdentifier,
  identifierInProject,
  normalizeProjectKey,
} from "../itsaplan";
import type { Clock } from "../intake/ports";

/** Ném khi thao tác với issue không thuộc dự án của bot. */
export class OutOfProjectError extends Error {
  constructor(
    readonly ref: number | string,
    readonly projectRef: string,
  ) {
    super(`Issue ${ref} không thuộc dự án ${projectRef}`);
    this.name = "OutOfProjectError";
  }
}

export interface TrackerComment {
  id: number;
  body: string;
  author?: { name?: string; id?: string };
  createdAt?: string;
}

export interface CommentOptions {
  /** Trả lời vào luồng của comment này (cùng issue). */
  replyToId?: number | null;
  /** Gắn dấu "comment của bot" để worker khác không dội ngược về kênh chat. Mặc định true. */
  mark?: boolean;
  /**
   * Khoá chống trùng: nếu issue đã có comment mang khoá này thì KHÔNG ghi lại
   * (`created: false`). Dùng khi hành động có thể chạy lại (run giao lại, webhook gửi lại).
   */
  idempotencyKey?: string;
}

export interface CommentResult {
  id: number | null;
  /** `false` khi bỏ qua vì khoá chống trùng đã có mặt. */
  created: boolean;
}

export type TrackerPriority = "urgent" | "high" | "medium" | "low";

/** Mặt tiền tracker mà handler/rule dùng. */
export interface ScopedTracker {
  /** Mã dự án trong team, vd `TECH2` (khớp tiền tố mã issue `TECH2-42`). */
  readonly projectKey: string;
  /** Slug team, vd `tech`. */
  readonly team: string;
  /** Ref đủ `<team>.<KEY>`, vd `tech.TECH2`: giá trị mọi lời gọi itsaplan dùng để chỉ dự án. */
  readonly ref: string;
  /** `null` nếu không tìm thấy HOẶC không thuộc dự án. */
  getIssue(ref: number | string): Promise<ItsaplanIssue | null>;
  listIssues(options?: { limit?: number; page?: number }): Promise<ItsaplanIssue[]>;
  search(query: string): Promise<ItsaplanIssue[]>;
  comments(issueId: number): Promise<TrackerComment[]>;
  comment(issueId: number, body: string, options?: CommentOptions): Promise<CommentResult>;
  columns(): Promise<ProjectColumn[]>;
  /** Chuyển issue sang cột theo tên (không phân biệt hoa thường/dấu) hoặc id. */
  moveTo(issueId: number, column: string | number): Promise<ItsaplanIssue>;
  assign(issueId: number, userId: string | null): Promise<ItsaplanIssue>;
  setPriority(issueId: number, priority: TrackerPriority): Promise<ItsaplanIssue>;
  /** Client thô, KHÔNG bị khoá dự án. Lối thoát cho việc chưa có trong mặt tiền; tự chịu trách nhiệm. */
  readonly unscopedClient: ItsaplanClient;
}

const COLUMN_TTL_MS = 5 * 60_000;
const VERIFIED_MAX = 2000;

/** Dấu chống trùng ghi vào comment. */
export function idempotencyMarker(key: string): string {
  return `<!-- bot-kit:${key.replace(/--+/g, "-").replace(/>/g, "")} -->`;
}

export function createScopedTracker(
  client: ItsaplanClient,
  tracker: { team: string; project: string },
  options: { clock?: Clock } = {},
): ScopedTracker {
  const projectKey = normalizeProjectKey(tracker.project);
  const team = (tracker.team ?? "").trim();
  if (!projectKey) throw new Error("tracker.project không được rỗng");
  if (!team) throw new Error("tracker.team không được rỗng (ref đủ là <team>.<KEY>)");
  const ref = `${team}.${projectKey}`;
  const now = () => (options.clock ?? { now: Date.now }).now();

  const verified = new Set<number>();
  const remember = (id: number) => {
    verified.add(id);
    if (verified.size > VERIFIED_MAX) {
      const oldest = verified.values().next().value;
      if (oldest !== undefined) verified.delete(oldest);
    }
  };

  let columnCache: { at: number; columns: ProjectColumn[] } | null = null;
  async function columns(force = false): Promise<ProjectColumn[]> {
    if (!force && columnCache && now() - columnCache.at < COLUMN_TTL_MS) return columnCache.columns;
    const fresh = await client.listProjectColumns(ref);
    columnCache = { at: now(), columns: fresh };
    return fresh;
  }

  async function getIssue(issueRef: number | string): Promise<ItsaplanIssue | null> {
    if (typeof issueRef === "string") {
      // `findIssueByIdentifier` gọi bằng khoá trần; ép nó đi bằng ref đủ của team.
      const byRef = {
        getIssueByNumber: (_key: string, seq: number) => client.getIssueByNumber(ref, seq),
      };
      const issue = await findIssueByIdentifier(byRef, issueRef, projectKey as string);
      if (issue) remember(issue.id);
      return issue;
    }
    const issue = await client.getIssue(issueRef).catch(() => null);
    if (!issue || !identifierInProject(issue.identifier, projectKey)) return null;
    remember(issue.id);
    return issue;
  }

  async function assertOwned(issueId: number): Promise<void> {
    if (verified.has(issueId)) return;
    if (!(await getIssue(issueId))) throw new OutOfProjectError(issueId, ref);
  }

  async function resolveColumnId(column: string | number): Promise<number> {
    if (typeof column === "number") return column;
    const wanted = foldForComparison(column);
    const find = (list: ProjectColumn[]) => list.find((c) => foldForComparison(c.name) === wanted);
    const hit = find(await columns()) ?? find(await columns(true));
    if (!hit) throw new Error(`Dự án ${projectKey} không có cột "${column}"`);
    return hit.id;
  }

  return {
    projectKey,
    team,
    ref,
    unscopedClient: client,
    getIssue,

    async listIssues(opts = {}) {
      return client.listProjectIssues(ref, opts);
    },

    async search(query) {
      return client.searchIssues(query, ref);
    },

    async comments(issueId) {
      await assertOwned(issueId);
      return client.listComments(issueId);
    },

    async comment(issueId, body, opts = {}) {
      await assertOwned(issueId);
      let text = opts.mark === false ? body : markBotComment(body);
      if (opts.idempotencyKey) {
        const marker = idempotencyMarker(opts.idempotencyKey);
        const existing = await client.listComments(issueId);
        if (existing.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
          return { id: null, created: false };
        }
        text = `${text}\n${marker}`;
      }
      const created = await client.request<{ id: number }>(`/issues/${issueId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: text,
          ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
        }),
      });
      return { id: created?.id ?? null, created: true };
    },

    columns: () => columns(),

    async moveTo(issueId, column) {
      await assertOwned(issueId);
      return client.updateIssue(issueId, { columnId: await resolveColumnId(column) });
    },

    async assign(issueId, userId) {
      await assertOwned(issueId);
      return client.updateIssue(issueId, { assigneeUserId: userId });
    },

    async setPriority(issueId, priority) {
      await assertOwned(issueId);
      return client.updateIssue(issueId, { priority });
    },
  };
}
