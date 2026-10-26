import { describe, expect, test } from "bun:test";
import { getIssue, updateIssue, type IssueVocabulary, type TrackerConfig } from "./issues";

const tieulinh: TrackerConfig = {
  baseUrl: "http://tracker.test",
  apiKey: "k",
  projectKey: "TECH",
};

const iris: TrackerConfig = {
  baseUrl: "http://tracker.test",
  apiKey: "k",
  projectKey: "PO",
};

const irisVocabulary: IssueVocabulary = {
  noun: "yêu cầu",
  handlerTeam: "Product team",
  commentAuthorFallback: "Người phụ trách",
};

function surfaceOf(tool: ReturnType<typeof getIssue>): string {
  const described = Object.values(tool.inputSchema as Record<string, { description?: string }>)
    .map((field) => field?.description ?? "")
    .join(" ");
  return `${tool.description} ${described}`;
}

describe("từ vựng của get_issue theo từng bot", () => {
  test("ví dụ mã suy từ projectKey, không hard-code TECH", () => {
    expect(surfaceOf(getIssue(iris, undefined, irisVocabulary))).toContain("PO-42");
    expect(surfaceOf(getIssue(iris, undefined, irisVocabulary))).not.toContain("TECH-42");
  });

  test("Tiểu Linh giữ nguyên chữ cũ khi không truyền từ vựng", () => {
    const surface = surfaceOf(getIssue(tieulinh));
    expect(surface).toContain("TECH-42");
    expect(surface).toContain("ticket");
  });
});

describe("từ vựng của update_issue theo từng bot", () => {
  test("ví dụ mã suy từ projectKey", () => {
    expect(surfaceOf(updateIssue(iris, undefined, irisVocabulary))).toContain("PO-42");
    expect(surfaceOf(updateIssue(iris, undefined, irisVocabulary))).not.toContain("TECH-42");
  });

  test("mặc định vẫn là TECH cho Tiểu Linh", () => {
    expect(surfaceOf(updateIssue(tieulinh))).toContain("TECH-42");
  });
});
