#!/usr/bin/env bun
/**
 * "Docs required": PR đổi hành vi công khai mà không đụng docs thì fail.
 *
 * Chạy trong CI trên sự kiện pull_request: đọc base ref và nhãn từ payload GitHub
 * ($GITHUB_EVENT_PATH), so với `git diff origin/<base>...HEAD`. Không phải PR thì bỏ qua.
 * Chạy tay: bun run scripts/check-docs-touched.ts --base main [--label no-docs]
 *
 * "Hành vi công khai" là:
 *   - packages/<x>/src/**       (trừ test, fixture)
 *   - apps/<x>/{mcp,worker,lib,skills,openclaw,openclaw-plugin}/**  (trừ test, script chạy tay)
 *   - deploy/**
 * "Đã cập nhật docs" là có file đổi trong docs/**, hoặc CHANGELOG.md của package/app.
 * Nhãn `no-docs` bỏ qua kiểm tra: chỉ cho refactor thuần và test (xem CONTRIBUTING.md).
 */
import { existsSync, readFileSync } from "node:fs";

export const ESCAPE_LABEL = "no-docs";

const NOT_BEHAVIOUR =
  /(\.test\.[cm]?[jt]sx?$|\.fixture\.[jt]s$|\.fixture\.json$|(^|\/)test-[^/]*$|\/__tests__\/|(^|\/)README\.md$)/;

export function isBehaviourFile(path: string): boolean {
  if (NOT_BEHAVIOUR.test(path)) return false;
  if (/^packages\/[^/]+\/src\//.test(path)) return true;
  if (/^apps\/[^/]+\/(?:mcp|worker|lib|skills|openclaw|openclaw-plugin)\//.test(path)) {
    return !/\/(?:scripts|e2e)\//.test(path);
  }
  return path.startsWith("deploy/");
}

export function isDocsFile(path: string): boolean {
  return /^docs\//.test(path) || /^(?:packages|apps)\/[^/]+\/CHANGELOG\.md$/.test(path);
}

export interface Verdict {
  ok: boolean;
  behaviour: string[];
  reason: "no-behaviour-change" | "docs-touched" | "label" | "missing-docs";
}

export function judge(changed: string[], labels: string[]): Verdict {
  const behaviour = changed.filter(isBehaviourFile);
  if (behaviour.length === 0) return { ok: true, behaviour, reason: "no-behaviour-change" };
  if (changed.some(isDocsFile)) return { ok: true, behaviour, reason: "docs-touched" };
  if (labels.includes(ESCAPE_LABEL)) return { ok: true, behaviour, reason: "label" };
  return { ok: false, behaviour, reason: "missing-docs" };
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  let base = arg("--base");
  let labels = process.argv.flatMap((a, i) => (a === "--label" ? [process.argv[i + 1]] : []));

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!base && eventPath && existsSync(eventPath)) {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const pr = event.pull_request;
    if (pr) {
      base = pr.base?.ref;
      labels = (pr.labels ?? []).map((l: { name: string }) => l.name);
    }
  }
  if (!base) {
    console.log("Không phải pull request (không có base ref): bỏ qua kiểm tra docs-required.");
    return 0;
  }

  const ref = base.startsWith("origin/") ? base : `origin/${base}`;
  const diff = Bun.spawnSync(["git", "diff", "--name-only", `${ref}...HEAD`]);
  if (diff.exitCode !== 0) {
    console.error(diff.stderr.toString());
    console.error(`Không diff được với ${ref}. Job cần checkout với fetch-depth: 0.`);
    return 2;
  }
  const changed = diff.stdout.toString().split("\n").filter(Boolean);
  const v = judge(changed, labels);

  if (v.ok) {
    const why = {
      "no-behaviour-change": "PR không đổi file hành vi công khai",
      "docs-touched": "PR có cập nhật docs hoặc CHANGELOG",
      label: `PR có nhãn \`${ESCAPE_LABEL}\``,
      "missing-docs": "",
    }[v.reason];
    console.log(`✓ docs-required: ${why}.`);
    return 0;
  }

  console.error("✗ docs-required: PR đổi hành vi công khai nhưng không đụng docs.\n");
  console.error("File hành vi đã đổi:");
  for (const f of v.behaviour.slice(0, 15)) console.error(`  - ${f}`);
  if (v.behaviour.length > 15) console.error(`  … và ${v.behaviour.length - 15} file nữa`);
  console.error(`
Cách xử lý (chọn một):
  1. Cập nhật trang liên quan trong docs/ (Cách làm, Tra cứu hoặc Giải thích) trong cùng PR.
     Đổi API của packages/core thì ghi thêm vào packages/core/CHANGELOG.md.
  2. Nếu đây là refactor thuần hoặc chỉ sửa test (hành vi không đổi), nhờ maintainer gắn
     nhãn \`${ESCAPE_LABEL}\` cho PR rồi chạy lại job.

Docs sai còn tệ hơn không có docs, nên mọi thay đổi hành vi đều đi kèm cập nhật docs.`);
  return 1;
}

if (import.meta.main) process.exit(main());
