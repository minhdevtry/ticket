#!/usr/bin/env bun
/**
 * Chạy lặp các test từng đỏ ngẫu nhiên trong CI, in ra ca nào đỏ ở vòng nào.
 *
 * Vì sao: ba test trong issue #38 phụ thuộc wall clock nên chỉ đỏ khi máy bận. Đo
 * trước khi sửa và sau khi sửa bằng CÙNG một lệnh thì mới so sánh được — không
 * thì "chạy một lần thấy xanh" chỉ chứng minh là lần đó máy rảnh.
 *
 * Dùng:
 *   bun run test:flaky                 # 20 vòng, ba file trong issue #38
 *   bun run test:flaky -- --rounds 50  # đổi số vòng
 *   bun run test:flaky -- --file packages/core/src/llm/hardening.test.ts
 *   bun run test:flaky -- --list       # chỉ in danh sách file, không chạy
 *
 * Thoát mã khác 0 khi có ít nhất một ca đỏ (để CI hoặc người soi dùng được).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Các file từng đỏ ngẫu nhiên (issue #38). */
export const DEFAULT_FILES = [
  "packages/core/src/llm/hardening.test.ts",
  "packages/core/src/bot/create-durable.test.ts",
  "apps/tieulinh-legacy/mcp/shared/tools/own-tickets-confirm.test.ts",
] as const;

export interface Options {
  rounds: number;
  files: string[];
  list: boolean;
}

/** Đọc lệnh dòng, tách cờ `--rounds N`, `--file <đường dẫn>` (lặp lại được) và `--list`. */
export function parseArgs(argv: string[]): Options {
  const opts: Options = { rounds: 20, files: [...DEFAULT_FILES], list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rounds") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error(`--rounds cần số nguyên dương, nhận "${argv[i] ?? ""}"`);
      }
      opts.rounds = value;
    } else if (arg === "--file") {
      const value = argv[++i];
      if (!value) throw new Error("--file cần đường dẫn");
      opts.files.push(value);
    } else if (arg === "--list") {
      opts.list = true;
    } else {
      throw new Error(`Cờ lạ: ${arg}`);
    }
  }
  return opts;
}

/** Một ca đỏ: file nào, vòng nào, và dòng lỗi đầu tiên của output. */
export interface RedRun {
  file: string;
  round: number;
  detail: string;
}

/** Trích dòng đầu tiên trong output có dấu hiệu lỗi, để báo cáo gọn. */
export function firstErrorLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("(fail)") || l.includes("error:"));
  return line ?? "xem output đầy đủ";
}

/** Chạy một vòng: mỗi file một lần, gom ca đỏ. */
export function runRound(files: string[], round: number): RedRun[] {
  const reds: RedRun[] = [];
  for (const file of files) {
    const result = spawnSync("bun", ["test", file], {
      cwd: ROOT,
      encoding: "utf8",
      // Timeout mỗi file: test bị treo cũng phải báo đỏ, không treo cả lệnh.
      timeout: 120_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const failed = result.status !== 0 || /\(fail\)/.test(output);
    if (failed) {
      reds.push({ file, round, detail: firstErrorLine(output) });
    }
  }
  return reds;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  const missing = opts.files.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length > 0) {
    console.error(`Không tìm thấy file: ${missing.join(", ")}`);
    process.exit(2);
  }

  if (opts.list) {
    for (const f of opts.files) console.log(f);
    return;
  }

  console.log(`Chạy ${opts.rounds} vòng x ${opts.files.length} file:`);
  for (const f of opts.files) console.log(`  - ${f}`);
  console.log("");

  const reds: RedRun[] = [];
  for (let round = 1; round <= opts.rounds; round++) {
    const roundReds = runRound(opts.files, round);
    reds.push(...roundReds);
    const mark = roundReds.length > 0 ? `ĐỎ ${roundReds.length}` : "xanh";
    console.log(`vòng ${round}/${opts.rounds}: ${mark}`);
  }

  console.log("");
  if (reds.length === 0) {
    console.log(`✓ Không ca nào đỏ trong ${opts.rounds} vòng.`);
    return;
  }

  console.log(`✗ ${reds.length} ca đỏ:`);
  for (const red of reds) {
    console.log(`  ${red.file} — vòng ${red.round}: ${red.detail}`);
  }
  const byFile = new Map<string, number>();
  for (const red of reds) byFile.set(red.file, (byFile.get(red.file) ?? 0) + 1);
  console.log("");
  console.log("Theo file:");
  for (const [file, count] of byFile) {
    console.log(`  ${file}: đỏ ${count}/${opts.rounds} vòng`);
  }
  process.exit(1);
}

if (import.meta.main) main();
