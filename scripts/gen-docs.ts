#!/usr/bin/env bun
/**
 * Sinh các trang tài liệu phải đi theo code. Không commit kết quả (xem .gitignore):
 *
 *   docs/reference/api/        TypeDoc, từ các subpath của packages/core
 *   docs/reference/copy-keys.md  danh sách CopyKey, đọc từ packages/core/src/intake/ports.ts
 *   docs/explanation/adr-index.md  chỉ mục mọi ADR trong repo
 *
 * Cố ý fail to khi nguồn đổi hình dạng (không tìm thấy CopyKey, TypeDoc có cảnh báo):
 * một trang tra cứu sinh sai im lặng tệ hơn không có trang.
 *
 * Usage: bun run scripts/gen-docs.ts [--skip-api]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO_BLOB = "https://github.com/minhdevtry/ticket/blob/main";

const BANNER =
  "<!-- Trang này được sinh tự động bởi scripts/gen-docs.ts. Không sửa tay, không commit. -->\n";

// ── CopyKey ──────────────────────────────────────────────────────────────────

export interface CopyKeyEntry {
  group: string;
  key: string;
  note: string;
}

/** Đọc union `CopyKey`: mỗi dòng `| "key" // ghi chú`, dòng `// ── nhóm ──` mở nhóm mới. */
export function parseCopyKeys(source: string): CopyKeyEntry[] {
  const start = source.indexOf("export type CopyKey =");
  if (start < 0) throw new Error("Không tìm thấy `export type CopyKey =` trong ports.ts");
  const entries: CopyKeyEntry[] = [];
  let group = "Chung";
  for (const raw of source.slice(start).split("\n").slice(1)) {
    const line = raw.trim();
    const groupMatch = /^\/\/\s*[─-]+\s*(.+?)\s*[─-]*$/.exec(line);
    if (groupMatch) {
      group = groupMatch[1];
      continue;
    }
    const m = /^\|\s*"([^"]+)"\s*(;)?\s*(?:\/\/\s*(.*))?$/.exec(line);
    if (!m) break;
    entries.push({ group, key: m[1], note: m[3]?.trim() ?? "" });
    if (m[2]) break;
  }
  if (entries.length === 0) throw new Error("CopyKey không có phần tử nào: parser đã lỗi thời?");
  return entries;
}

function esc(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/\{/g, "\\{");
}

function renderCopyKeys(entries: CopyKeyEntry[]): string {
  const out = [BANNER, "# Danh sách CopyKey\n"];
  out.push(
    "`CopyKey` là union đóng các khoá chuỗi hiển thị mà engine tiếp nhận phát ra. Mọi câu chữ",
    "tiếng Việt nằm trong `CopyCatalog` do bot cung cấp, không nằm trong logic của thư viện.",
    "Khoá lạ thì `CopyCatalog.text` ném lỗi, nên thiếu một chuỗi là lỗi chứ không phải chuỗi rỗng.\n",
    `Nguồn: [\`packages/core/src/intake/ports.ts\`](${REPO_BLOB}/packages/core/src/intake/ports.ts). ` +
      `Hiện có **${entries.length}** khoá.\n`,
  );
  let current = "";
  for (const e of entries) {
    if (e.group !== current) {
      current = e.group;
      out.push(`\n## ${current}\n`, "| Khoá | Ý nghĩa và biến |", "|---|---|");
    }
    out.push(`| \`${e.key}\` | ${esc(e.note)} |`);
  }
  return `${out.join("\n")}\n`;
}

// ── ADR index ────────────────────────────────────────────────────────────────

interface AdrRow {
  scope: string;
  file: string;
  title: string;
  superseded: boolean;
  href: string;
}

function adrDirs(): { scope: string; dir: string; inSite: boolean }[] {
  const dirs = [{ scope: "Cấp repo", dir: "docs/adr", inSite: true }];
  for (const group of ["packages", "apps"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = `${group}/${name}/docs/adr`;
      if (existsSync(join(ROOT, dir))) dirs.push({ scope: `${group}/${name}`, dir, inSite: false });
    }
  }
  return dirs;
}

function adrRows(): AdrRow[] {
  const rows: AdrRow[] = [];
  for (const { scope, dir, inSite } of adrDirs()) {
    for (const file of readdirSync(join(ROOT, dir)).sort()) {
      if (!file.endsWith(".md")) continue;
      const lines = readFileSync(join(ROOT, dir, file), "utf8").split("\n");
      const h1 = lines.find((l) => l.startsWith("# ")) ?? `# ${file}`;
      const title = h1
        .replace(/^#\s+/, "")
        .replace(/^ADR[\s-]*\d+\s*[:—–-]*\s*/i, "")
        .trim();
      const head = lines.slice(0, 8).join("\n");
      const superseded = /superseded|bị thay thế/i.test(head);
      const href = inSite ? `/adr/${file.replace(/\.md$/, "")}` : `${REPO_BLOB}/${dir}/${file}`;
      rows.push({ scope, file, title, superseded, href });
    }
  }
  return rows;
}

function renderAdrIndex(rows: AdrRow[]): string {
  const out = [BANNER, "# Chỉ mục ADR\n"];
  out.push(
    "ADR (Architecture Decision Record) ghi lại quyết định kiến trúc kèm lý do. ADR cấp repo nằm",
    "trong site này. ADR của từng package hoặc app nằm cạnh code của nó; bảng dưới liên kết sang GitHub.",
    "Chỉ mục này được sinh từ các file ADR nên không thể lệch.\n",
  );
  let current = "";
  for (const r of rows) {
    if (r.scope !== current) {
      current = r.scope;
      out.push(`\n## ${current}\n`, "| ADR | Tiêu đề | Ghi chú |", "|---|---|---|");
    }
    const id = r.file.replace(/\.md$/, "").split("-")[0];
    out.push(`| [${id}](${r.href}) | ${esc(r.title)} | ${r.superseded ? "đã bị thay thế" : ""} |`);
  }
  return `${out.join("\n")}\n`;
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const skipApi = process.argv.includes("--skip-api");
  mkdirSync(join(ROOT, "docs/reference"), { recursive: true });
  mkdirSync(join(ROOT, "docs/explanation"), { recursive: true });

  const ports = readFileSync(join(ROOT, "packages/core/src/intake/ports.ts"), "utf8");
  const keys = parseCopyKeys(ports);
  writeFileSync(join(ROOT, "docs/reference/copy-keys.md"), renderCopyKeys(keys));
  console.log(`copy-keys: ${keys.length} khoá`);

  const rows = adrRows();
  writeFileSync(join(ROOT, "docs/explanation/adr-index.md"), renderAdrIndex(rows));
  console.log(`adr-index: ${rows.length} ADR`);

  if (!skipApi) {
    // TypeDoc cần TypeScript 5.x của workspace docs (TypeScript 7 chưa được hỗ trợ).
    const res = Bun.spawnSync(["bun", "run", "--cwd", "docs", "api"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (res.exitCode !== 0) {
      console.error(
        `\nTypeDoc lỗi (cảnh báo bị coi là lỗi). Xem ${relative(ROOT, join(ROOT, "docs/typedoc.json"))}.`,
      );
      process.exit(res.exitCode ?? 1);
    }
  }
}

if (import.meta.main) main();
