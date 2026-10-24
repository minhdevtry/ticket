import { describe, expect, test } from "bun:test";
import { identifierInProject, normalizeProjectKey, projectOfIdentifier } from "./project-lock";

// Ported from intake worker/project-lock (ADR-0001).
describe("project-lock", () => {
  test("normalizeProjectKey: trim + upper; rỗng → null", () => {
    expect(normalizeProjectKey("  tech ")).toBe("TECH");
    expect(normalizeProjectKey("")).toBeNull();
    expect(normalizeProjectKey(null)).toBeNull();
  });
  test("projectOfIdentifier: tiền tố dự án; không đọc được → null", () => {
    expect(projectOfIdentifier("TECH-12")).toBe("TECH");
    expect(projectOfIdentifier("0912-345")).toBeNull();
    expect(projectOfIdentifier("foo")).toBeNull();
  });
  test("identifierInProject: không khai dự án → nhận tất; mã lạ → không nhận", () => {
    expect(identifierInProject("TECH-1", null)).toBe(true);
    expect(identifierInProject("TECH-1", "TECH")).toBe(true);
    expect(identifierInProject("PO-1", "TECH")).toBe(false);
    expect(identifierInProject("rác", "TECH")).toBe(false);
  });
});
