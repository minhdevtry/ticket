/**
 * `@vuihoc/bot-core/itsaplan` — the one Itsaplan tracker client.
 *
 * MERGED (0.1.0) from intake `lib/itsaplan/client.ts` and CM
 * `cm/lib/itsaplan/client.ts`. See `src/itsaplan/index.ts` `## Comments` drift
 * table for the per-field provenance. Summary:
 *  - typed errors (`ItsaplanApiError`, `ItsaplanMalformedResponseError`,
 *    `isRetryableItsaplanError`) and retry/429 via `fetchWithRetry` → from CM.
 *  - 2xx-with-empty/non-JSON body is a typed MALFORMED error, never silent `{}`
 *    → from CM (prevents a blank issue overwriting a real one).
 *  - richer issue/field/column metadata (`stateType`, `archivedAt`,
 *    `statusSince`, assignee, label groups, custom-field options, teamRef) →
 *    union of both (intake carries the 5bf501e teamRef upgrade).
 *  - constructor is intake's shape `(baseUrl, apiKey, options)` with NO baked-in
 *    base URL / project key / `getConfig()` — config is injected (spec: "No
 *    hardcoded base URL/project key"). CM's env/config fallback is dropped.
 */
import { fetchWithRetry, HttpError, type RetryOptions } from "./http";

export interface CreateIssuePayload {
  title: string;
  description?: string;
  columnId: number;
  priority?: "urgent" | "high" | "medium" | "low";
  labelIds?: number[];
  typeId?: number | null;
  /** `userId` từ `GET /projects/{key}/assignees`. Có thể null nếu chưa ánh xạ được. (CM) */
  assigneeUserId?: string | null;
  /** ISO yyyy-mm-dd. Tuỳ chọn; Itsaplan dùng để tính `overdue`. (CM) */
  dueDate?: string | null;
}

/**
 * Lỗi API có mã HTTP để lớp adapter biết lỗi nào tạm thời (429/5xx) và lỗi nào
 * vĩnh viễn (404/403/400). (CM)
 */
export class ItsaplanApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = "ItsaplanApiError";
    this.status = status;
    this.path = path;
  }
}

/**
 * Phản hồi HTTP thành công nhưng không đọc được nội dung: body rỗng, JSON cắt
 * cụt, hoặc HTML thay vì JSON. Cố ý KHÔNG phải `ItsaplanApiError`:
 * `isRetryableItsaplanError` coi mọi thứ không phải `ItsaplanApiError` là tạm
 * thời, và đây đúng là lỗi tạm thời (status 200 nhưng đọc hỏng). (CM)
 */
