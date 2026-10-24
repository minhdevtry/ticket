import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  extractTicketKeys,
  resolveRelatedTicketsFieldId,
  clearRelatedTicketsFieldCache,
  syncRelatedTickets,
} from "./related-tickets-sync";
import type { ItsaplanClient, ItsaplanIssue, ItsaplanCustomField } from "../lib/itsaplan/client";

describe("related-tickets-sync", () => {
  describe("extractTicketKeys", () => {
    it("trích xuất mã ticket ngăn cách bằng dấu phẩy và khoảng trắng", () => {
      const keys = extractTicketKeys("TECH-123, TECH-456, TECH-789");
      expect(keys).toEqual(["TECH-123", "TECH-456", "TECH-789"]);
    });

    it("trích xuất mã ticket ngăn cách chỉ bằng khoảng trắng hoặc xuống dòng", () => {
      const keys = extractTicketKeys("TECH-101   TECH-102\nTECH-103\tTECH-104");
      expect(keys).toEqual(["TECH-101", "TECH-102", "TECH-103", "TECH-104"]);
    });

    it("tự động chuyển thành chữ hoa và loại bỏ trùng lặp", () => {
      const keys = extractTicketKeys("tech-100, TECH-100, Tech-100, TECH-200");
      expect(keys).toEqual(["TECH-100", "TECH-200"]);
    });

    it("bóc tách mã ticket nằm xen lẫn trong văn bản tự nhiên", () => {
      const text = "Lỗi này tương tự ticket TECH-55 và có liên quan đến TECH-88 bên đội hạ tầng.";
      const keys = extractTicketKeys(text);
      expect(keys).toEqual(["TECH-55", "TECH-88"]);
    });

    it("trả về mảng rỗng nếu chuỗi rỗng hoặc không có mã ticket hợp lệ", () => {
      expect(extractTicketKeys("")).toEqual([]);
      expect(extractTicketKeys("không có ticket nào")).toEqual([]);
      expect(extractTicketKeys(null as any)).toEqual([]);
      expect(extractTicketKeys(undefined as any)).toEqual([]);
    });
  });

  describe("syncRelatedTickets", () => {
    beforeEach(() => {
      clearRelatedTicketsFieldCache();
    });

    it("tự động liên kết các ticket mới và bỏ qua ticket đã có trong Links", async () => {
      const customFields: ItsaplanCustomField[] = [
        { id: 1, name: "Causes", fieldType: "markdown" },
        { id: 2, name: "Solutions", fieldType: "markdown" },
        { id: 3, name: "Related Tickets", fieldType: "markdown" },
      ];

      const currentIssue: ItsaplanIssue = {
        id: 100,
        projectId: 1,
        sequenceNumber: 100,
        identifier: "TECH-100",
        title: "Lỗi đăng nhập",
        description: "Mô tả",
        priority: "high",
        columnId: 1,
        createdAt: "2026-09-16T00:00:00Z",
        updatedAt: "2026-09-16T00:00:00Z",
        fields: [
          {
            fieldId: 3,
            value: "TECH-100, TECH-200, TECH-300", // TECH-100 là chính nó, TECH-200 đã link, TECH-300 chưa link
          },
        ],
        links: [
          {
            id: 10,
            kind: "relates",
            issue: { id: 200, identifier: "TECH-200", title: "Ticket cũ", sequenceNumber: 200 },
          },
        ],
      };

      const targetIssue300: ItsaplanIssue = {
        id: 300,
        projectId: 1,
        sequenceNumber: 300,
        identifier: "TECH-300",
        title: "Ticket liên quan mới",
        description: "",
        priority: "medium",
        columnId: 1,
        createdAt: "2026-09-16T00:00:00Z",
        updatedAt: "2026-09-16T00:00:00Z",
      };

      const addedLinks: any[] = [];

      const mockClient = {
        listCustomFields: mock(async () => customFields),
        getIssue: mock(async () => currentIssue),
        getIssueByNumber: mock(async (projectKey: string, seq: number) => {
          if (projectKey === "TECH" && seq === 300) return targetIssue300;
          return null;
        }),
        addLink: mock(async (sourceId: number, targetId: number, kind: string) => {
          addedLinks.push({ sourceId, targetId, kind });
          return { id: 999, kind };
        }),
      } as unknown as ItsaplanClient;

      const newlyLinked = await syncRelatedTickets(mockClient, 100);

      // TECH-100 bị bỏ qua vì là chính nó (self-link)
      // TECH-200 bị bỏ qua vì đã có trong currentIssue.links
      // Chỉ có TECH-300 được link mới
      expect(newlyLinked).toEqual(["TECH-300"]);
      expect(addedLinks).toHaveLength(1);
      expect(addedLinks[0]).toEqual({
        sourceId: 100,
        targetId: 300,
        kind: "relates",
      });
    });

    it("trả về mảng rỗng nếu trường Related Tickets không có giá trị", async () => {
      const customFields: ItsaplanCustomField[] = [
        { id: 3, name: "Related Tickets", fieldType: "markdown" },
      ];

      const currentIssue: ItsaplanIssue = {
        id: 101,
        projectId: 1,
        sequenceNumber: 101,
        identifier: "TECH-101",
        title: "Ticket không có related",
        description: "",
        priority: "low",
        columnId: 1,
        createdAt: "2026-09-16T00:00:00Z",
        updatedAt: "2026-09-16T00:00:00Z",
        fields: [],
        links: [],
      };

      const mockClient = {
        listCustomFields: mock(async () => customFields),
        getIssue: mock(async () => currentIssue),
        addLink: mock(async () => ({ id: 1, kind: "relates" })),
      } as unknown as ItsaplanClient;

      const newlyLinked = await syncRelatedTickets(mockClient, 101);
      expect(newlyLinked).toEqual([]);
    });

    // Bài học tech lead (audit 25/09): nếu người đã gỡ link native (link_remove),
    // syncRelatedTickets KHÔNG được tự động link lại mã đó từ trường text —
    // nếu không, hành động sửa tay của con người bị bot đạp đổ ở lần sync sau.
    it("mã đã từng bị người gỡ (link_remove trong timeline) KHÔNG được tự động liên kết lại", async () => {
      const customFields: ItsaplanCustomField[] = [
        { id: 3, name: "Related Tickets", fieldType: "markdown" },
      ];

      const currentIssue: ItsaplanIssue = {
        id: 102,
        projectId: 1,
        sequenceNumber: 102,
        identifier: "TECH-102",
        title: "Ticket có liên kết bị gỡ",
        description: "",
        priority: "medium",
        columnId: 1,
        createdAt: "2026-09-16T00:00:00Z",
        updatedAt: "2026-09-16T00:00:00Z",
        fields: [{ fieldId: 3, value: "TECH-400, TECH-500" }],
        links: [],
      };

      // Timeline có sự kiện người (TechLead_A) gỡ TECH-400
      const timeline = [
        {
          action: "link_remove",
          actorName: "TechLead_A",
          payload: { subject: { value: "relates" }, to: { value: "TECH-400", id: 400 } },
        },
      ];

      const addedLinks: any[] = [];
      const mockClient = {
        listCustomFields: mock(async () => customFields),
        getIssue: mock(async () => currentIssue),
        getIssueTimeline: mock(async () => timeline),
        getIssueByNumber: mock(async (_pk: string, seq: number) => ({
          id: seq,
          identifier: `TECH-${seq}`,
        })),
        addLink: mock(async (sourceId: number, targetId: number, kind: string) => {
          addedLinks.push({ sourceId, targetId, kind });
          return { id: 1, kind };
        }),
      } as unknown as ItsaplanClient;

      const newlyLinked = await syncRelatedTickets(mockClient, 102);
      // TECH-400 bị chặn vì có link_remove của người; chỉ TECH-500 được link
      expect(newlyLinked).toEqual(["TECH-500"]);
      expect(addedLinks).toHaveLength(1);
      expect(addedLinks[0].targetId).toBe(500);
    });

    it("bỏ qua ticket đã bị chuyển sang dự án khác (#493 issue_key_alias trả identifier mới)", async () => {
      const customFields: ItsaplanCustomField[] = [
        { id: 3, name: "Related Tickets", fieldType: "markdown" },
      ];
      const currentIssue: ItsaplanIssue = {
        id: 103,
        projectId: 1,
        sequenceNumber: 103,
        identifier: "TECH-103",
        title: "Ticket gốc",
        description: "",
        priority: "medium",
        columnId: 1,
        createdAt: "2026-09-16T00:00:00Z",
        updatedAt: "2026-09-16T00:00:00Z",
        fields: [{ fieldId: 3, value: "TECH-400, TECH-500" }],
        links: [],
      };
      const addedLinks: Array<{ sourceId: number; targetId: number; kind: string }> = [];
      const mockClient = {
        listCustomFields: mock(async () => customFields),
        getIssue: mock(async () => currentIssue),
        getIssueTimeline: mock(async () => []),
        getIssueByNumber: mock(async (_pk: string, seq: number) => ({
          id: seq,
          // TECH-400 đã bị move sang PO-99
          identifier: seq === 400 ? "PO-99" : `TECH-${seq}`,
        })),
        addLink: mock(async (sourceId: number, targetId: number, kind: string) => {
          addedLinks.push({ sourceId, targetId, kind });
          return { id: 1, kind };
        }),
      } as unknown as ItsaplanClient;

      const newlyLinked = await syncRelatedTickets(mockClient, 103);
      expect(newlyLinked).toEqual(["TECH-500"]);
      expect(addedLinks).toHaveLength(1);
      expect(addedLinks[0]?.targetId).toBe(500);
    });
  });
});
