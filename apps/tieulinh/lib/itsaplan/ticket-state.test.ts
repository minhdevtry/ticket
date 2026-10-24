import { describe, expect, it } from "bun:test";
import type { ItsaplanClient, ProjectColumn } from "./client";
import { classifyColumn, ProjectColumnStates } from "./ticket-state";

// Cột THẬT tra từ Itsaplan ngày 24/09/2026.
const col = (id: number, name: string, stateType: ProjectColumn["stateType"]): ProjectColumn => ({
  id,
  name,
  stateType,
  position: id,
});
const TECH = [
  col(1, "Backlog", "backlog"),
  col(2, "Todo", "unstarted"),
  col(3, "In Progress", "started"),
  col(6, "Resolved", "completed"),
  col(4, "Done", "completed"),
  col(5, "Canceled", "canceled"),
];
const PO = [
  col(7, "Backlog", "backlog"),
  col(8, "Todo", "unstarted"),
  col(9, "In Progress", "started"),
  col(10, "Done", "completed"),
  col(11, "Canceled", "canceled"),
];

describe("classifyColumn", () => {
  it("TECH: Resolved nằm nhóm completed nhưng vẫn là đã xử lý, không phải hoàn tất", () => {
    expect(TECH.map(classifyColumn)).toEqual([
      "open",
      "open",
      "open",
      "resolved",
      "done",
      "canceled",
    ]);
  });

  it("PO (chưa có Resolved): Done là hoàn tất", () => {
    expect(PO.map(classifyColumn)).toEqual(["open", "open", "open", "done", "canceled"]);
  });

  it("cột Resolved thêm vào nhóm started (PO/TECHTEST sau 24/09) vẫn là đã xử lý; tên tiếng Việt cũng nhận", () => {
    expect(classifyColumn(col(12, "Resolved", "started"))).toBe("resolved");
    expect(classifyColumn(col(13, "Đã xử lý", "started"))).toBe("resolved");
    expect(classifyColumn(col(14, "  resolved ", "completed"))).toBe("resolved");
  });
});

function fakeClient(columnsByProject: Record<string, ProjectColumn[]>) {
  let calls = 0;
  const client = {
    listProjectColumns: async (key: string) => {
      calls++;
      return columnsByProject[key] ?? [];
    },
  } as unknown as ItsaplanClient;
  return {
    client,
    calls: () => calls,
    set: (key: string, cols: ProjectColumn[]) => (columnsByProject[key] = cols),
  };
}

describe("ProjectColumnStates", () => {
  // Webhook state_changed thật chỉ mang columnId (không có tên cột / stateType).
  it("tra trạng thái theo columnId của đúng dự án", async () => {
    const f = fakeClient({ TECH, PO });
    const states = new ProjectColumnStates(f.client);
    expect((await states.stateOf("TECH", 4))?.state).toBe("done");
    expect((await states.stateOf("TECH", 6))?.state).toBe("resolved");
    expect((await states.stateOf("PO", 10))?.state).toBe("done");
    expect(await states.stateOf("PO", 4)).toBeNull(); // id 4 của TECH không có nghĩa gì ở PO
  });

  it("cache theo dự án; gặp columnId lạ (vừa thêm cột) thì tải lại một lần", async () => {
    const f = fakeClient({ PO: [...PO] });
    const states = new ProjectColumnStates(f.client);
    await states.stateOf("PO", 9);
    await states.stateOf("PO", 10);
    expect(f.calls()).toBe(1);
    f.set("PO", [...PO, col(12, "Resolved", "started")]);
    expect((await states.stateOf("PO", 12))?.state).toBe("resolved");
    expect(f.calls()).toBe(2);
  });
});
