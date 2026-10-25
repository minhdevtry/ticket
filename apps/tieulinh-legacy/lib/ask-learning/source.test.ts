import { describe, expect, it } from "bun:test";
import { ticketsFromItsaplan, systemFromDescription, type ItsaplanReadSource } from "./source";
import { isCandidateComment } from "./candidate";

describe("ticketsFromItsaplan", () => {
  it("phân trang: lấy đầy đủ issue qua nhiều trang", async () => {
    const page1 = [
      {
        id: 1,
        sequenceNumber: 1,
        identifier: "TECH-1",
        title: "Vé 1",
        description: "- Hệ thống: CRM_Vuihoc",
        createdAt: "2026-10-01T00:00:00Z",
      },
      {
        id: 2,
        sequenceNumber: 2,
        identifier: "TECH-2",
        title: "Vé 2",
        description: "- Hệ thống: CRM_Vuihoc",
        createdAt: "2026-10-01T01:00:00Z",
      },
    ];
    const page2 = [
      {
        id: 3,
        sequenceNumber: 3,
        identifier: "TECH-3",
        title: "Vé 3",
        description: "- Hệ thống: LMS_Vuihoc",
        createdAt: "2026-10-01T02:00:00Z",
      },
    ];

    const requestedPages: number[] = [];
    const client: ItsaplanReadSource = {
      async listProjectIssues(_key, opts) {
        requestedPages.push(opts?.page ?? 1);
        if (opts?.page === 1) return page1;
        if (opts?.page === 2) return page2;
        return [];
      },
      async listComments() {
        return [];
      },
    };

    const tickets = await ticketsFromItsaplan(client, "TECH", { limit: 10, concurrency: 2 });
    expect(tickets.length).toBe(3);
    expect(tickets.map((t) => t.issueKey)).toEqual(["TECH-1", "TECH-2", "TECH-3"]);
    expect(requestedPages).toContain(1);
    expect(requestedPages).toContain(2);
  });

  it("detail fetch: gọi getIssue khi listProjectIssues không có description/system", async () => {
    const lightIssues = [{ id: 10, sequenceNumber: 10, identifier: "TECH-10", title: "Vé nhẹ" }];
    const detailMap: Record<
      number,
      {
        id: number;
        sequenceNumber: number;
        identifier: string;
        title: string;
        description: string;
        createdAt: string;
      }
    > = {
      10: {
        id: 10,
        sequenceNumber: 10,
        identifier: "TECH-10",
        title: "Vé nhẹ",
        description:
          "## Thông tin sự cố\n- Người báo: SA_A\n- Hệ thống: DUO_Vuihoc\n\n### Mô tả\nLỗi học tập",
        createdAt: "2026-10-05T10:00:00Z",
      },
    };

    let detailFetched = 0;
    const client: ItsaplanReadSource = {
      async listProjectIssues() {
        return lightIssues;
      },
      async getIssue(id) {
        detailFetched++;
        return detailMap[id];
      },
      async listComments() {
        return [
          {
            id: 101,
            body: '<p>@<span class="mention">SA_UserE</span> gửi ảnh nhé</p>',
            author: { name: "TechUser_C" },
            createdAt: "2026-10-05T11:00:00Z",
          },
        ];
      },
    };

    const tickets = await ticketsFromItsaplan(client, "TECH", { limit: 10 });
    expect(tickets.length).toBe(1);
    expect(detailFetched).toBe(1);
    expect(tickets[0].description).toContain("DUO_Vuihoc");
    expect(tickets[0].systemRaw).toBe("DUO_Vuihoc");
    expect(tickets[0].createdAt).toBe("2026-10-05T10:00:00Z");
    expect(tickets[0].comments.length).toBe(1);
    expect(isCandidateComment(tickets[0].comments[0].body, tickets[0].comments[0].actor)).toBe(
      true,
    );
  });

  it("không bao giờ gọi phương thức ghi (strictly read-only)", async () => {
    const touched: string[] = [];
    const proxyClient = new Proxy(
      {
        async listProjectIssues() {
          return [
            {
              id: 1,
              sequenceNumber: 1,
              identifier: "TECH-1",
              title: "T1",
              description: "- Hệ thống: CRM_Vuihoc",
              createdAt: "2026-10-01",
            },
          ];
        },
        async listComments() {
          return [];
        },
        async addComment() {
          throw new Error("WRITE VIOLATION: addComment");
        },
        async updateIssue() {
          throw new Error("WRITE VIOLATION: updateIssue");
        },
        async createIssue() {
          throw new Error("WRITE VIOLATION: createIssue");
        },
        async deleteIssue() {
          throw new Error("WRITE VIOLATION: deleteIssue");
        },
        async setFieldValue() {
          throw new Error("WRITE VIOLATION: setFieldValue");
        },
      } as unknown as ItsaplanReadSource,
      {
        get(target, prop: string) {
          touched.push(prop);
          return (target as unknown as Record<string, unknown>)[prop];
        },
      },
    );

    const tickets = await ticketsFromItsaplan(proxyClient, "TECH", { limit: 5 });
    expect(tickets.length).toBe(1);
    const writeMethods = [
      "addComment",
      "updateIssue",
      "createIssue",
      "deleteIssue",
      "setFieldValue",
      "linkIssues",
    ];
    for (const w of writeMethods) {
      expect(touched).not.toContain(w);
    }
  });

  it("systemFromDescription trích xuất chính xác cả JSON meta lẫn Markdown block", () => {
    const md =
      "## Thông tin sự cố\n- Người báo: SA_X\n- Hệ thống: CARE_Vuihoc\n- Phân loại lỗi: Kỹ thuật\n\n### Mô tả\nLỗi";
    expect(systemFromDescription(md)).toBe("CARE_Vuihoc");

    const json =
      '<!-- vuihoc-meta: {"system":"TUTOR_Vuihoc"} -->\n## Thông tin sự cố\n- Hệ thống: Khác';
    expect(systemFromDescription(json)).toBe("TUTOR_Vuihoc");

    const simple = "- Hệ thống: LMS_Vuihoc";
    expect(systemFromDescription(simple)).toBe("LMS_Vuihoc");
  });
});
