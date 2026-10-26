/**
 * Adapter: make the ticket-04 Itsaplan client satisfy `TrackerPort` (ticket 08).
 *
 * The engine speaks `TrackerPort`; this is the single place that knows the
 * Itsaplan client's shape — project/column/label resolution, web-URL building,
 * attachment upload + description splice. Keeping it here means a different
 * tracker is one more adapter, not an engine change.
 *
 * NGUỒN: intake `mcp/shared/tools/create-issue.ts` (resolveProject/
 * resolveBacklogColumn/resolveLabelsForIssue/issueWebUrl/attachMediaToIssue) and
 * `lib/itsaplan/*`.
 */
import {
  type ItsaplanClient,
  resolveProject,
  resolveBacklogColumn,
  resolveLabelsForIssue,
  issueWebUrl,
  findIssueByIdentifier,
  uploadAttachments,
  spliceAttachmentsIntoDescription,
  formatAttachmentMarkdown,
  classifyColumn,
} from "../itsaplan";
import { isIssueClosed } from "./notify/supplement-notifier";
import type { CreateIssueInput, Priority, TrackerIssue, TrackerPort } from "./ports";

export interface ItsaplanTrackerOptions {
  client: ItsaplanClient;
  projectKey: string;
  /** API base URL for building attachment links. */
  baseUrl: string;
  /** Web UI base URL for building reporter-facing ticket links. */
  webUrl?: string;
}

/** Wrap an `ItsaplanClient` as a `TrackerPort`. */
export function itsaplanTrackerPort(opts: ItsaplanTrackerOptions): TrackerPort {
  const { client, projectKey, baseUrl, webUrl } = opts;

  return {
    async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
      const project = await resolveProject(client, projectKey);
      const column = await resolveBacklogColumn(client, project);
      const labelIds = await resolveLabelsForIssue(
        client,
        project.key,
        input.category,
        input.labels ?? [],
      ).catch(() => [] as number[]);
      const rawProject = project.raw;
      const defaultType =
        rawProject.issueTypes?.find((t) => t.isDefault) ?? rawProject.issueTypes?.[0];

      const issue = await client.createIssue(project.key, {
        title: input.title,
        description: input.description,
        columnId: column.id,
        priority: input.priority,
        typeId: defaultType?.id ?? undefined,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
      });
      const url = issueWebUrl(
        webUrl,
        project.key,
        issue.identifier,
        issue.sequenceNumber,
        project.raw,
      );
      return { id: issue.id, identifier: issue.identifier, title: issue.title, url };
    },

    async getIssue(issueId: number): Promise<TrackerIssue | null> {
      const issue = await client.getIssue(issueId).catch(() => null);
      return issue
        ? {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            columnId: issue.columnId,
            stateType: issue.stateType,
            priority: issue.priority as Priority,
            assigneeUserId: issue.assigneeUserId,
            description: issue.description,
          }
        : null;
    },

    async addComment(issueId: number, body: string): Promise<void> {
      await client.addComment(issueId, body);
    },

    async attach(issueId: number, description: string, mediaPaths: string[]): Promise<number> {
      if (mediaPaths.length === 0) return 0;
      const uploaded = await uploadAttachments(client, issueId, baseUrl, mediaPaths).catch(
        () => [],
      );
      if (uploaded.length > 0) {
        const desc = spliceAttachmentsIntoDescription(description, uploaded);
        await client.updateIssue(issueId, { description: desc }).catch(() => {});
      }
      return uploaded.length;
    },

    // Tải ảnh mà KHÔNG đụng mô tả ticket — dùng cho huỷ/đóng ticket đã có
    // (mô tả ticket là nguyên văn của người báo — ADR-0010).
    async uploadMedia(issueId: number, mediaPaths: string[]) {
      if (mediaPaths.length === 0) return [];
      const uploaded = await uploadAttachments(client, issueId, baseUrl, mediaPaths).catch(
        () => [],
      );
      return uploaded.map((att) => ({
        filename: att.filename,
        markdown: formatAttachmentMarkdown(att),
      }));
    },

    async findByIdentifier(identifier: string): Promise<TrackerIssue | null> {
      const issue = await findIssueByIdentifier(client, identifier, projectKey).catch(() => null);
      return issue ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null;
    },

    async updateIssue(
      issueId: number,
      patch: { priority?: Priority; title?: string; description?: string; columnId?: number },
    ): Promise<void> {
      await client.updateIssue(issueId, patch);
    },

    async isIssueClosed(issueId: number): Promise<boolean> {
      const issue = await client.getIssue(issueId).catch(() => null);
      if (!issue) return false;
      const columns = await client.listProjectColumns(projectKey).catch(() => []);
      return isIssueClosed(issue, columns);
    },

    async getIssueState(
      issueId: number,
    ): Promise<{ stateType?: string; state?: "open" | "resolved" | "done" | "canceled" } | null> {
      const issue = await client.getIssue(issueId).catch(() => null);
      if (!issue) return null;
      const columns = await client.listProjectColumns(projectKey).catch(() => []);
      const col = columns.find((c) => c.id === issue.columnId);
      let state: "open" | "resolved" | "done" | "canceled" = "open";
      if (col) {
        state = classifyColumn(col);
      } else if (issue.stateType === "completed") {
        state = "done";
      } else if (issue.stateType === "canceled") {
        state = "canceled";
      }
      return { stateType: issue.stateType, state };
    },

    async getProjectAssignees(key = projectKey) {
      const project = await client.getProject(key).catch(() => null);
      return project?.assignees ?? [];
    },

    async getIssueTimeline(issueId: number) {
      return (await client.getIssueTimeline(issueId).catch(() => [])) ?? [];
    },

    async linkIssues(
      fromIssueId: number,
      toIssueId: number,
      linkType: "duplicates" | "relates" | "blocks" | "relates_to" | "blocked_by",
    ): Promise<void> {
      if (typeof client.linkIssues === "function") {
        const mappedKind =
          linkType === "duplicates"
            ? "duplicates"
            : linkType === "blocks" || linkType === "blocked_by"
              ? "blocks"
              : "relates";
        await client.linkIssues(fromIssueId, toIssueId, mappedKind);
      }
    },

    async listProjectColumns(key = projectKey) {
      return (await client.listProjectColumns(key).catch(() => [])) ?? [];
    },
  };
}
