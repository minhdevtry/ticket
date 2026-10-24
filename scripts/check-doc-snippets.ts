#!/usr/bin/env bun
/**
 * Typecheck các mẫu code TypeScript trong docs/ với workspace thật.
 *
 * Quy ước: mọi khối ```ts trong docs/ phải khai báo rõ đúng một trong ba cờ:
 *
 *   ```ts check      được trích ra và typecheck. Phải tự đứng được: import đầy đủ,
 *                    dùng `declare const x: T;` cho thứ mà ví dụ chỉ giả định có sẵn.
 *   ```ts run        typecheck rồi chạy bằng Bun; thoát khác 0 (vd `assert` sai) là lỗi.
 *                    Dùng khi mẫu minh hoạ một hành vi mà ta muốn khẳng định giá trị.
 *                    Không được gọi mạng hay dịch vụ thật.
 *   ```ts no-check   minh hoạ, không biên dịch được (giả mã, chỗ trống `…`). Dùng ít.
 *
 * Khối ts không có cờ là lỗi: im lặng không được phép, vì mẫu không ai kiểm sẽ cũ đi.
 * `@vuihoc/bot-core/<subpath>` được ánh xạ từ `exports` của packages/core/package.json,
 * nên đổi tên subpath làm hỏng mẫu ngay.
 *
 * Usage: bun run scripts/check-doc-snippets.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, extractFences, listDocPages, ROOT } from "./lib/docs";

const TS_LANGS = new Set(["ts", "typescript", "tsx", "mts"]);
const FLAGS = new Set(["check", "run", "no-check"]);
const OUT = join(DOCS, ".snippets");

function pathsFromExports(): Record<string, string[]> {
  const pkgDir = join(ROOT, "packages/core");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const paths: Record<string, string[]> = {};
  for (const [sub, target] of Object.entries(pkg.exports as Record<string, string>)) {
    const name = sub.replace(/^\.\//, "");
    paths[`@vuihoc/bot-core/${name}`] = [join(pkgDir, target)];
  }
  return paths;
}

interface Snippet {
  id: string;
  file: string;
  line: number;
  run: boolean;
}

function main(): number {
  const problems: string[] = [];
  const snippets: Snippet[] = [];
  let noCheck = 0;

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  let n = 0;
  for (const page of listDocPages()) {
    for (const f of extractFences(page)) {
      if (!TS_LANGS.has(f.lang)) continue;
      const flags = f.flags.filter((x) => FLAGS.has(x));
      const unknown = f.flags.filter((x) => !FLAGS.has(x) && !/^[{[]/.test(x));
      if (flags.length !== 1 || unknown.length > 0) {
        problems.push(
          `${f.file}:${f.line}: khối \`${f.lang}\` cần đúng một cờ \`check\`, \`run\` hoặc \`no-check\`` +
            (unknown.length ? ` (cờ lạ: ${unknown.join(", ")})` : ""),
        );
        continue;
      }
      if (flags[0] === "no-check") {
        noCheck++;
        continue;
      }
      n++;
      const id = `s${String(n).padStart(3, "0")}`;
      // Giữ nguyên số dòng: dòng 1 của file tạm = dòng đầu sau fence.
      writeFileSync(join(OUT, `${id}.ts`), `${f.code}\nexport {};\n`);
      snippets.push({ id, file: f.file, line: f.line, run: flags[0] === "run" });
    }
  }

  if (snippets.length > 0) {
    writeFileSync(
      join(OUT, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "../../tsconfig.base.json",
          compilerOptions: { paths: pathsFromExports(), noEmit: true },
          include: ["*.ts"],
        },
        null,
        2,
      ),
    );
    const tsc = join(ROOT, "node_modules/.bin/tsc");
    const res = Bun.spawnSync([tsc, "-p", join(OUT, "tsconfig.json"), "--pretty", "false"], {
      cwd: ROOT,
    });
    const output = res.stdout.toString() + res.stderr.toString();
    if (res.exitCode !== 0) {
      const byId = new Map(snippets.map((s) => [s.id, s]));
      for (const raw of output.split("\n")) {
        const m = /(s\d{3})\.ts\((\d+),(\d+)\): (.*)$/.exec(raw);
        if (m) {
          const s = byId.get(m[1]);
          problems.push(`${s?.file}:${(s?.line ?? 0) + Number(m[2])}: ${m[4]}`);
        } else if (raw.trim()) {
          problems.push(raw.trim());
        }
      }
    }
  }

  // Chỉ chạy khi typecheck đã sạch: lỗi kiểu thì báo lỗi kiểu, đừng chồng thêm lỗi chạy.
  if (problems.length === 0) {
    for (const s of snippets.filter((x) => x.run)) {
      const res = Bun.spawnSync(["bun", join(OUT, `${s.id}.ts`)], {
        cwd: ROOT,
        timeout: 30_000,
      });
      if (res.exitCode !== 0) {
        const out = (res.stderr.toString() + res.stdout.toString()).trim().split("\n");
        problems.push(`${s.file}:${s.line}: mẫu \`ts run\` thoát với mã ${res.exitCode}`);
        for (const line of out.slice(0, 12)) problems.push(`    ${line}`);
      }
    }
  }

  rmSync(OUT, { recursive: true, force: true });

  const runCount = snippets.filter((s) => s.run).length;
  console.log(
    `Mẫu code: ${snippets.length - runCount} \`ts check\`, ${runCount} \`ts run\`, ${noCheck} \`ts no-check\`.`,
  );
  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} lỗi trong mẫu code của docs:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "\nSửa mẫu cho khớp API hiện tại (đừng đổi sang no-check chỉ để qua mặt CI). " +
        "Xem CONTRIBUTING.md, mục Tài liệu.",
    );
    return 1;
  }
  return 0;
}

process.exit(main());
