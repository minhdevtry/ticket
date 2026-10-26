import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compare,
  compareBaseDelta,
  filterChangedFiles,
  getChangedFiles,
  parseArgs,
  readBaseline,
} from "./lint-baseline";
describe("lint-baseline", () => {
  test("đọc baseline và bỏ qua khóa chú thích", () => {
    const base = readBaseline();
    expect(base["suspicious/noExplicitAny"]).toBeGreaterThan(0);
    expect(Object.keys(base).every((k) => !k.startsWith("$"))).toBe(true);
  });

  test("số lỗi bằng baseline thì xanh", () => {
    const rows = compare({ "a/b": 3 }, { "a/b": 3 });
    expect(rows).toEqual([{ rule: "a/b", allowed: 3, actual: 3, ok: true }]);
  });

  test("số lỗi tăng thì đỏ", () => {
    const rows = compare({ "a/b": 3 }, { "a/b": 4 });
    expect(rows[0]?.ok).toBe(false);
  });

  test("số lỗi giảm thì vẫn xanh", () => {
    const rows = compare({ "a/b": 3 }, { "a/b": 1 });
    expect(rows[0]?.ok).toBe(true);
  });

  test("rule mới chưa có trong baseline thì mặc định 0 lỗi", () => {
    const rows = compare({}, { "a/b": 1 });
    expect(rows[0]?.allowed).toBe(0);
    expect(rows[0]?.ok).toBe(false);
  });
});

describe("filterChangedFiles", () => {
  test("chỉ giữ file .ts, .tsx, .js, .jsx và loại trừ định dạng khác", () => {
    const input = [
      "src/index.ts",
      "src/component.tsx",
      "scripts/tool.js",
      "legacy/old.jsx",
      "README.md",
      "biome.json",
      "docs/index.html",
      "style.css",
    ];
    const out = filterChangedFiles(input);
    expect(out).toEqual(["src/index.ts", "src/component.tsx", "scripts/tool.js", "legacy/old.jsx"]);
  });

  test("loại bỏ khoảng trắng và trùng lặp", () => {
    const input = ["  src/a.ts  ", "", "   ", "src/a.ts", "src/b.ts"];
    const out = filterChangedFiles(input);
    expect(out).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("compareBaseDelta", () => {
  test("số lỗi bằng nhau hoặc giảm thì xanh (ok = true)", () => {
    const rows = compareBaseDelta(
      { "suspicious/noExplicitAny": 2, "style/noNonNullAssertion": 1 },
      { "suspicious/noExplicitAny": 2, "style/noNonNullAssertion": 3 },
    );
    expect(rows).toEqual([
      {
        rule: "style/noNonNullAssertion",
        head: 1,
        base: 3,
        delta: -2,
        ok: true,
        files: [],
      },
      {
        rule: "suspicious/noExplicitAny",
        head: 2,
        base: 2,
        delta: 0,
        ok: true,
        files: [],
      },
    ]);
  });

  test("số lỗi tăng thì đỏ và lưu danh sách file vi phạm", () => {
    const rows = compareBaseDelta(
      { "suspicious/noExplicitAny": 3 },
      { "suspicious/noExplicitAny": 1 },
      { "suspicious/noExplicitAny": ["src/new.ts"] },
    );
    expect(rows).toEqual([
      {
        rule: "suspicious/noExplicitAny",
        head: 3,
        base: 1,
        delta: 2,
        ok: false,
        files: ["src/new.ts"],
      },
    ]);
  });

  test("rule mới xuất hiện ở HEAD mà base chưa có thì đỏ", () => {
    const rows = compareBaseDelta({ "rule/new": 1 }, {});
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.delta).toBe(1);
  });
});

describe("parseArgs", () => {
  test("phân tích cờ --base và --write", () => {
    expect(parseArgs([])).toEqual({ write: false, base: undefined });
    expect(parseArgs(["--write"])).toEqual({ write: true, base: undefined });
    expect(parseArgs(["--base", "origin/main"])).toEqual({
      write: false,
      base: "origin/main",
    });
    expect(parseArgs(["--base=origin/feat-1"])).toEqual({
      write: false,
      base: "origin/feat-1",
    });
  });
});

describe("getChangedFiles với git repo tạm", () => {
  test("phát hiện file đổi và file mới chưa commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "git-test-"));
    try {
      Bun.spawnSync(["git", "init", "-b", "main"], { cwd: tmp });
      Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tmp });
      Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: tmp });
      writeFileSync(join(tmp, "init.ts"), "const a = 1;\n");
      Bun.spawnSync(["git", "add", "init.ts"], { cwd: tmp });
      Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: tmp });

      // Thêm nhánh mới
      Bun.spawnSync(["git", "checkout", "-b", "feat"], { cwd: tmp });
      writeFileSync(join(tmp, "feature.ts"), "const b = 2;\n");
      Bun.spawnSync(["git", "add", "feature.ts"], { cwd: tmp });
      Bun.spawnSync(["git", "commit", "-m", "add feature"], { cwd: tmp });

      // Thêm một file chưa commit trong worktree
      writeFileSync(join(tmp, "untracked.ts"), "const c = 3;\n");
      writeFileSync(join(tmp, "ignored.txt"), "hello\n");

      const changed = getChangedFiles("main", tmp);
      expect(changed.sort()).toEqual(["feature.ts", "untracked.ts"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
