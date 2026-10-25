#!/usr/bin/env bun
/**
 * Đối chiếu docs với code ở những chỗ máy kiểm được. Mỗi luật dưới đây tồn tại vì một
 * kiểu docs hay cũ đi nhất:
 *
 *  1. Đường dẫn: mọi `packages/…`, `apps/…`, `scripts/…`, `deploy/…`, `.github/…` trong
 *     inline code (và link blob GitHub) phải tồn tại.
 *  2. Subpath: mọi `@vuihoc/bot-core/<x>` trong docs phải là một export thật, và mọi export
 *     thật phải có mặt trong docs/reference/entry-points.md.
 *  3. Biến môi trường: mọi biến Tiểu Linh đọc trong code phải có dòng trong
 *     docs/reference/config-env.md, và mọi biến ở đó phải còn được code đọc.
 *  4. Sự kiện webhook: bảng trong docs/reference/webhook-events.md khớp union
 *     `ItsaplanWebhookEventName` trong code.
 *  5. Mồ côi: mọi trang docs viết tay phải có trong sidebar (.vitepress/config.ts).
 *
 * Usage: bun run scripts/check-docs-refs.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCS, listDocPages, ROOT, stripFences } from "./lib/docs";

const problems: string[] = [];
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const rel = (abs: string) => relative(ROOT, abs);

const pages = listDocPages().map((file) => ({ file: rel(file), text: readFileSync(file, "utf8") }));

// ── 1. đường dẫn ────────────────────────────────────────────────────────────

/** Trang sinh khi build, không có trong git. */
const GENERATED = [
  "docs/reference/api",
  "docs/reference/copy-keys.md",
  "docs/explanation/adr-index.md",
];

