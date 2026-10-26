#!/usr/bin/env bun
/**
 * Canh số lỗi của các rule đang được TẮT trong `biome.json`.
 *
 * `biome.json` tắt `noExplicitAny` và `noNonNullAssertion` vì code hiện có có
 * nhiều. Tắt rule là một cách nợ: không có gì ngăn code mới thêm lỗi cùng loại.
 * Script này đếm lỗi của từng rule và đỏ khi số đó TĂNG so với baseline.
 *
 * Dùng: bun run scripts/lint-baseline.ts [--write]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BASELINE_PATH = "biome.lint-baseline.json";
export const RULES = ["suspicious/noExplicitAny", "style/noNonNullAssertion"] as const;
export const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

export type Baseline = Record<string, number>;

export function readBaseline(root = "."): Baseline {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as Baseline & { $comment?: string };
  const out: Baseline = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** Số lỗi hiện tại của một rule: biome `--only` vẫn đếm được rule đang tắt trong config. */
export function countRule(rule: string, root = "."): number {
  const proc = Bun.spawnSync(["bunx", "biome", "check", ".", `--only=${rule}`, "--reporter=json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString();
  if (!out.trim()) return 0;
  try {
    const parsed = JSON.parse(out) as { diagnostics?: unknown[] };
    return parsed.diagnostics?.length ?? 0;
  } catch {
    // biome không in JSON hợp lệ (ví dụ lỗi cấu hình) thì coi như không đếm được
    return Number.NaN;
  }
}

export function compare(
  baseline: Baseline,
  current: Baseline,
): { rule: string; allowed: number; actual: number; ok: boolean }[] {
  return Object.keys({ ...baseline, ...current })
    .sort()
    .map((rule) => {
      const allowed = baseline[rule] ?? 0;
      const actual = current[rule] ?? 0;
      return { rule, allowed, actual, ok: actual <= allowed };
    });
}

export interface BaseComparisonRow {
  rule: string;
  head: number;
  base: number;
  delta: number;
  ok: boolean;
  files: string[];
}

interface BiomeDiagnostic {
  category?: string;
  location?: { path?: string };
}

export function filterChangedFiles(files: string[]): string[] {
  const codeExtRegex = /\.(?:ts|tsx|js|jsx)$/;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const trimmed = f.trim();
    if (!trimmed) continue;
    if (!codeExtRegex.test(trimmed)) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function compareBaseDelta(
  head: Record<string, number>,
  base: Record<string, number>,
  filesByRule?: Record<string, string[]>,
): BaseComparisonRow[] {
  const rules = Array.from(new Set([...Object.keys(head), ...Object.keys(base)])).sort();
  return rules.map((rule) => {
    const h = head[rule] ?? 0;
    const b = base[rule] ?? 0;
    const delta = h - b;
    const ok = delta <= 0;
    const files = filesByRule?.[rule] ?? [];
    return { rule, head: h, base: b, delta, ok, files };
  });
}

export function getChangedFiles(base: string, root = "."): string[] {
  const diffProc = Bun.spawnSync(["git", "diff", "--name-only", `${base}...HEAD`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diffProc.exitCode !== 0) {
    const err = diffProc.stderr.toString().trim();
    throw new Error(`Không thể lấy git diff với base '${base}': ${err}`);
  }
  const unstagedProc = Bun.spawnSync(["git", "diff", "--name-only"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stagedProc = Bun.spawnSync(["git", "diff", "--name-only", "--cached"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const untrackedProc = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  const rawFiles = [
    ...diffProc.stdout.toString().split("\n"),
    ...unstagedProc.stdout.toString().split("\n"),
    ...stagedProc.stdout.toString().split("\n"),
    ...untrackedProc.stdout.toString().split("\n"),
  ];

  return filterChangedFiles(rawFiles);
}

export function countRulesInHead(
  rules: readonly string[],
  files: string[],
  root = ".",
): Record<string, { count: number; files: string[] }> {
  const existing = files.filter((f) => existsSync(join(root, f)));
  const out: Record<string, { count: number; files: string[] }> = {};
  for (const rule of rules) {
    if (existing.length === 0) {
      out[rule] = { count: 0, files: [] };
      continue;
    }
    const proc = Bun.spawnSync(
      ["bunx", "biome", "check", ...existing, `--only=${rule}`, "--reporter=json"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = proc.stdout.toString();
    try {
      const parsed = JSON.parse(stdout) as { diagnostics?: BiomeDiagnostic[] };
      const diags = (parsed.diagnostics ?? []).filter(
        (d) => d.category === `lint/${rule}` || d.category?.endsWith(rule),
      );
      const violatingFiles = Array.from(
        new Set(diags.map((d) => d.location?.path).filter((p): p is string => Boolean(p))),
      );
      out[rule] = { count: diags.length, files: violatingFiles };
    } catch {
      out[rule] = { count: 0, files: [] };
    }
  }
  return out;
}

export function countRulesInBase(
  rules: readonly string[],
  base: string,
  files: string[],
  root = ".",
): Record<string, { count: number; files: string[] }> {
  const out: Record<string, { count: number; files: string[] }> = {};
  for (const rule of rules) out[rule] = { count: 0, files: [] };
  if (files.length === 0) return out;

  const tmp = mkdtempSync(join(tmpdir(), "lint-base-"));
  try {
    let hasAny = false;
    for (const file of files) {
      const proc = Bun.spawnSync(["git", "show", `${base}:${file}`], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode === 0) {
        hasAny = true;
        const target = join(tmp, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, proc.stdout);
      }
    }
    if (!hasAny) return out;

    const configPath = resolve(root, "biome.json");
    for (const rule of rules) {
      const proc = Bun.spawnSync(
        [
          "bunx",
          "biome",
          "check",
          tmp,
          `--only=${rule}`,
          "--reporter=json",
          "--vcs-enabled=false",
          `--config-path=${configPath}`,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const stdout = proc.stdout.toString();
      try {
        const parsed = JSON.parse(stdout) as { diagnostics?: BiomeDiagnostic[] };
        const diags = (parsed.diagnostics ?? []).filter(
          (d) => d.category === `lint/${rule}` || d.category?.endsWith(rule),
        );
        const prefix = tmp.endsWith("/") ? tmp : `${tmp}/`;
        const violatingFiles = Array.from(
          new Set(
            diags
              .map((d) => {
                const p = d.location?.path ?? "";
                return p.startsWith(prefix) ? p.slice(prefix.length) : p;
              })
              .filter((p): p is string => Boolean(p)),
          ),
        );
        out[rule] = { count: diags.length, files: violatingFiles };
      } catch {
        out[rule] = { count: 0, files: [] };
      }
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function parseArgs(args: string[]): { write: boolean; base?: string } {
  let write = false;
  let base: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--write") {
      write = true;
    } else if (arg === "--base") {
      base = args[++i];
    } else if (arg?.startsWith("--base=")) {
      base = arg.slice("--base=".length);
    }
  }
  return { write, base };
}

if (import.meta.main) {
  const { write, base } = parseArgs(process.argv.slice(2));

  if (base) {
    let changedFiles: string[];
    try {
      changedFiles = getChangedFiles(base);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    if (changedFiles.length === 0) {
      console.log(`ok   Không có file mã nguồn (.ts/.tsx/.js/.jsx) nào thay đổi so với '${base}'.`);
      console.log("\nSố lỗi của các rule đang tắt không tăng.");
      process.exit(0);
    }

    const headResults = countRulesInHead(RULES, changedFiles);
    const baseResults = countRulesInBase(RULES, base, changedFiles);

    const headCounts: Record<string, number> = {};
    const baseCounts: Record<string, number> = {};
    const filesByRule: Record<string, string[]> = {};
    for (const rule of RULES) {
      headCounts[rule] = headResults[rule]?.count ?? 0;
      baseCounts[rule] = baseResults[rule]?.count ?? 0;
      filesByRule[rule] = headResults[rule]?.files ?? [];
    }

    const rows = compareBaseDelta(headCounts, baseCounts, filesByRule);
    const failed = rows.filter((r) => !r.ok);

    for (const row of rows) {
      if (row.ok) {
        console.log(`ok   ${row.rule}: không thêm lỗi mới (HEAD: ${row.head}, base: ${row.base})`);
      } else {
        const fileList = row.files.length > 0 ? ` [${row.files.join(", ")}]` : "";
        console.log(
          `LỖI  ${row.rule}: thêm ${row.delta} lỗi mới (HEAD: ${row.head}, base: ${row.base})${fileList}`,
        );
      }
    }

    if (failed.length > 0) {
      const details = failed
        .map(
          (r) =>
            `${r.rule} (+${r.delta} lỗi mới: HEAD ${r.head}, base ${r.base}${r.files.length > 0 ? `, file: ${r.files.join(", ")}` : ""})`,
        )
        .join("\n- ");
      console.error(
        `\nLỖI: Số lỗi của rule đang tắt đã TĂNG so với nhánh nền '${base}':\n- ${details}\n\nSửa code (bỏ any, bỏ khoá non-null) thay vì nới baseline. Nới baseline chỉ khi có lý do, ghi lý do trong PR.`,
      );
      process.exit(1);
    }

    console.log(`\nSố lỗi của các rule đang tắt không tăng so với nhánh nền '${base}'.`);
    process.exit(0);
  }

  const baseline = readBaseline();
  const current: Baseline = {};
  for (const rule of RULES) current[rule] = countRule(rule);

  if (write) {
    const body = {
      $comment:
        "Số lỗi tối đa được phép cho mỗi rule đang được tắt trong biome.json. Rule bị tắt thì không có CI nào canh; baseline này canh để số lỗi không tăng. Thêm lỗi mới thì sửa số ở đây, kèm lý do trong PR.",
      ...current,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`Đã ghi ${BASELINE_PATH}: ${JSON.stringify(current)}`);
    process.exit(0);
  }

  const rows = compare(baseline, current);
  const failed = rows.filter((r) => !r.ok);
  for (const row of rows) {
    console.log(
      `${row.ok ? "ok  " : "LỖI"} ${row.rule}: ${row.actual} lỗi (cho phép tối đa ${row.allowed})`,
    );
  }
  if (failed.length > 0) {
    const details = failed
      .map((r) => `${r.rule} (+${r.actual - r.allowed} lỗi: ${r.actual}/${r.allowed})`)
      .join(", ");
    console.error(
      `\nLỖI: Số lỗi của rule đang tắt đã vượt baseline: ${details}.\nSửa code (bỏ any, bỏ khoá non-null) thay vì nới baseline. Nới baseline chỉ khi có lý do, ghi lý do trong PR.`,
    );
    process.exit(1);
  }
  console.log("\nSố lỗi của các rule đang tắt không tăng.");
}