export class ItsaplanMalformedResponseError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Phản hồi Itsaplan không đọc được (${path}): ${detail}`);
    this.name = "ItsaplanMalformedResponseError";
    this.path = path;
  }
}

/** Lỗi tạm thời: đáng thử lại (worker sẽ đồng bộ lại từ hàng đợi). (CM) */
export function isRetryableItsaplanError(err: unknown): boolean {
  if (err instanceof ItsaplanApiError) {
    return err.status === 429 || err.status >= 500;
  }
  return !(err instanceof ItsaplanApiError);
}

export interface ItsaplanIssueField {
  fieldId: number;
  /** API có trả tên + kiểu field (vd "Related Tickets", "markdown"). */
  name?: string;
  fieldType?: string;
  value: string | number | boolean | null;
  valueEnd?: string | null;
  optionIds?: number[];
}

export interface ItsaplanIssueLink {
  id: number;
  kind: string;
  direction?: "inward" | "outward";
  issue: {
    id: number;
    identifier: string;
    title?: string;
    sequenceNumber?: number;
  };
}

export interface ItsaplanIssue {
  id: number;
  projectId: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  description: string;
  priority: string | null;
  columnId: number;
  /** Phân loại nhóm cột. Dùng để lọc vé đã huỷ/archive khỏi gợi ý. (intake) */
  stateType?: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  /** Mốc archived — vé đã archive vẫn tồn tại nhưng KHÔNG phải tri thức. (intake) */
  archivedAt?: string | null;
  labelIds?: number[];
  /** Project member the issue is assigned to; matches `assignees[].userId`. */
  assigneeUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Mốc thời gian ticket vào CỘT hiện tại. Khác `updatedAt`: chỉ đổi khi đổi
   * cột. Dùng cho time-decay của KG. (intake)
   */
  statusSince?: string | null;
  fields?: ItsaplanIssueField[];
  links?: ItsaplanIssueLink[];
}

export interface ProjectAssignee {
  userId: string;
  name?: string;
  username?: string;
  email?: string;
  /** `GET /projects/{key}/members` phân biệt người thật với AI agent. (CM) */
  isAgent?: boolean;
  kind?: string;
}

export interface ProjectColumn {
  id: number;
  name: string;
  stateType: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  category?: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  position: number;
  color?: string;
  autoAssignUserId?: string | null;
  wipLimit?: number | null;
  wipMode?: "soft" | "hard";
}

export interface ItsaplanLabel {
  id: number;
  projectId: number;
  groupId?: number | null;
  name: string;
  color?: string;
}

export interface ItsaplanIssueType {
  id: number;
  projectId: number;
  name: string;
  icon?: string;
  color?: string;
  isDefault?: boolean;
  position?: number;
}

export interface ItsaplanCustomFieldOption {
  id?: number;
  value: string;
  color?: string;
  position?: number;
}

export interface ItsaplanCustomField {
  id: number;
  issueTypeId?: number | null;
  name: string;
  fieldType: string;
  showInBody?: boolean;
  position?: number;
  /** Chỉ có với `fieldType` select/multi_select. (CM) */
  options?: ItsaplanCustomFieldOption[];
}

export interface ItsaplanLabelGroup {
  id: number;
  projectId?: number;
  name: string;
  color?: string;
  position?: number;
}

export interface ItsaplanProject {
  id: number;
  key: string;
  name: string;
  description?: string;
  /** Định tuyến link theo team — bản Itsaplan mới (5bf501e). (intake) */
  teamId?: number;
  teamSlug?: string | null;
  teamRef?: string | null;
  ref?: string | null;
  columns?: ProjectColumn[];
  assignees?: ProjectAssignee[];
  labels?: ItsaplanLabel[];
  /** Danh sách chỉ đọc được qua `GET /projects/{key}`. (CM) */
  labelGroups?: ItsaplanLabelGroup[];
  issueTypes?: ItsaplanIssueType[];
  customFields?: ItsaplanCustomField[];
}

export interface WebhookSubscription {
  id: number;
  projectId: number;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

export interface ItsaplanClientOptions {
  baseUrl?: string;
  apiKey?: string;
  retryOptions?: RetryOptions;
  /**
   * Thời gian chờ tối đa cho một request (ms). Mặc định 20s; `<= 0` = KHÔNG timeout
   * (bot cũ như Tiểu Linh không có timeout — abort giữa chừng một request ghi chậm
   * rồi thử lại có thể sinh ticket/comment trùng, và upload lớn bị cắt).
   */
  timeoutMs?: number;
  /**
   * Mặc định `true`: 2xx với body rỗng hoặc không phải JSON ném
   * `ItsaplanMalformedResponseError` (không bịa dữ liệu). `false` = hành vi intake
   * cũ: body rỗng → `{}`, body không phải JSON → trả nguyên chuỗi.
   */
  strictResponses?: boolean;
}

/** Thời gian chờ tối đa mặc định cho một request Itsaplan. */
export const DEFAULT_ITSAPLAN_TIMEOUT_MS = 20_000;

export class ItsaplanClient {
  public readonly baseUrl: string;
  public readonly apiKey: string;
  private readonly retryOptions?: RetryOptions;
  private readonly timeoutMs: number;
  private readonly strictResponses: boolean;

  /**
   * `(baseUrl, apiKey, retryOptions | options)`. Spec: everything via
   * constructor/config — no baked-in base URL or project key. The 3rd argument
   * is either a bare `RetryOptions` (intake call sites) or an
   * `ItsaplanClientOptions` carrying `retryOptions` + `timeoutMs` (CM).
   */
  constructor(
    baseUrl: string,
    apiKey: string,
    retryOptionsOrOptions?: RetryOptions | ItsaplanClientOptions,
  ) {
    // Tham số thứ 3 là `ItsaplanClientOptions` khi có `retryOptions`/`strictResponses`;
    // ngược lại coi là `RetryOptions` trần (call site intake cũ).
    const isClientOptions =
      !!retryOptionsOrOptions &&
      ("retryOptions" in retryOptionsOrOptions || "strictResponses" in retryOptionsOrOptions);
    const explicitOptions = isClientOptions
      ? (retryOptionsOrOptions as ItsaplanClientOptions)
      : undefined;
    const retryOpts = isClientOptions
      ? explicitOptions?.retryOptions
      : (retryOptionsOrOptions as RetryOptions | undefined);

    this.baseUrl = (baseUrl || explicitOptions?.baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || explicitOptions?.apiKey || "";
    this.retryOptions = retryOpts;
    this.timeoutMs = explicitOptions?.timeoutMs ?? DEFAULT_ITSAPLAN_TIMEOUT_MS;
    this.strictResponses = explicitOptions?.strictResponses ?? true;
  }

  public async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-key": this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      ...((options.headers as Record<string, string>) || {}),
    };

    try {
      const response = await fetchWithRetry(
        url,
        { ...options, headers },
        { ...this.retryOptions, timeoutMs: this.timeoutMs },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new ItsaplanApiError(
          response.status,
          path,
          `Itsaplan API error: ${response.status} ${response.statusText} (${path}) - ${errorText}`,
        );
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      // 204 là "không có nội dung" hợp lệ. Mọi 2xx khác mà không đọc được JSON thì
      // KHÔNG bịa dữ liệu: trả `{}` khiến caller tưởng issue rỗng (ghi đè field trống
      // lên ticket đã có), còn ép kiểu chuỗi HTML khiến mọi job lỗi dây chuyền. (CM)
      if (!text) {
        if (!this.strictResponses) return {} as T;
        throw new ItsaplanMalformedResponseError(path, "HTTP 2xx nhưng body rỗng");
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        if (!this.strictResponses) return text as unknown as T;
        throw new ItsaplanMalformedResponseError(
          path,
          `HTTP 2xx nhưng body không phải JSON (${text.length} ký tự, bắt đầu bằng "${text.slice(0, 60).replace(/\s+/g, " ")}")`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof ItsaplanApiError) throw err;
      if (err instanceof ItsaplanMalformedResponseError) throw err;
      if (err instanceof HttpError) {
        throw new ItsaplanApiError(
          err.status,
          path,
          `Itsaplan API error: ${err.status} (${path}) - ${err.message}`,
        );
      }
      throw err;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request<unknown>("/projects");
      return true;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<ItsaplanProject[]> {
    return this.request<ItsaplanProject[]>("/projects");
  }

  async createProject(payload: {
    key: string;
    name: string;
    description?: string;
    preset?: string;
  }): Promise<ItsaplanProject> {
    return this.request<ItsaplanProject>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async getProject(projectKey: string): Promise<ItsaplanProject> {
    const res = await this.request<any>(`/projects/${encodeURIComponent(projectKey)}`);
    if (res && res.project) {
      return {
        ...res.project,
        columns: res.columns ?? res.project.columns,
        labels: res.labels ?? res.project.labels,
        assignees: res.assignees ?? res.project.assignees,
        issueTypes: res.issueTypes ?? res.project.issueTypes ?? [],
        customFields: res.customFields ?? res.project.customFields ?? [],
        labelGroups: res.labelGroups ?? res.project.labelGroups ?? [],
      };
    }
    return res as ItsaplanProject;
  }

  async createLabel(
    projectKey: string,
    payload: { name: string; color?: string },
  ): Promise<ItsaplanLabel> {
    return this.request<ItsaplanLabel>(`/projects/${encodeURIComponent(projectKey)}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async listProjectColumns(projectKey: string): Promise<ProjectColumn[]> {
    const project = await this.getProject(projectKey);
    return project.columns ?? [];
  }

  async createColumn(
    projectKey: string,
    payload: {
      name: string;
      stateType: "backlog" | "unstarted" | "started" | "completed" | "canceled";
      color?: string;
      position?: number;
      autoAssignUserId?: string | null;
      wipLimit?: number | null;
      wipMode?: "soft" | "hard";
    },
  ): Promise<ProjectColumn> {
    return this.request<ProjectColumn>(`/projects/${encodeURIComponent(projectKey)}/columns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async updateColumn(
    projectKey: string,
    columnId: number,
    patch: {
      name?: string;
      stateType?: "backlog" | "unstarted" | "started" | "completed" | "canceled";
      color?: string;
      position?: number;
      autoAssignUserId?: string | null;
      wipLimit?: number | null;
      wipMode?: "soft" | "hard";
    },
  ): Promise<ProjectColumn> {
    return this.request<ProjectColumn>(
      `/projects/${encodeURIComponent(projectKey)}/columns/${columnId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
  }

  async reorderColumns(projectKey: string, orderedIds: number[]): Promise<ProjectColumn[]> {
    return this.request<ProjectColumn[]>(
      `/projects/${encodeURIComponent(projectKey)}/columns/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      },
    );
  }

  async createIssue(projectKey: string, payload: CreateIssuePayload): Promise<ItsaplanIssue> {
    return this.request<ItsaplanIssue>(`/projects/${encodeURIComponent(projectKey)}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async getIssue(issueId: number): Promise<ItsaplanIssue> {
    return this.request<ItsaplanIssue>(`/issues/${issueId}`);
  }

  async getIssueByNumber(projectKey: string, sequenceNumber: number): Promise<ItsaplanIssue> {
    return this.request<ItsaplanIssue>(
      `/projects/${encodeURIComponent(projectKey)}/issues/${sequenceNumber}`,
    );
  }

  /**
   * `move ticket` (5bf501e): `columnId` trong patch chuyển ticket sang cột khác.
   * Caller nên dùng chung `findIssueByIdentifier` (project.ts) trước để chắc
   * ticket chưa bị chuyển dự án (#493 issue_key_alias).
   */
  async updateIssue(
    issueId: number,
    patch: {
      title?: string;
      description?: string;
      columnId?: number;
      priority?: "urgent" | "high" | "medium" | "low";
      labelIds?: number[];
      /** `null` để bỏ gán người phụ trách; string để đổi người. (CM) */
      assigneeUserId?: string | null;
      dueDate?: string | null;
    },
  ): Promise<ItsaplanIssue> {
    return this.request<ItsaplanIssue>(`/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteIssue(issueId: number): Promise<void> {
    await this.request<void>(`/issues/${issueId}`, { method: "DELETE" });
  }

  /**
   * Liệt kê issue của một dự án (một trang, tối đa `limit`; `page` để duyệt trang
   * kế). Dùng cho backfill/đối soát. (intake: `page` bổ sung sau bản gộp 0.1.0)
   */
  async listProjectIssues(
    projectKey: string,
    options: { limit?: number; page?: number } = {},
  ): Promise<ItsaplanIssue[]> {
    const q = new URLSearchParams();
    if (options.limit) q.set("limit", String(options.limit));
    if (options.page) q.set("page", String(options.page));
    const query = q.toString();
    const res = await this.request<ItsaplanIssue[] | { issues?: ItsaplanIssue[] }>(
      `/projects/${encodeURIComponent(projectKey)}/issues${query ? `?${query}` : ""}`,
    );
    return Array.isArray(res) ? res : (res?.issues ?? []);
  }

  async searchIssues(query: string, projectKey: string): Promise<ItsaplanIssue[]> {
    const q = new URLSearchParams({ q: query });
    return this.request<ItsaplanIssue[]>(
      `/projects/${encodeURIComponent(projectKey)}/issues/search?${q.toString()}`,
    );
  }

  async linkIssues(
    sourceIssueId: number,
    targetIssueId: number,
    kind: "relates" | "duplicates" | "blocks" = "relates",
  ): Promise<{ id: number; kind: string }> {
    return this.request<{ id: number; kind: string }>(`/issues/${sourceIssueId}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetIssueId, kind }),
    });
  }

  async addLink(
    sourceIssueId: number,
    targetIssueId: number,
    kind: "relates" | "duplicates" | "blocks" = "relates",
  ): Promise<{ id: number; kind: string }> {
    return this.linkIssues(sourceIssueId, targetIssueId, kind);
  }

  /** Gỡ một link (id lấy từ `issue.links[].id`). */
  async deleteLink(issueId: number, linkId: number): Promise<void> {
    await this.request<void>(`/issues/${issueId}/links/${linkId}`, { method: "DELETE" });
  }

  async listCustomFields(projectKey: string, issueTypeId?: number): Promise<ItsaplanCustomField[]> {
    const q = issueTypeId != null ? `?issueTypeId=${encodeURIComponent(issueTypeId)}` : "";
    return this.request<ItsaplanCustomField[]>(
      `/projects/${encodeURIComponent(projectKey)}/custom-fields${q}`,
    );
  }

  /**
   * MERGED: CM signature (adds `optionIds` for select fields) is a strict
   * superset of intake's `(value, valueEnd)`, so CM wins.
   */
  async setCustomFieldValue(
    issueId: number,
    fieldId: number,
    value: string | number | boolean | null,
    valueEnd?: string | null,
    optionIds?: number[] | null,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (optionIds && optionIds.length > 0) {
      body.optionIds = optionIds;
    } else {
      body.value = value;
      if (valueEnd !== undefined) body.valueEnd = valueEnd;
    }
    await this.request<{ ok: boolean }>(`/issues/${issueId}/fields/${fieldId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async addComment(issueId: number, content: string): Promise<{ id: number; body: string }> {
    return this.request<{ id: number; body: string }>(`/issues/${issueId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: content }),
    });
  }

  /**
   * MERGED: CM behaviour wins — do NOT swallow a timeline error into `[]`.
   * A false "no comments" causes a duplicate comment to be re-posted; intake's
   * `.catch(() => [])` here was the behavioural bug CM fixed.
   */
  async listComments(issueId: number): Promise<
    Array<{
      id: number;
      body: string;
      author?: { name?: string; id?: string };
      createdAt?: string;
    }>
  > {
    const timeline = await this.getIssueTimeline(issueId);
    // Typed + coerced (intake): `id` luôn là number, field thiếu/sai kiểu → undefined
    // thay vì lọt `null`/object vào caller.
    return (timeline as Array<Record<string, unknown>>)
      .filter((item) => item.kind === "comment")
      .map((item) => ({
        id: typeof item.id === "number" ? item.id : Number(item.id),
        body: typeof item.body === "string" ? item.body : "",
        author: {
          name: typeof item.actorName === "string" ? item.actorName : undefined,
          id: typeof item.actorUserId === "string" ? item.actorUserId : undefined,
        },
        createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      }));
  }

  async getIssueTimeline(issueId: number): Promise<any[]> {
    return this.request<any[]>(`/issues/${issueId}/timeline/items?from=0`);
  }

  async setFieldValue(
    issueId: number,
    fieldId: number,
    value: string | number | boolean | null,
  ): Promise<void> {
    await this.request(`/issues/${issueId}/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId, value }),
    });
  }

  async uploadAttachment(
    issueId: number,
    filename: string,
    buffer: Buffer | Uint8Array,
    contentType: string = "image/png",
  ): Promise<{ id: string; url: string; filename: string }> {
    const formData = new FormData();
    const blob = new Blob([buffer as any], { type: contentType });
    formData.append("file", blob, filename);

    const url = `${this.baseUrl}/issues/${issueId}/attachments`;
    try {
      const response = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: formData,
        },
        { ...this.retryOptions, timeoutMs: this.timeoutMs },
      );

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        throw new ItsaplanApiError(
          response.status,
          `/issues/${issueId}/attachments`,
          `Upload attachment failed: ${response.status} - ${err}`,
        );
      }

      return (await response.json()) as { id: string; url: string; filename: string };
    } catch (err: unknown) {
      if (err instanceof ItsaplanApiError) throw err;
      if (err instanceof HttpError) {
        throw new ItsaplanApiError(
          err.status,
          `/issues/${issueId}/attachments`,
          `Upload attachment failed: ${err.status} - ${err.message}`,
        );
      }
      throw err;
    }
  }

  async listWebhooks(projectKey: string): Promise<WebhookSubscription[]> {
    return this.request<WebhookSubscription[]>(
      `/projects/${encodeURIComponent(projectKey)}/webhooks`,
    );
  }

  async createWebhook(
    projectKey: string,
    payload: { url: string; events: string[]; isActive?: boolean; secret?: string },
  ): Promise<WebhookSubscription> {
    return this.request<WebhookSubscription>(
      `/projects/${encodeURIComponent(projectKey)}/webhooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  async updateWebhook(
    webhookId: number,
    patch: { events?: string[]; isActive?: boolean; url?: string },
  ): Promise<WebhookSubscription> {
    return this.request<WebhookSubscription>(`/webhooks/${webhookId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteWebhook(webhookId: number): Promise<void> {
    await this.request<void>(`/webhooks/${webhookId}`, { method: "DELETE" });
  }
}
