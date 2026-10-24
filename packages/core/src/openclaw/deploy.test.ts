import { describe, expect, it } from "bun:test";
import {
  planWorkspaceSync,
  summarizeSyncPlan,
  spliceConfigBlock,
  removeConfigBlock,
  mergeJsonConfig,
  buildBinaryCommand,
  checkCompileReadiness,
  isCompileReady,
} from "./deploy";

/**
 * A2 — deploy/sync/build. Test chứng minh ba thao tác CHUNG: sync file idempotent,
 * splice config không nhân đôi, dựng lệnh build + kiểm tiền đề compile. Thuần,
 * không chạm host.
 */

describe("planWorkspaceSync (idempotent)", () => {
  const desired = [
    { path: "IDENTITY.md", content: "# OP" },
    { path: "bot.json", content: '{"a":1}' },
  ];

  it("file chưa có → create; khác nội dung → update; giống → unchanged", () => {
    const plan = planWorkspaceSync(desired, { "IDENTITY.md": "# OP", "bot.json": '{"a":0}' });
    expect(plan.find((e) => e.path === "IDENTITY.md")!.action).toBe("unchanged");
    expect(plan.find((e) => e.path === "bot.json")!.action).toBe("update");
  });

  it("chạy lại khi mọi thứ khớp → toàn unchanged (không ghi gì)", () => {
    const plan = planWorkspaceSync(desired, { "IDENTITY.md": "# OP", "bot.json": '{"a":1}' });
    expect(summarizeSyncPlan(plan)).toEqual({ create: 0, update: 0, unchanged: 2 });
  });

  it("thiếu cả hai → create cả hai, kèm content", () => {
    const plan = planWorkspaceSync(desired, {});
    expect(summarizeSyncPlan(plan)).toEqual({ create: 2, update: 0, unchanged: 0 });
    expect(plan[0]!.content).toBe("# OP");
  });
});

describe("spliceConfigBlock (idempotent, không nhân đôi)", () => {
  it("file trống → chèn khối", () => {
    const out = spliceConfigBlock("", 'provider = "openai-http"');
    expect(out).toContain("bot-core BEGIN");
    expect(out).toContain('provider = "openai-http"');
    expect(out).toContain("bot-core END");
  });

  it("splice hai lần cùng block → kết quả giống (không nhân đôi)", () => {
    const once = spliceConfigBlock("existing = true\n", "x = 1");
    const twice = spliceConfigBlock(once, "x = 1");
    expect(twice).toBe(once);
    // chỉ một cặp marker
    expect(twice.match(/bot-core BEGIN/g)).toHaveLength(1);
  });

  it("splice block MỚI vào khối cũ → thay phần giữa, giữ phần ngoài", () => {
    const first = spliceConfigBlock("keep_me = 1\n", "old = 1");
    const second = spliceConfigBlock(first, "new = 2");
    expect(second).toContain("keep_me = 1");
    expect(second).toContain("new = 2");
    expect(second).not.toContain("old = 1");
    expect(second.match(/bot-core BEGIN/g)).toHaveLength(1);
  });

  it("removeConfigBlock gỡ sạch khối, giữ phần ngoài", () => {
    const spliced = spliceConfigBlock("keep = 1\n", "x = 1");
    const removed = removeConfigBlock(spliced);
    expect(removed).toContain("keep = 1");
    expect(removed).not.toContain("bot-core BEGIN");
    expect(removed).not.toContain("x = 1");
  });
});

describe("mergeJsonConfig (idempotent cho JSON)", () => {
  it("trộn nông, patch ghi đè, object lồng trộn một cấp", () => {
    const base: Record<string, any> = { agent: "op", mcp: { a: 1, b: 2 }, caps: ["x"] };
    const merged = mergeJsonConfig(base, { mcp: { b: 9, c: 3 }, caps: ["y"] });
    expect(merged.agent).toBe("op");
    expect(merged.mcp).toEqual({ a: 1, b: 9, c: 3 });
    expect(merged.caps).toEqual(["y"]); // mảng ghi đè, không nối
  });

  it("merge cùng patch hai lần → giống nhau", () => {
    const base = { x: 1 };
    const a = mergeJsonConfig(base, { y: 2 });
    const b = mergeJsonConfig(a, { y: 2 });
    expect(b).toEqual(a);
  });
});

describe("buildBinaryCommand", () => {
  it("dựng argv đúng, có target + minify", () => {
    const argv = buildBinaryCommand({
      entrypoint: "mcp/op/index.ts",
      outfile: "dist/op",
      target: "bun-linux-x64",
      minify: true,
    });
    expect(argv).toEqual([
      "bun",
      "build",
      "mcp/op/index.ts",
      "--compile",
      "--outfile",
      "dist/op",
      "--target",
      "bun-linux-x64",
      "--minify",
    ]);
  });
  it("mặc định không target/minify, bunBin đổi được", () => {
    const argv = buildBinaryCommand({ entrypoint: "e.ts", outfile: "o", bunBin: "/opt/bun" });
    expect(argv).toEqual(["/opt/bun", "build", "e.ts", "--compile", "--outfile", "o"]);
  });
});

describe("checkCompileReadiness (hai luật chống phình nhị phân)", () => {
  it("nguồn sạch → sẵn sàng", () => {
    const src = `import { foo } from "./pure";\nexport default foo;`;
    expect(checkCompileReadiness({ entrypointSource: src })).toEqual([]);
    expect(isCompileReady({ entrypointSource: src })).toBe(true);
  });

  it("readFileSync lookup → block (không sống sót --compile)", () => {
    const src = `const t = readFileSync("./table.json");`;
    const issues = checkCompileReadiness({ entrypointSource: src });
    expect(issues.some((i) => i.code === "readfile-in-compile" && i.severity === "block")).toBe(
      true,
    );
    expect(isCompileReady({ entrypointSource: src })).toBe(false);
  });

  it("import runtime nặng trong entrypoint → warn (không block)", () => {
    const src = `import { Bot } from "telegraf";`;
    const issues = checkCompileReadiness({ entrypointSource: src });
    expect(issues.some((i) => i.code === "heavy-runtime-import" && i.severity === "warn")).toBe(
      true,
    );
    expect(isCompileReady({ entrypointSource: src })).toBe(true); // warn không chặn
  });

  it("quét cả extraSources", () => {
    const issues = checkCompileReadiness({
      entrypointSource: "ok",
      extraSources: ['readFile("x")'],
    });
    expect(issues.some((i) => i.code === "readfile-in-compile")).toBe(true);
  });
});
