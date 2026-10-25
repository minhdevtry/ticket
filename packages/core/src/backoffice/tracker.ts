/**
 * Tracker client bị khoá vào MỘT dự án: bot hậu cần chỉ được đọc/ghi issue của
 * dự án mình khai trong `tracker.project`. Issue dự án khác (hoặc đã bị chuyển đi
 * dự án khác) bị từ chối, không phải đoán.
 *
 * Ranh giới dự án dựa trên `projectId` lấy từ itsaplan (`ready()`), KHÔNG dựa vào tiền
 * tố mã issue: mã dự án chỉ duy nhất trong team và đổi khi issue được chuyển dự án.
 * Mỗi lệnh ghi lên một issue đều kiểm issue thuộc dự án trước (kết quả nhớ ngắn hạn).
 *
 * Lỗi: chỉ 404 nghĩa là "không có/không thuộc dự án" (trả `null`). Lỗi tạm thời (5xx, 429,
 * mạng) của lệnh ĐỌC được thử lại vài lần rồi nổi lên để dispatcher đổi thành `retry`.
 * Lệnh GHI không bao giờ được thử lại ở đây (có thể ghi trùng).
 */
import { foldForComparison, markBotComment } from "../core/formatting";
import {
  ItsaplanApiError,
  type ItsaplanClient,
  type ItsaplanIssue,
  type ProjectColumn,
  isTransientError,
  normalizeProjectKey,
  parseIdentifier,
} from "../itsaplan";
import type { Clock } from "../intake/ports";

/**
 * Ref đủ của dự án (`<team>.<KEY>`, vd `tech.TECH2`). Kiểu "brand" để không lẫn với chuỗi bất kỳ
 * (mã dự án trần, slug team) ở những chỗ cần ref đủ.
 */
export type ProjectRef = string & { readonly __brand: "ProjectRef" };

/** Ném khi ghi bằng tracker của một run đã bị huỷ (mất lease, hết hạn, đang tắt). */
export class RunAbortedError extends Error {
  constructor() {
    super("Run đã bị huỷ: từ chối ghi vào itsaplan");
    this.name = "RunAbortedError";
  }
}

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
  readonly ref: ProjectRef;
  /**
   * Xác định dự án trên itsaplan (một lần, rồi nhớ) và trả `projectId` dùng làm ranh giới.
   * Ném nếu key/dự án sai hoặc itsaplan không trả lời; lần gọi sau thử lại.
   */
  ready(): Promise<{ projectId: number }>;
  /**
   * Bản tracker gắn với một run: MỌI lệnh ghi bị từ chối (`RunAbortedError`) khi `signal` đã
   * huỷ, kể cả giữa chừng sau khi đã kiểm quyền. Handler quá hạn/mất lease không ghi được nữa.
   */
  forSignal(signal: AbortSignal): ScopedTracker;
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
const VERIFIED_TTL_MS = 60_000;
const VERIFIED_MAX = 2000;

/** Dấu chống trùng ghi vào comment. */
export function idempotencyMarker(key: string): string {
  return `<!-- bot-kit:${key.replace(/--+/g, "-").replace(/>/g, "")} -->`;
}

export interface ScopedTrackerOptions {
  clock?: Clock;
  /** Số lần thử LẠI cho lệnh đọc gặp lỗi tạm thời. Mặc định 2. Lệnh ghi không bao giờ thử lại. */
  readRetries?: number;
  /** Chờ cơ sở giữa các lần thử lại (ms), nhân đôi mỗi lần. Mặc định 200. */
  readRetryBaseMs?: number;
}

const isNotFound = (err: unknown): boolean => err instanceof ItsaplanApiError && err.status === 404;

