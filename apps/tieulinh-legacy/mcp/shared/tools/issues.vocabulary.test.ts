import { describe, expect, test } from "bun:test";
import { getIssue, updateIssue, type IssueVocabulary, type TrackerConfig } from "./issues";

/**
 * Khoá lại lỗi người dùng thấy được: hai tool này dùng chung cho cả hai bot,
 * nhưng trước đây hard-code ví dụ mã "TECH-42" và xưng "đội Kỹ thuật" theo
 * Tiểu Linh — nên IRIS (tiền tố "PO", việc của team Sản phẩm) đi bảo người
 * dùng nhập sai định dạng mã ngay trong mô tả tool.
 */

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

/** Gom mọi chuỗi model đọc được: mô tả tool + mô tả từng trường input. */
function surfaceOf(tool: ReturnType<typeof getIssue>): string {
  const described = Object.values(tool.inputSchema as Record<string, any>)
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

  test("IRIS xưng 'yêu cầu', không xưng 'ticket'", () => {
    expect(surfaceOf(getIssue(iris, undefined, irisVocabulary))).toContain("yêu cầu");
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
