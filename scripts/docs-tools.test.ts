import { describe, expect, test } from "bun:test";
import { isBehaviourFile, judge } from "./check-docs-touched";
import { parseCopyKeys } from "./gen-docs";

describe("check-docs-touched", () => {
  test("file hành vi công khai", () => {
    expect(isBehaviourFile("packages/core/src/intake/ports.ts")).toBe(true);
    expect(isBehaviourFile("apps/tieulinh/worker/index.ts")).toBe(true);
    expect(isBehaviourFile("apps/tieulinh/skills/tieulinh/SOUL.md")).toBe(true);
    expect(isBehaviourFile("deploy/push-secrets.sh")).toBe(true);
  });

  test("test, fixture, script chạy tay và README không phải hành vi", () => {
    expect(isBehaviourFile("packages/core/src/core/env.test.ts")).toBe(false);
    expect(isBehaviourFile("packages/core/src/intake/gate/catalog.fixture.ts")).toBe(false);
    expect(isBehaviourFile("apps/tieulinh/scripts/ask-learn.ts")).toBe(false);
    expect(isBehaviourFile("apps/tieulinh/openclaw-plugin/README.md")).toBe(false);
    expect(isBehaviourFile("docs/index.md")).toBe(false);
  });

  test("đổi hành vi mà không đụng docs thì fail", () => {
    const v = judge(["packages/core/src/core/env.ts"], []);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("missing-docs");
  });

  test("docs hoặc CHANGELOG đi kèm thì qua", () => {
    expect(judge(["packages/core/src/core/env.ts", "docs/how-to/x.md"], []).ok).toBe(true);
    expect(judge(["packages/core/src/core/env.ts", "packages/core/CHANGELOG.md"], []).ok).toBe(
      true,
    );
  });

  test("nhãn no-docs bỏ qua kiểm tra", () => {
    expect(judge(["packages/core/src/core/env.ts"], ["no-docs"]).reason).toBe("label");
  });

  test("PR không đổi hành vi thì qua", () => {
    expect(judge(["README.md", "scripts/foo.ts"], []).reason).toBe("no-behaviour-change");
  });
});

describe("parseCopyKeys", () => {
  const src = `
export type CopyKey =
  // ── nhóm một ──
  | "a.one" // ý một; {x}
  | "a.two"
  // ── nhóm hai ──
  | "b.three"; // cuối

const after = 1;
`;

  test("đọc khoá, nhóm và ghi chú", () => {
    expect(parseCopyKeys(src)).toEqual([
      { group: "nhóm một", key: "a.one", note: "ý một; {x}" },
      { group: "nhóm một", key: "a.two", note: "" },
      { group: "nhóm hai", key: "b.three", note: "cuối" },
    ]);
  });

  test("nguồn đổi hình dạng thì ném lỗi chứ không sinh trang rỗng", () => {
    expect(() => parseCopyKeys("export type Other = 1;")).toThrow();
  });
});
