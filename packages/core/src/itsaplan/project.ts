/**
 * Resolving the project, the column a new issue lands in, and the web URL of a
 * ticket.
 *
 * MERGED (0.1.0): INTAKE wins throughout — its versions are a strict superset
 * of CM's. intake carries the 5bf501e upgrades (teamRef-based `issueWebUrl`,
 * identifier-match in `findIssueByIdentifier`, project keys with digits) that CM
 * never received. CM's `issueWebUrl` (always `/project/<KEY>/issue/<n>`) is the
 * exact fallback branch intake already keeps when no teamRef is available, so
 * nothing CM did is lost.
 */
import type { ItsaplanClient, ItsaplanIssue, ItsaplanProject, ProjectColumn } from "./client";

export interface ResolvedProject {
  key: string;
  teamRef?: string;
  columns: ProjectColumn[];
  raw: ItsaplanProject;
}

const cachedTeamRefs = new WeakMap<object, Map<string, string | undefined>>();

/**
 * Lấy `teamRef` (slug của team, hoặc id/ref nếu chưa đặt slug) từ kết quả
 * `getProject()` theo chuẩn upstream.
 */
export function projectTeamRef(
  projectOrRef?: string | Partial<ItsaplanProject> | null,
): string | undefined {
  if (!projectOrRef) return undefined;
  if (typeof projectOrRef === "string") {
    const trimmed = projectOrRef.trim();
    if (!trimmed) return undefined;
    const dot = trimmed.indexOf(".");
    return (dot > 0 ? trimmed.slice(0, dot) : trimmed).trim() || undefined;
  }
  const direct = typeof projectOrRef.teamRef === "string" ? projectOrRef.teamRef.trim() : "";
  if (direct) return direct;
  if (typeof projectOrRef.ref === "string") {
    const dot = projectOrRef.ref.indexOf(".");
    if (dot > 0) {
      const fromRef = projectOrRef.ref.slice(0, dot).trim();
      if (fromRef) return fromRef;
    }
  }
  const slug = typeof projectOrRef.teamSlug === "string" ? projectOrRef.teamSlug.trim() : "";
  if (slug) return slug;
  if (typeof projectOrRef.teamId === "number" && Number.isFinite(projectOrRef.teamId)) {
    return String(projectOrRef.teamId);
  }
  return undefined;
}

/**
 * Lấy `teamRef` của dự án qua `client.getProject(projectKey)` (có bộ nhớ đệm
 * theo client). API cũ không có `teamRef` hoặc gọi lỗi → `undefined` để nơi gọi
 * giữ link dạng cũ.
 */
export async function resolveProjectTeamRef(
  client: { getProject?: (projectKey: string) => Promise<ItsaplanProject> } | null | undefined,
  projectKey: string,
): Promise<string | undefined> {
  if (!client || typeof client.getProject !== "function") return undefined;
  const key = projectKey.trim().toUpperCase();
  if (!key) return undefined;
  let perClient = cachedTeamRefs.get(client);
  if (perClient && perClient.has(key)) {
    return perClient.get(key);
  }
  const project = await client.getProject(projectKey).catch(() => null);
  const teamRef = projectTeamRef(project);
  if (!perClient) {
    perClient = new Map();
    cachedTeamRefs.set(client, perClient);
  }
  perClient.set(key, teamRef);
  return teamRef;
}

/**
 * Looks the project up by key, falling back to the first project on the
 * instance so a misconfigured project key degrades to a clear error rather than
 * a stack trace mid-conversation.
 */
export async function resolveProject(
  client: ItsaplanClient,
  projectKey: string,
): Promise<ResolvedProject> {
  let project: ItsaplanProject | null = await client.getProject(projectKey).catch(() => null);

  if (!project) {
    const projects = await client.listProjects().catch(() => []);
    project = projects.find((p) => p.key === projectKey) ?? projects[0] ?? null;
  }

  if (!project) {
    throw new Error(`Không tìm thấy dự án "${projectKey}" trên Itsaplan.`);
  }

  const key = project.key ?? projectKey;
  let columns = project.columns ?? [];
  if (columns.length === 0) {
    columns = await client.listProjectColumns(key).catch(() => []);
  }

  const teamRef = projectTeamRef(project);
  let perClient = cachedTeamRefs.get(client);
  if (!perClient) {
    perClient = new Map();
    cachedTeamRefs.set(client, perClient);
  }
  perClient.set(key.trim().toUpperCase(), teamRef);
  return { key, teamRef, columns, raw: project };
}

