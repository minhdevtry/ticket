export interface CreateIssuePayload {
  title: string;
  description?: string;
  columnId: number;
  priority?: "urgent" | "high" | "medium" | "low";
  labelIds?: number[];
  typeId?: number | null;
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
  /** Phân loại nhóm cột (backlog/started/completed/canceled). Itsaplan không nhất
   * thiết trả — khi có thì dùng để lọc vé đã huỷ/archive khỏi gợi ý, không
   * cần tra lại listProjectColumns. Đồng bộ với ProjectColumn.stateType. */
  stateType?: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  /** Mốc archived (nếu có) — vé đã archive vẫn tồn tại nhưng KHÔNG phải tri thức. */
  archivedAt?: string | null;
  labelIds?: number[];
  /** Project member the issue is assigned to; matches `assignees[].userId` on the project. */
  assigneeUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Mốc thời gian ticket vào CỘT hiện tại (Itsaplan trả sẵn). Khác `updatedAt`:
   * `updatedAt` bị đạp lại mỗi lần ai đó sửa vé (gỡ link, sửa mô tả, bot ghi
   * chú), còn `statusSince` chỉ đổi khi đổi cột. Dùng cho time-decay của KG —
   * xem worker/kg-sync.ts.
   */
  statusSince?: string | null;
  fields?: ItsaplanIssueField[];
  links?: ItsaplanIssueLink[];
}

export interface ProjectAssignee {
  userId: string;
  name?: string;
  username?: string;
}

export interface ProjectColumn {
  id: number;
  name: string;
  stateType: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  category?: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  position: number;
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

export interface ItsaplanCustomField {
  id: number;
  issueTypeId?: number | null;
  name: string;
  fieldType: string;
  showInBody?: boolean;
  position?: number;
}

export interface ItsaplanProject {
  id: number;
  key: string;
  name: string;
  teamId?: number;
  teamSlug?: string | null;
  teamRef?: string | null;
  ref?: string | null;
  columns?: ProjectColumn[];
  assignees?: ProjectAssignee[];
  labels?: ItsaplanLabel[];
  issueTypes?: ItsaplanIssueType[];
  customFields?: ItsaplanCustomField[];
}

export class ItsaplanClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-key": this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      ...((options.headers as Record<string, string>) || {}),
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Itsaplan API error: ${response.status} ${response.statusText} (${path}) - ${errorText}`,
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request<any>("/projects");
      return true;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<ItsaplanProject[]> {
    return this.request<ItsaplanProject[]>("/projects");
  }

  async createProject(payload: { key: string; name: string; description?: string }): Promise<ItsaplanProject> {
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

  async updateIssue(
    issueId: number,
    patch: {
      title?: string;
      description?: string;
      columnId?: number;
      priority?: "urgent" | "high" | "medium" | "low";
      labelIds?: number[];
    },
  ): Promise<ItsaplanIssue> {
    return this.request<ItsaplanIssue>(`/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteIssue(issueId: number): Promise<void> {
    await this.request<void>(`/issues/${issueId}`, {
      method: "DELETE",
    });
  }

  /**
   * Liệt kê issue của một dự án (một trang, tối đa `limit`). Dùng cho script
   * backfill/đối soát — trước đây script phải gọi thẳng `request` private.
   */
  async listProjectIssues(projectKey: string, options: { limit?: number; page?: number } = {}): Promise<ItsaplanIssue[]> {
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

  /** Gỡ một link (id lấy từ `issue.links[].id`). Itsaplan: DELETE /issues/:issueId/links/:linkId. */
  async deleteLink(issueId: number, linkId: number): Promise<void> {
    await this.request<void>(`/issues/${issueId}/links/${linkId}`, { method: "DELETE" });
  }

  async listCustomFields(projectKey: string, issueTypeId?: number): Promise<ItsaplanCustomField[]> {
    const q = issueTypeId != null ? `?issueTypeId=${encodeURIComponent(issueTypeId)}` : "";
    return this.request<ItsaplanCustomField[]>(
      `/projects/${encodeURIComponent(projectKey)}/custom-fields${q}`,
    );
  }

  async setCustomFieldValue(
    issueId: number,
    fieldId: number,
    value: string | number | boolean | null,
    valueEnd?: string | null,
  ): Promise<void> {
    await this.request<{ ok: boolean }>(`/issues/${issueId}/fields/${fieldId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, valueEnd }),
    });
  }

  async addComment(issueId: number, content: string): Promise<{ id: number; body: string }> {
    return this.request<{ id: number; body: string }>(`/issues/${issueId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: content }),
    });
  }

  async listComments(issueId: number): Promise<Array<{ id: number; body: string; author?: { name?: string; id?: string }; createdAt?: string }>> {
    const timeline = await this.getIssueTimeline(issueId);
    return (timeline as Array<Record<string, unknown>>)
      .filter((item) => item.kind === "comment")
      .map((item) => ({
        id: typeof item.id === "number" ? item.id : Number(item.id),
        body: typeof item.body === "string" ? item.body : "",
        author: { name: typeof item.actorName === "string" ? item.actorName : undefined, id: typeof item.actorUserId === "string" ? item.actorUserId : undefined },
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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Upload attachment failed: ${response.status} - ${err}`);
    }

    return (await response.json()) as { id: string; url: string; filename: string };
  }

  async listWebhooks(projectKey: string): Promise<WebhookSubscription[]> {
    return this.request<WebhookSubscription[]>(`/projects/${encodeURIComponent(projectKey)}/webhooks`);
  }

  async createWebhook(
    projectKey: string,
    payload: { url: string; events: string[]; isActive?: boolean },
  ): Promise<WebhookSubscription> {
    return this.request<WebhookSubscription>(`/projects/${encodeURIComponent(projectKey)}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async updateWebhook(webhookId: number, patch: { events?: string[]; isActive?: boolean; url?: string }): Promise<WebhookSubscription> {
    return this.request<WebhookSubscription>(`/webhooks/${webhookId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteWebhook(webhookId: number): Promise<void> {
    await this.request<void>(`/webhooks/${webhookId}`, {
      method: "DELETE",
    });
  }
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