export function createScopedTracker(
  client: ItsaplanClient,
  tracker: { team: string; project: string },
  options: ScopedTrackerOptions = {},
): ScopedTracker {
  const normalizedKey = normalizeProjectKey(tracker.project);
  const team = (tracker.team ?? "").trim();
  if (!normalizedKey) throw new Error("tracker.project không được rỗng");
  const projectKey: string = normalizedKey;
  if (!team) throw new Error("tracker.team không được rỗng (ref đủ là <team>.<KEY>)");
  const ref = `${team}.${projectKey}` as ProjectRef;
  const now = () => (options.clock ?? { now: Date.now }).now();
  const readRetries = options.readRetries ?? 2;
  const readRetryBaseMs = options.readRetryBaseMs ?? 200;

  /** Đọc có thử lại với lỗi tạm thời. KHÔNG dùng cho lệnh ghi. */
  async function read<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (attempt >= readRetries || !isTransientError(err)) throw err;
        const wait = readRetryBaseMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, wait / 2 + Math.random() * (wait / 2)));
      }
    }
  }

  // Trạng thái dùng chung giữa tracker gốc và các bản `forSignal`.
  const verified = new Map<number, number>();
  const remember = (id: number) => {
    verified.delete(id);
    verified.set(id, now());
    if (verified.size > VERIFIED_MAX) {
      const oldest = verified.keys().next().value;
      if (oldest !== undefined) verified.delete(oldest);
    }
  };
  const isVerified = (id: number) => {
    const at = verified.get(id);
    if (at === undefined) return false;
    if (now() - at > VERIFIED_TTL_MS) {
      verified.delete(id);
      return false;
    }
    return true;
  };

  let columnCache: { at: number; columns: ProjectColumn[] } | null = null;
  let projectPromise: Promise<number> | null = null;

  function ready(): Promise<{ projectId: number }> {
    projectPromise ??= read(() => client.getProject(ref))
      .then((project) => {
        if (typeof project.id !== "number") {
          throw new Error(`itsaplan không trả id cho dự án ${ref}`);
        }
        if (project.key && normalizeProjectKey(project.key) !== projectKey) {
          throw new Error(`Dự án ${ref} trả về mã ${project.key}: sai dự án`);
        }
        if (project.columns) columnCache = { at: now(), columns: project.columns };
        return project.id;
      })
      .catch((err: unknown) => {
        projectPromise = null; // đừng nhớ thất bại
        throw err;
      });
    return projectPromise.then((projectId) => ({ projectId }));
  }

  async function columns(force = false): Promise<ProjectColumn[]> {
    if (!force && columnCache && now() - columnCache.at < COLUMN_TTL_MS) return columnCache.columns;
    const fresh = await read(() => client.listProjectColumns(ref));
    columnCache = { at: now(), columns: fresh };
    return fresh;
  }

  async function getIssue(issueRef: number | string): Promise<ItsaplanIssue | null> {
    const { projectId } = await ready();
    let issue: ItsaplanIssue | null;
    if (typeof issueRef === "string") {
      const parsed = parseIdentifier(issueRef);
      if (!parsed || parsed.projectKey !== projectKey) return null;
      issue = await read(() => client.getIssueByNumber(ref, parsed.sequence)).catch(
        (err: unknown) => {
          if (isNotFound(err)) return null;
          throw err;
        },
      );
    } else {
      issue = await read(() => client.getIssue(issueRef)).catch((err: unknown) => {
        if (isNotFound(err)) return null;
        throw err;
      });
    }
    // Ranh giới là projectId (mã issue đổi khi chuyển dự án và chỉ duy nhất trong team).
    if (!issue || issue.projectId !== projectId) return null;
    remember(issue.id);
    return issue;
  }

  async function assertOwned(issueId: number): Promise<void> {
    if (isVerified(issueId)) return;
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

  function make(signal?: AbortSignal): ScopedTracker {
    const guard = () => {
      if (signal?.aborted) throw new RunAbortedError();
    };
    return {
      projectKey,
      team,
      ref,
      unscopedClient: client,
      ready,
      getIssue,
      forSignal: (s) => make(s),

      async listIssues(opts = {}) {
        return read(() => client.listProjectIssues(ref, opts));
      },

      async search(query) {
        return read(() => client.searchIssues(query, ref));
      },

      async comments(issueId) {
        await assertOwned(issueId);
        return read(() => client.listComments(issueId));
      },

      async comment(issueId, body, opts = {}) {
        guard();
        await assertOwned(issueId);
        let text = opts.mark === false ? body : markBotComment(body);
        if (opts.idempotencyKey) {
          const marker = idempotencyMarker(opts.idempotencyKey);
          const existing = await read(() => client.listComments(issueId));
          if (existing.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
            return { id: null, created: false };
          }
          text = `${text}\n${marker}`;
        }
        guard();
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
        guard();
        await assertOwned(issueId);
        const columnId = await resolveColumnId(column);
        guard();
        return client.updateIssue(issueId, { columnId });
      },

      async assign(issueId, userId) {
        guard();
        await assertOwned(issueId);
        guard();
        return client.updateIssue(issueId, { assigneeUserId: userId });
      },

      async setPriority(issueId, priority) {
        guard();
        await assertOwned(issueId);
        guard();
        return client.updateIssue(issueId, { priority });
      },
    };
  }

  return make();
}
