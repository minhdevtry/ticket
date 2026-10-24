import { describe, expect, test } from "bun:test";
import {
  findIssueByIdentifier,
  issueWebUrl,
  parseIdentifier,
  projectTeamRef,
  resolveBacklogColumn,
  resolveProjectTeamRef,
} from "./project";
import type { ItsaplanClient, ItsaplanIssue, ItsaplanProject, ProjectColumn } from "./client";

// Ported from intake `lib/itsaplan/project.test.ts` + CM `tests/itsaplan-project.test.ts`.
let nextId = 1;
const col = (name: string, stateType: ProjectColumn["stateType"]): ProjectColumn => ({
  id: nextId++,
  name,
  stateType,
  position: 0,
});

describe("parseIdentifier", () => {
  test("tách mã dự án và số thứ tự", () => {
    expect(parseIdentifier("TECH-42")).toEqual({ projectKey: "TECH", sequence: 42 });
    expect(parseIdentifier("CMSUPPORT-12")).toEqual({ projectKey: "CMSUPPORT", sequence: 12 });
  });
  test("chuẩn hoá chữ hoa và khoảng trắng thừa", () => {
    expect(parseIdentifier("  tech-42 ")).toEqual({ projectKey: "TECH", sequence: 42 });
  });
  test("cho phép khoá dự án có chữ số (5bf501e)", () => {
    expect(parseIdentifier("TECH2-42")).toEqual({ projectKey: "TECH2", sequence: 42 });
    expect(parseIdentifier("B2B1-105")).toEqual({ projectKey: "B2B1", sequence: 105 });
  });
  test("trả null khi không phải mã hoặc bắt đầu bằng chữ số", () => {
    for (const s of ["TECH", "42", "TECH-", "TECH-4a", "", "0912-345678", "2026-10", "2TECH-15", "invalid"]) {
      expect(parseIdentifier(s)).toBeNull();
    }
  });
});

describe("issueWebUrl & teamRef", () => {
  test("link mới /<teamRef>/issue/<KEY>-<n> khi có teamRef", () => {
    expect(issueWebUrl("https://ticket.example.com/", "TECH", "TECH-42", 42, "vuihoc")).toBe(
      "https://ticket.example.com/vuihoc/issue/TECH-42",
    );
    expect(
      issueWebUrl("https://ticket.example.com", "PO", "PO-48", undefined, { teamRef: "product", ref: "product.PO" }),
    ).toBe("https://ticket.example.com/product/issue/PO-48");
    expect(issueWebUrl("https://ticket.example.com", "TECH", "TECH-42", 42, { teamId: 7 })).toBe(
      "https://ticket.example.com/7/issue/TECH-42",
    );
  });
  test("fallback /project/<KEY>/issue/<n> khi không có teamRef (hành vi CM)", () => {
    expect(issueWebUrl("https://itsaplan.example.com", "CMSUPPORT", "CMSUPPORT-1", 1)).toBe(
      "https://itsaplan.example.com/project/CMSUPPORT/issue/1",
    );
    expect(issueWebUrl("https://ticket.example.com", "TECH", "TECH-42", 42, null)).toBe(
      "https://ticket.example.com/project/TECH/issue/42",
    );
    expect(projectTeamRef({})).toBeUndefined();
  });
  test("resolveProjectTeamRef lấy teamRef và chịu lỗi an toàn", async () => {
    const ok = { getProject: async (key: string): Promise<ItsaplanProject> => ({ id: 1, key, name: "x", teamRef: "vh-tech", ref: `vh-tech.${key}` }) };
    expect(await resolveProjectTeamRef(ok, "TECH")).toBe("vh-tech");
    const fail = { getProject: async (): Promise<ItsaplanProject> => { throw new Error("net"); } };
    expect(await resolveProjectTeamRef(fail, "TECH")).toBeUndefined();
  });
});

describe("resolveBacklogColumn", () => {
  test("tìm cột backlog/unstarted (CM)", async () => {
    const project = {
      key: "CMSUPPORT",
      columns: [col("Đang xử lý", "started"), col("Ticket mới", "backlog")],
      raw: {} as ItsaplanProject,
    };
    const chosen = await resolveBacklogColumn({} as ItsaplanClient, project);
    expect(chosen.name).toBe("Ticket mới");
  });
});

describe("findIssueByIdentifier chỉ trong dự án của bot", () => {
  const client: Pick<ItsaplanClient, "getIssueByNumber"> = {
    getIssueByNumber: async (pk: string, seq: number) =>
      ({ id: seq, identifier: `${pk}-${seq}` }) as unknown as ItsaplanIssue,
  };
  test("mã đúng dự án → trả ticket", async () => {
    expect((await findIssueByIdentifier(client, "po-80", "PO"))?.identifier).toBe("PO-80");
  });
  test("mã dự án khác → null", async () => {
    expect(await findIssueByIdentifier(client, "TECHTEST-110", "PO")).toBeNull();
    expect(await findIssueByIdentifier(client, "PO-80", "TECH")).toBeNull();
  });
  test("ticket đã chuyển dự án (#493 issue_key_alias) → null", async () => {
    const moved: Pick<ItsaplanClient, "getIssueByNumber"> = {
      getIssueByNumber: async () => ({ id: 42, identifier: "PO-105" }) as unknown as ItsaplanIssue,
    };
    expect(await findIssueByIdentifier(moved, "TECH-42", "TECH")).toBeNull();
    expect(await findIssueByIdentifier(moved, "TECH-42")).toBeNull();
  });
});