/** Picks where new issues start: backlog, else the first unstarted column, else the first column. */
export async function resolveBacklogColumn(
  _client: ItsaplanClient,
  project: ResolvedProject,
): Promise<ProjectColumn> {
  const byState = (state: string) =>
    project.columns.find(
      (column) =>
        column.stateType === state || (column as { category?: string }).category === state,
    );

  const target = byState("backlog") ?? byState("unstarted") ?? project.columns[0];
  if (!target) {
    throw new Error(`Dự án "${project.key}" chưa cấu hình cột workflow nào.`);
  }
  return target;
}

/** Splits `TECH-42` into its project key and sequence number (project keys may contain digits). */
export function parseIdentifier(
  identifier: string,
): { projectKey: string; sequence: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
  if (!match) return null;
  return { projectKey: match[1].toUpperCase(), sequence: Number(match[2]) };
}

/**
 * Dựng link web của một ticket.
 *
 * - Bản Itsaplan mới định tuyến theo team: `/<teamRef>/issue/<KEY>-<n>`.
 * - Không lấy được `teamRef` → giữ đường dẫn cũ `/project/<KEY>/issue/<n>`.
 */
export function issueWebUrl(
  webUrl: string | undefined,
  projectKey: string,
  identifier: string,
  sequenceNumber?: number,
  teamRefOrProject?: string | Partial<ItsaplanProject> | null,
): string | undefined {
  if (!webUrl) return undefined;
  const parsed = parseIdentifier(identifier);
  const sequence = sequenceNumber ?? parsed?.sequence;
  if (sequence === undefined) return undefined;

  let keyFromProject = projectKey.trim();
  let teamFromProjectKey: string | undefined;
  const dot = keyFromProject.indexOf(".");
  if (dot > 0) {
    teamFromProjectKey = keyFromProject.slice(0, dot).trim() || undefined;
    keyFromProject = keyFromProject.slice(dot + 1).trim();
  }

  const base = webUrl.replace(/\/+$/, "");
  const teamRef = projectTeamRef(teamRefOrProject) ?? teamFromProjectKey;
  if (teamRef) {
    const key = (parsed?.projectKey || keyFromProject).toUpperCase();
    return `${base}/${encodeURIComponent(teamRef)}/issue/${encodeURIComponent(key)}-${sequence}`;
  }
  return `${base}/project/${keyFromProject}/issue/${sequence}`;
}

/**
 * Chỉ tra trong dự án được yêu cầu và kiểm tra `issue.identifier` trả về khớp
 * đúng mã yêu cầu. Khi ticket bị chuyển dự án (#493 `issue_key_alias`),
 * `GET /projects/:oldKey/issues/:oldSeq` trả về ticket đã mang mã dự án mới —
 * không so khớp thì đọc/ghi nhầm sang dự án kia.
 */
export async function findIssueByIdentifier(
  client: Pick<ItsaplanClient, "getIssueByNumber">,
  identifier: string,
  projectKey?: string,
): Promise<ItsaplanIssue | null> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;
  if (projectKey !== undefined && parsed.projectKey !== projectKey.trim().toUpperCase()) {
    return null;
  }
  const issue = await client.getIssueByNumber(parsed.projectKey, parsed.sequence).catch(() => null);
  if (!issue) return null;
  const expected = `${parsed.projectKey}-${parsed.sequence}`;
  if (typeof issue.identifier !== "string" || issue.identifier.trim().toUpperCase() !== expected) {
    return null;
  }
  return issue;
}

/**
 * Resolves a label by name on the project.
 * TUYỆT ĐỐI KHÔNG tự tiện sinh nhãn mới nếu không có trong danh sách của project.
 */
export async function resolveLabel(
  client: ItsaplanClient,
  projectKey: string,
  labelName?: string,
): Promise<number | null> {
  if (!labelName || !labelName.trim()) return null;
  const name = labelName.trim();
  try {
    const project = await resolveProject(client, projectKey);
    const existing = project.raw.labels?.find(
      (l) => l.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing.id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves labels for an issue. Nhãn danh mục lỗi và nhãn bổ sung chỉ lấy nếu đã
 * tồn tại trên project; không tự gán nhãn thay thế.
 */
export async function resolveLabelsForIssue(
  client: ItsaplanClient,
  projectKey: string,
  errorCategory?: string,
  additionalLabels: string[] = [],
): Promise<number[]> {
  const category = (errorCategory ?? "").trim();
  const primaryLabelName = category && category !== "Lỗi chưa xác định" ? category : undefined;

  const targetNames = new Set<string>();
  if (primaryLabelName) {
    targetNames.add(primaryLabelName);
  }
  for (const l of additionalLabels) {
    const trimmed = (l ?? "").trim();
    if (trimmed) {
      targetNames.add(trimmed);
    }
  }

  const labelIds: number[] = [];
  for (const name of targetNames) {
    const id = await resolveLabel(client, projectKey, name);
    if (id !== null) labelIds.push(id);
  }

  return labelIds;
}
