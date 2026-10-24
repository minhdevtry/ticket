import { describe, expect, test } from "bun:test";
import {
  findIssueByIdentifier,
  issueWebUrl,
  parseIdentifier,
  projectTeamRef,
  resolveProjectTeamRef,
} from "./project";
import type { ItsaplanClient, ItsaplanIssue, ItsaplanProject, ProjectColumn } from "./client";

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
  });

  test("chuẩn hoá chữ hoa và khoảng trắng thừa", () => {
    expect(parseIdentifier("  tech-42 ")).toEqual({ projectKey: "TECH", sequence: 42 });
  });

  test("cho phép khoá dự án có chữ số ở sau chữ cái đầu (chuẩn mới ^[A-Z][A-Z0-9]{0,9}$)", () => {
    expect(parseIdentifier("TECH2-42")).toEqual({ projectKey: "TECH2", sequence: 42 });
    expect(parseIdentifier("v2-9")).toEqual({ projectKey: "V2", sequence: 9 });
    expect(parseIdentifier("B2B1-105")).toEqual({ projectKey: "B2B1", sequence: 105 });
  });

  test("trả null khi không phải mã hoặc bắt đầu bằng chữ số (không khớp nhầm SĐT/ngày)", () => {
    for (const s of ["TECH", "42", "TECH-", "TECH-4a", "", "0900-000005", "2026-10", "2TECH-15", "TECH_1-5"]) {
      expect(parseIdentifier(s)).toBeNull();
    }
  });
});

describe("issueWebUrl & teamRef", () => {
  test("dựng link mới /<teamRef>/issue/<KEY>-<n> khi có teamRef (slug hoặc id/ref)", () => {
    expect(issueWebUrl("https://itsaplan.example.com/", "TECH", "TECH-42", 42, "vuihoc")).toBe(
      "https://itsaplan.example.com/vuihoc/issue/TECH-42",
    );
    expect(
      issueWebUrl("https://itsaplan.example.com", "PO", "PO-48", undefined, {
        teamRef: "product",
        ref: "product.PO",
      }),
    ).toBe("https://itsaplan.example.com/product/issue/PO-48");
    // Chưa đặt slug team: dùng teamId / ref từ getProject()
    expect(
      issueWebUrl("https://itsaplan.example.com", "TECH", "TECH-42", 42, {
        teamRef: "",
        ref: "12.TECH",
      }),
    ).toBe("https://itsaplan.example.com/12/issue/TECH-42");
    expect(
      issueWebUrl("https://itsaplan.example.com", "TECH", "TECH-42", 42, {
        teamId: 7,
      }),
    ).toBe("https://itsaplan.example.com/7/issue/TECH-42");
  });

  test("không lấy được teamRef thì giữ nguyên link dạng cũ /project/<KEY>/issue/<n>", () => {
    expect(issueWebUrl("https://itsaplan.example.com/", "PO", "PO-48")).toBe(
      "https://itsaplan.example.com/project/PO/issue/48",
    );
    expect(issueWebUrl("https://itsaplan.example.com", "TECH", "TECH-42", 42, null)).toBe(
      "https://itsaplan.example.com/project/TECH/issue/42",
    );
    expect(projectTeamRef({})).toBeUndefined();
  });

  test("resolveProjectTeamRef lấy teamRef từ getProject() và chịu lỗi an toàn", async () => {
    const okClient = {
      getProject: async (key: string): Promise<ItsaplanProject> => ({
        id: 1,
        key,
        name: "Tech",
        teamRef: "vh-tech",
        ref: `vh-tech.${key}`,
      }),
    };
    expect(await resolveProjectTeamRef(okClient, "TECH")).toBe("vh-tech");

    const failClient = {
      getProject: async (): Promise<ItsaplanProject> => {
        throw new Error("network error");
      },
    };
    expect(await resolveProjectTeamRef(failClient, "TECH")).toBeUndefined();
  });
});

describe("findIssueByIdentifier chỉ trong dự án của bot", () => {
  // 28/09: IRIS (PO) trả TECHTEST-110 của Tiểu Linh — hai bot chung Itsaplan,
  // không khoá thì tra/cập nhật/giục gấp được cả ticket của bot kia.
  const client: Pick<ItsaplanClient, "getIssueByNumber"> = {
    getIssueByNumber: async (pk: string, seq: number) =>
      ({ id: seq, identifier: `${pk}-${seq}` }) as unknown as ItsaplanIssue,
  };

  test("mã đúng dự án → trả ticket", async () => {
    expect((await findIssueByIdentifier(client, "po-80", "PO"))?.identifier).toBe("PO-80");
  });

  test("mã dự án khác → null, không đổi sang cùng số ở dự án mình", async () => {
    expect(await findIssueByIdentifier(client, "TECHTEST-110", "PO")).toBeNull();
    expect(await findIssueByIdentifier(client, "PO-80", "TECH")).toBeNull();
  });

  test("ticket đã bị chuyển sang dự án khác (#493 issue_key_alias) → trả null", async () => {
    const movedClient: Pick<ItsaplanClient, "getIssueByNumber"> = {
      getIssueByNumber: async () =>
        ({ id: 42, identifier: "PO-105" }) as unknown as ItsaplanIssue,
    };
    expect(await findIssueByIdentifier(movedClient, "TECH-42", "TECH")).toBeNull();
    expect(await findIssueByIdentifier(movedClient, "TECH-42")).toBeNull();
  });
});
