#!/usr/bin/env bun
/**
 * Public-repo hygiene scanner. This repository is public: it must never contain
 * internal network details, real chat IDs, phone numbers or personal paths.
 * Secrets (tokens, keys) are covered separately by gitleaks in CI.
 *
 * Usage: bun run scripts/scan-public.ts [--staged]
 *
 * An optional, git-ignored `.scan-denylist` (one literal per line) lets a
 * maintainer add real names/handles locally without publishing them.
 */
import { existsSync, readFileSync } from "node:fs";

type Rule = { id: string; re: RegExp; allow?: RegExp };

const RULES: Rule[] = [
  {
    id: "private-ipv4",
    re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
    // 10.0.0.0/24 is used as an obviously generic placeholder in tests.
    allow: /^10\.0\.0\.\d{1,3}$/,
  },
  { id: "internal-host", re: /\b[a-z0-9-]+\.vuihoc\.(?:vn|org)\b/gi },
  { id: "company-email", re: /\b[\w.+-]+@vuihoc\.(?:vn|org)\b/gi },
  { id: "provider-host", re: /\b2tocom\b/gi },
  {
    id: "telegram-chat-id",
    re: /-100\d{9,}/g,
    // Synthetic group IDs reserved for fixtures: -1000000000000–-1000000000999.
    allow: /^-1000000000\d{3}$/,
  },
  {
    id: "vn-phone",
    re: /(?<![\d\w])(?:\+84|84|0)(?:3|5|7|8|9)\d{8}(?!\d)/g,
    // Synthetic numbers reserved for fixtures: 0900000000–0900000999.
    allow: /^(?:\+84|84|0)900000\d{3}$/,
  },
  { id: "home-path", re: /\/home\/(?!user\b|runner\b|bot\b)[a-z][a-z0-9_-]*\//g },
];

const denylist = existsSync(".scan-denylist")
  ? readFileSync(".scan-denylist", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  : [];

const SKIP = /(?:^|\/)(?:bun\.lock|scan-public\.ts)$|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz)$/;

function listFiles(staged: boolean): string[] {
  const args = staged
    ? ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["git", "ls-files", "-co", "--exclude-standard"];
  const out = Bun.spawnSync(args).stdout.toString();
  return out.split("\n").filter((f) => f && !SKIP.test(f) && existsSync(f));
}

const staged = process.argv.includes("--staged");
let hits = 0;
for (const file of listFiles(staged)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.allow?.test(m[0])) continue;
        hits++;
        console.log(`${file}:${i + 1}: [${rule.id}] ${m[0]}`);
      }
    }
    for (const term of denylist) {
      if (line.includes(term)) {
        hits++;
        console.log(`${file}:${i + 1}: [denylist] <redacted>`);
      }
    }
  });
}

if (hits > 0) {
  console.error(`\n✗ ${hits} public-hygiene finding(s). Replace them with synthetic values.`);
  process.exit(1);
}
console.log("✓ public-hygiene scan clean");
