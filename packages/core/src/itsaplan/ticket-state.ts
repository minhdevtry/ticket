/**
 * Trạng thái ticket — một cách phân loại duy nhất.
 *
 * Trước đây có nhiều chỗ tự phân loại và lệch nhau: TECH đặt cột Resolved vào
 * nhóm `completed` giống Done, còn webhook `state_changed` thật chỉ mang
 * `columnId` — không có tên cột lẫn stateType. Nên phải tra danh sách cột của
 * đúng dự án rồi phân loại theo TÊN cột Resolved, không theo nhóm hay id.
 *
 * MERGED (0.1.0): intake and CM `ticket-state.ts` are byte-identical in logic
 * (CM's header literally says "Adapted for cm-support from legacy
 * intake-agents"). INTAKE kept as the reference.
 */
import type { ItsaplanClient, ProjectColumn } from "./client";

/** open: backlog/todo/đang xử lý · resolved: đã xử lý · done: hoàn tất · canceled: huỷ. */
export type TicketState = "open" | "resolved" | "done" | "canceled";

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim();
}

const RESOLVED_NAMES = new Set(["resolved", "da xu ly"]);

export function classifyColumn(column: { name: string; stateType?: string }): TicketState {
  if (RESOLVED_NAMES.has(fold(column.name))) return "resolved";
  if (column.stateType === "completed") return "done";
  if (column.stateType === "canceled") return "canceled";
  return "open";
}

/** Tra trạng thái theo (dự án, columnId), cache danh sách cột của từng dự án. */
export class ProjectColumnStates {
  private readonly cache = new Map<string, { columns: ProjectColumn[]; at: number }>();

  constructor(
    private readonly client: Pick<ItsaplanClient, "listProjectColumns">,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private async columnsOf(projectKey: string, force = false): Promise<ProjectColumn[]> {
    const hit = this.cache.get(projectKey);
    if (!force && hit && this.now() - hit.at < this.ttlMs) return hit.columns;
    const columns = await this.client.listProjectColumns(projectKey);
    this.cache.set(projectKey, { columns, at: this.now() });
    return columns;
  }

  /** `null` khi dự án không có cột đó (kể cả sau khi tải lại). */
  async stateOf(
    projectKey: string,
    columnId: number,
  ): Promise<{ state: TicketState; column: ProjectColumn } | null> {
    let column = (await this.columnsOf(projectKey)).find((c) => c.id === columnId);
    // Cột vừa được thêm chưa có trong cache → tải lại một lần.
    if (!column) column = (await this.columnsOf(projectKey, true)).find((c) => c.id === columnId);
    return column ? { state: classifyColumn(column), column } : null;
  }
}
