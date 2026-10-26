#!/usr/bin/env bun
/**
 * Quét log phiên (transcript) của Claude Code / Orca để tìm secret bị lộ.
 *
 * Transcript của một phiên có thể chứa khoá API, token bot, khóa SSH: đọc log để
 * tìm việc đã làm là rất dễ in secret ra màn hình, rồi đưa vào transcript của
 * phiên khác. Script này dò trước.
 *
 * Dùng: bun run scripts/scan-transcript.ts <file-or-dir> [...]
 * Chỉ in TÊN mẫu và số dòng, KHÔNG in giá trị tìm thấy.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Pattern = { id: string; re: RegExp };

const PATTERNS: Pattern[] = [
  { id: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: "telegram-bot-token", re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  { id: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    id: "api-key-json",
    re: /"(?:api[_-]?key|apiKey|secret|token|password)"\s*:\s*"[^"\\\s]{12,}"/gi,
  },
  { id: "bearer-header", re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
  { id: "itsaplan-key", re: /\b(?:ITS|ITP)[A-Z0-9_]{4,}\.[A-Za-z0-9_-]{20,}\b/g },
];

/** Thư mục hay tên file hay bỏ qua (không phải log). */
function collect(target: string): string[] {
  if (!existsSync(target)) return [];
  const st = statSync(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  for (const entry of readdirSync(target)) {
    if (entry === "node_modules" || entry === ".git") continue;
    out.push(...collect(join(target, entry)));
  }
  return out;
}

/** Thay mọi mẫu khớp bằng `<redacted:loại>`, để log có thể đưa cho worker hay lưu vào repo. */
export function redactText(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, `<redacted:${p.id}>`);
  }
  return out;
}

export function scanText(text: string): { line: number; id: string }[] {
  const hits: { line: number; id: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(lines[i] ?? "")) hits.push({ line: i + 1, id: p.id });
    }
  }
  return hits;
}

if (import.meta.main) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("Dùng: bun run scripts/scan-transcript.ts <file-or-dir> [...]");
    process.exit(2);
  }
  const redact = process.argv.includes("--redact");
  let total = 0;
  for (const target of targets) {
    for (const file of collect(target)) {
      if (file.endsWith(".png") || file.endsWith(".jpg")) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (redact) {
        const cleaned = redactText(text);
        if (cleaned !== text) {
          writeFileSync(file, cleaned);
          total++;
          console.log(`${file}: đã lọc secret`);
        }
        continue;
      }
      for (const hit of scanText(text)) {
        total++;
        console.log(`${file}:${hit.line}: [${hit.id}] <redacted>`);
      }
    }
  }
  if (redact) {
    console.log(total > 0 ? `\n✓ đã lọc ${total} file` : "✓ không có gì để lọc");
    process.exit(0);
  }
  if (total > 0) {
    console.error(`\n✗ ${total} dấu hiệu secret trong transcript. Lọc trước khi đưa cho worker.`);
    process.exit(1);
  }
  console.log("✓ transcript không có dấu hiệu secret");
}
