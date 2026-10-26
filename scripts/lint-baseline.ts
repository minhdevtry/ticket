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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASELINE_PATH = "biome.lint-baseline.json";
const RULES = ["suspicious/noExplicitAny", "style/noNonNullAssertion"] as const;

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

if (import.meta.main) {
  const write = process.argv.includes("--write");
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
    console.error(
      "\nSố lỗi của rule đang tắt đã TĂNG. Sửa code (bỏ any, bỏ khoá non-null) thay vì nới baseline. Nới baseline chỉ khi có lý do, ghi lý do trong PR.",
    );
    process.exit(1);
  }
  console.log("\nSố lỗi của các rule đang tắt không tăng.");
}
