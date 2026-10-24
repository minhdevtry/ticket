import { describe, expect, test, mock, beforeEach } from "bun:test";
import { TicketLifecycleService } from "./lifecycle";
import { Database } from "bun:sqlite";
import { applySchema } from "../lib/storage/schema";
import type { ItsaplanClient, ItsaplanIssue, ProjectColumn } from "../lib/itsaplan/client";
import type { Notifier } from "./notifier";

describe("TicketLifecycleService", () => {
  let db: any;
  let mockItsaplan: ItsaplanClient;
  let mockAdapter: Notifier;
  let botMap: Map<string, Notifier>;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);

    mockItsaplan = {
      listProjectColumns: mock(async (): Promise<ProjectColumn[]> => [
        { id: 1, name: "Todo", position: 1, stateType: "unstarted" },
        { id: 2, name: "In Progress", position: 2, stateType: "started" },
        { id: 3, name: "Resolved", position: 3, stateType: "completed" },
        { id: 4, name: "Done", position: 4, stateType: "completed" },
      ]),
      updateIssue: mock(async () => ({} as any)),
      addComment: mock(async () => ({} as any)),
      getIssue: mock(async (id: number): Promise<ItsaplanIssue> => ({
        id,
        projectId: 1,
        sequenceNumber: id,
        identifier: `TECH-${id}`,
        title: "Test Issue",
        description: "Test Description",
        priority: "medium",
        columnId: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    } as unknown as ItsaplanClient;

    mockAdapter = {
      channelType: "telegram",
      notifyComment: mock(async () => "msg-1"),
      notifyStateChange: mock(async () => "msg-2"),
      clearInteractiveButtons: mock(async () => {}),
      broadcastAlert: mock(async () => {}),
    };

    botMap = new Map();
    botMap.set("telegram", mockAdapter);
  });


  test("runSlaCheck triggers broadcast alert on breached ticket", async () => {
    const service = new TicketLifecycleService(db, mockItsaplan, {
      botAdapters: botMap,
      slaThresholds: { urgent: 1, high: 2 },
    });

    service.recordSlaTarget({
      issueId: 303,
      identifier: "TECH-303",
      priority: "urgent",
      projectKey: "TECH",
      createdAt: 1000,
    });

    // 30 mins later (< 1h) -> no alert
    const countBefore = await service.runSlaCheck(1000 + 30 * 60 * 1000);
    expect(countBefore).toBe(0);
    expect(mockAdapter.broadcastAlert).toHaveBeenCalledTimes(0);

    // 70 mins later (> 1h) -> breached!
    const countAfter = await service.runSlaCheck(1000 + 70 * 60 * 1000);
    expect(countAfter).toBe(1);
    expect(mockAdapter.broadcastAlert).toHaveBeenCalledTimes(1);

    // Running again does not send duplicate alert
    const countAgain = await service.runSlaCheck(1000 + 80 * 60 * 1000);
    expect(countAgain).toBe(0);
    expect(mockAdapter.broadcastAlert).toHaveBeenCalledTimes(1);
  });

  test("runSlaCheck detects when issue was already moved in-progress", async () => {
    mockItsaplan.getIssue = mock(async (id: number): Promise<ItsaplanIssue> => ({
      id,
      projectId: 1,
      sequenceNumber: id,
      identifier: `TECH-${id}`,
      title: "Test Issue",
      description: "Test Description",
      priority: "urgent",
      columnId: 2, // Column 2 is "In Progress" (stateType: "started")
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const service = new TicketLifecycleService(db, mockItsaplan, {
      botAdapters: botMap,
      slaThresholds: { urgent: 1 },
    });

    service.recordSlaTarget({
      issueId: 404,
      identifier: "TECH-404",
      priority: "urgent",
      projectKey: "TECH",
      createdAt: 1000,
    });

    // Run after SLA timeout: since issue is In Progress, no alert should be sent
    const count = await service.runSlaCheck(1000 + 2 * 3600 * 1000);
    expect(count).toBe(0);
    expect(mockAdapter.broadcastAlert).toHaveBeenCalledTimes(0);
  });


  test("runSlaCheck chỉ xử lý bản ghi của dự án worker", async () => {
    const service = new TicketLifecycleService(db, mockItsaplan, {
      botAdapters: botMap,
      slaThresholds: { urgent: 1 },
      projectKey: "PO",
    });
    service.recordSlaTarget({ issueId: 101, identifier: "TECH-1", priority: "urgent", projectKey: "TECH", createdAt: 0 });
    service.recordSlaTarget({ issueId: 102, identifier: "PO-2", priority: "urgent", projectKey: "PO", createdAt: 0 });

    expect(await service.runSlaCheck(2 * 3600 * 1000)).toBe(1);
    expect(mockAdapter.broadcastAlert).toHaveBeenCalledTimes(1);
    expect((mockAdapter.broadcastAlert as any).mock.calls[0][0]).toContain("PO-2");
  });

  test("lượt quét chồng nhau bị bỏ qua (không cảnh báo 2 lần)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowGetIssue = mockItsaplan.getIssue;
    mockItsaplan.getIssue = mock(async (id: number) => {
      await gate;
      return slowGetIssue(id);
    }) as any;
    const service = new TicketLifecycleService(db, mockItsaplan, { botAdapters: botMap, slaThresholds: { urgent: 1 } });
    service.recordSlaTarget({ issueId: 9, identifier: "TECH-9", priority: "urgent", projectKey: "TECH", createdAt: 0 });

    const first = service.runSweep(2 * 3600 * 1000);
    const second = await service.runSweep(2 * 3600 * 1000);
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(mockAdapter.broadcastAlert).toHaveBeenCalledTimes(1);
  });

  // ADR-0006: không còn gì tự chuyển ticket sang Done.
  test("lượt quét không bao giờ đổi cột ticket trên Itsaplan", async () => {
    const service = new TicketLifecycleService(db, mockItsaplan, { botAdapters: botMap });
    service.recordSlaTarget({ issueId: 5, identifier: "TECH-5", priority: "low", projectKey: "TECH", createdAt: 0 });
    await service.runSweep(100 * 3600 * 1000);
    expect(mockItsaplan.updateIssue).not.toHaveBeenCalled();
  });
});