function checkPaths() {
  const spanRe = /`((?:packages|apps|scripts|deploy|docs|\.github)\/[^`\s]*)`/g;
  const blobRe = /https:\/\/github\.com\/minhdevtry\/ticket\/(?:blob|tree)\/main\/([^)\s#"'`>]+)/g;
  for (const { file, text } of pages) {
    const candidates: string[] = [];
    for (const m of stripFences(text).matchAll(spanRe)) candidates.push(m[1]);
    for (const m of text.matchAll(blobRe)) candidates.push(m[1]);
    for (const raw of candidates) {
      if (/[*<>{}…]|\.\.\./.test(raw)) continue;
      const path = raw
        .replace(/[#?].*$/, "")
        .replace(/:\d+(?:-\d+)?$/, "")
        .replace(/\/+$/, "");
      if (/(?:^|\/)\.env(?:\.[a-z]+)?$/.test(path) && !path.endsWith(".example")) continue;
      if (GENERATED.some((g) => path === g || path.startsWith(`${g}/`))) continue;
      if (!existsSync(join(ROOT, path))) {
        problems.push(`${file}: đường dẫn không tồn tại: ${raw}`);
      }
    }
  }
}

// ── 2. subpath ──────────────────────────────────────────────────────────────

function checkSubpaths() {
  const pkg = JSON.parse(read("packages/core/package.json"));
  const subpaths = Object.keys(pkg.exports as Record<string, string>)
    .map((k) => k.replace(/^\.\//, ""))
    .filter((k) => !k.endsWith("/*"));
  const valid = new Set([...subpaths, "prose"]);

  for (const { file, text } of pages) {
    for (const m of text.matchAll(/@vuihoc\/bot-core\/([a-z][a-z0-9-]*)/g)) {
      if (!valid.has(m[1])) {
        problems.push(
          `${file}: subpath không có trong exports của packages/core: @vuihoc/bot-core/${m[1]}`,
        );
      }
    }
  }

  // Mọi subpath phải có entry point TypeDoc, không thì trang API thiếu một tầng.
  const typedoc = JSON.parse(read("docs/typedoc.json")) as { entryPoints: string[] };
  for (const sub of subpaths) {
    const expected = `../packages/core/${pkg.exports[`./${sub}`].replace(/^\.\//, "")}`;
    if (!typedoc.entryPoints.includes(expected)) {
      problems.push(
        `docs/typedoc.json: thiếu entry point cho @vuihoc/bot-core/${sub} (${expected})`,
      );
    }
  }

  const entry = pages.find((p) => p.file === "docs/reference/entry-points.md");
  if (!entry) {
    problems.push("thiếu docs/reference/entry-points.md");
    return;
  }
  for (const sub of subpaths) {
    if (!entry.text.includes(`@vuihoc/bot-core/${sub}`)) {
      problems.push(`${entry.file}: export mới chưa được mô tả: @vuihoc/bot-core/${sub}`);
    }
  }
}

// ── 3. biến môi trường ──────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "data") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** Code chạy thật của Tiểu Linh: bỏ test, script chạy tay, harness, fixture. */
function isRuntimeFile(path: string): boolean {
  return !/(\.test\.|\/scripts\/|\/e2e\/|test-preload|test-support|\/harness|test-tieulinh|backfill-onyx|\.d\.ts$)/.test(
    path,
  );
}

function envNamesIn(text: string): string[] {
  const names = new Set<string>();
  const res = [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g,
    /\brequired\(["']([A-Z][A-Z0-9_]+)["']\)/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) names.add(m[1]);
  names.delete("NODE_ENV");
  return [...names];
}

/**
 * File khai biến môi trường bằng `defineEnv` mà trang config-env phải mô tả: bộ LLM của bot-core
 * và env riêng của Tiểu Linh mới (`apps/tieulinh/env.ts`).
 */
const KIT_ENV_FILES = ["packages/core/src/llm/env.ts", "apps/tieulinh/env.ts"];

function checkEnv() {
  const doc = pages.find((p) => p.file === "docs/reference/config-env.md");
  if (!doc) {
    problems.push("thiếu docs/reference/config-env.md");
    return;
  }
  const documented = new Set<string>();
  for (const line of doc.text.split("\n")) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]+)`/.exec(line);
    if (m) documented.add(m[1]);
  }

  const inCode = new Map<string, string>();
  for (const f of sourceFiles(join(ROOT, "apps/tieulinh-legacy")).filter(isRuntimeFile)) {
    for (const name of envNamesIn(readFileSync(f, "utf8")))
      if (!inCode.has(name)) inCode.set(name, rel(f));
  }
  // Biến của bot kit khai bằng `defineEnv({ NAME: ... })` (không đọc qua `env.NAME`).
  for (const f of KIT_ENV_FILES) {
    for (const m of read(f).matchAll(/^\s+([A-Z][A-Z0-9_]+): /gm)) {
      if (!inCode.has(m[1])) inCode.set(m[1], f);
    }
  }
  const example = read("apps/tieulinh-legacy/openclaw/.env.example");
  const inExample = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

  for (const [name, where] of inCode) {
    if (!documented.has(name)) {
      problems.push(`${doc.file}: biến chưa được mô tả: ${name} (đọc ở ${where})`);
    }
  }
  for (const name of inExample) {
    if (!documented.has(name)) {
      problems.push(`${doc.file}: biến có trong .env.example nhưng chưa được mô tả: ${name}`);
    }
  }
  for (const name of documented) {
    if (!inCode.has(name) && !inExample.has(name)) {
      problems.push(`${doc.file}: biến đã không còn trong code: ${name}`);
    }
  }
}

// ── 4. sự kiện webhook ──────────────────────────────────────────────────────

function checkWebhookEvents() {
  const src = read("packages/core/src/itsaplan/webhook/events.ts");
  const block = /export type ItsaplanWebhookEventName =([\s\S]*?);/.exec(src);
  if (!block) {
    problems.push(
      "không đọc được ItsaplanWebhookEventName trong events.ts: sửa scripts/check-docs-refs.ts",
    );
    return;
  }
  const inCode = new Set([...block[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]));
  const doc = pages.find((p) => p.file === "docs/reference/webhook-events.md");
  if (!doc) {
    problems.push("thiếu docs/reference/webhook-events.md");
    return;
  }
  const documented = new Set<string>();
  for (const line of doc.text.split("\n")) {
    const m = /^\|\s*`([a-z_]+\.[a-z_]+)`/.exec(line);
    if (m) documented.add(m[1]);
  }
  for (const e of inCode) {
    if (!documented.has(e)) problems.push(`${doc.file}: sự kiện chưa được mô tả: ${e}`);
  }
  for (const e of documented) {
    if (!inCode.has(e)) problems.push(`${doc.file}: sự kiện không còn trong code: ${e}`);
  }

  // Cột "Tự đăng ký" phải đúng bằng REQUIRED_WEBHOOK_EVENTS của ensure-webhook.ts.
  const ensure = read("packages/core/src/itsaplan/ensure-webhook.ts");
  const req = /export const REQUIRED_WEBHOOK_EVENTS = \[([\s\S]*?)\];/.exec(ensure);
  if (!req) {
    problems.push(
      "không đọc được REQUIRED_WEBHOOK_EVENTS trong ensure-webhook.ts: sửa scripts/check-docs-refs.ts",
    );
    return;
  }
  const required = new Set([...req[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]));
  const marked = new Set<string>();
  for (const line of doc.text.split("\n")) {
    const m = /^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|[^|]*\|\s*(có|không)\s*\|/.exec(line);
    if (m?.[2] === "có") marked.add(m[1]);
  }
  for (const e of required) {
    if (!marked.has(e))
      problems.push(
        `${doc.file}: ${e} là sự kiện tự đăng ký nhưng cột "Tự đăng ký" không ghi "có"`,
      );
  }
  for (const e of marked) {
    if (!required.has(e))
      problems.push(
        `${doc.file}: ${e} ghi "có" ở cột "Tự đăng ký" nhưng không nằm trong REQUIRED_WEBHOOK_EVENTS`,
      );
  }
}

// ── 5. trang mồ côi ─────────────────────────────────────────────────────────

function checkOrphans() {
  const config = readFileSync(join(DOCS, ".vitepress/config.ts"), "utf8");
  for (const { file } of pages) {
    const p = file.replace(/^docs\//, "").replace(/\.md$/, "");
    if (p === "index" || p.startsWith("adr/")) continue;
    const link = p.endsWith("/index") ? `/${p.slice(0, -"index".length)}` : `/${p}`;
    if (!config.includes(`link: "${link}"`)) {
      problems.push(
        `${file}: chưa có trong sidebar/nav của docs/.vitepress/config.ts (link ${link})`,
      );
    }
  }
}

checkPaths();
checkSubpaths();
checkEnv();
checkWebhookEvents();
checkOrphans();

if (problems.length > 0) {
  console.error(`✗ ${problems.length} chỗ docs lệch khỏi code:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nSửa docs (hoặc code) cho khớp. Xem CONTRIBUTING.md, mục Tài liệu.");
  process.exit(1);
}
console.log(
  `Docs khớp code: ${pages.length} trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.`,
);
