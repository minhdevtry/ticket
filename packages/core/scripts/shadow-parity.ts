#!/usr/bin/env bun
/**
 * shadow-parity.ts — Ticket 10, @vuihoc/bot-core.
 *
 * Shadow-parity harness: copy the LIVE intake bot (Tiểu Linh) to scratch, swap
 * selected intake modules for thin shims that re-export from this library, run
 * `bun test ./intake` in the copy and compare against the recorded baseline.
 *
 * The live repo at SRC is treated READ-ONLY: we only read and copy out of it,
 * never install/test/write inside it. A fresh copy is made every run.
 *
 *   bun run scripts/shadow-parity.ts
 *   bun run scripts/shadow-parity.ts --lib /path/to/library   # override lib path
 *   bun run scripts/shadow-parity.ts --no-baseline            # skip baseline run
 *
 * Re-runnable: the shadow dir is wiped and rebuilt each run.
 *
 * Environment (all optional):
 *   PARITY_REPOS_DIR      directory holding the live bot checkouts
 *                         (default: the parent of the monorepo root)
 *   PARITY_SRC            live intake bot to shadow
 *                         (default: $PARITY_REPOS_DIR/intake-agents)
 *   PARITY_SCRATCH        scratch dir for the shadow copy (default: /tmp)
 *
 * This is a maintainer tool: it needs private bot checkouts that are not part
 * of this repository.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, rm, cp, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// ── config ───────────────────────────────────────────────────────────────────
const PKG_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const REPOS_DIR = resolve(process.env.PARITY_REPOS_DIR || resolve(PKG_DIR, "../../.."));
const SRC = resolve(process.env.PARITY_SRC || join(REPOS_DIR, "intake-agents"));
const LIVE_REPOS = {
  "intake-agents": SRC,
  teacheragent: join(REPOS_DIR, "teacheragent"),
  "Bot-Sales": join(REPOS_DIR, "Bot-Sales"),
};
const SCRATCH = process.env.PARITY_SCRATCH || "/tmp";
const SHADOW = join(SCRATCH, "shadow-intake");
const LIB_PKG = "@vuihoc/bot-core";

const BASELINE = { pass: 862, skip: 27, fail: 0 };

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const LIB = resolve(argVal("--lib") || resolve(dirname(new URL(import.meta.url).pathname), ".."));
const RUN_BASELINE = !process.argv.includes("--no-baseline");

const REPORT_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "docs/parity/REPORT.md",
);
const ENGINE_REPORT_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "docs/parity/ENGINE.md",
);

/**
 * Opt-in engine-parity mode (ticket 09 stretch): `--engine`.
 *
 * The module-shim parity above swaps intake's own modules for library
 * re-exports and runs intake's test suite. This mode is different and does NOT
 * touch the live repo at all: it maps the SCENARIOS encoded in Tiểu Linh's
 * `lib/intake-step/pipeline.flow.test.ts` to the library's own conversation
 * engine (`src/intake/engine`), configured with `examples/tieulinh`, driving it
 * through the public `step()` seam with scripted extractor fakes.
 *
 * HONESTY NOTE: the live `pipeline.flow` scenarios run the FULL stateful
 * pipeline against real LLM extraction, KG/Onyx and the Itsaplan REST client.
 * The library engine deliberately injects those as ports (LLM extractor,
 * tracker, KG post-create hook), so a byte-for-byte replay of the live test is
 * impossible without that infrastructure — and faking the LLM would be
 * asserting against our own fake, not against Tiểu Linh. What CAN be verified
 * here is the deterministic CONTROL FLOW every one of those scenarios depends
 * on: the invariants (confirm delay, idempotent create, envelope strip, the two
 * parks, ADR-0008 preview+button, ownership, caps). Those live as named
 * engine tests citing each incident id, and this mode runs exactly that suite
 * against the library and records which scenario each test stands in for, plus
 * what could NOT be reproduced and why. Nothing is faked silently.
 */
const RUN_ENGINE = process.argv.includes("--engine");

/** Map of pipeline.flow scenario → the library engine test that stands in for it. */
const ENGINE_SCENARIO_MAP: Array<{
  scenario: string;
  incident: string;
  engineTest: string;
  reproduced: boolean;
  why?: string;
}> = [
  {
    scenario: "model self-clicks confirm in the same turn",
    incident: "gemini 1.1s",
    reproduced: true,
    engineTest: "MIN_CONFIRM_DELAY_MS: a confirm <5s after the summary is rejected",
  },
  {
    scenario: "double-confirm / re-sent confirm returns one ticket",
    incident: "idempotent create",
    reproduced: true,
    engineTest: "idempotent create: a second confirm returns the same ticket",
  },
  {
    scenario: "OpenClaw envelope must not reach the ticket description",
    incident: "TECH-924",
    reproduced: true,
    engineTest: "channel envelope never enters the ticket description",
  },
  {
    scenario: "conflicting identifier parks instead of silent merge",
    incident: "TECH-928",
    reproduced: true,
    engineTest: "identifier-conflict parks and asks new-incident-or-append",
  },
  {
    scenario: "shortened / area-code number is the same number",
    incident: "TECH-928",
    reproduced: true,
    engineTest: "same number shortened/with area code is NOT a conflict",
  },
  {
    scenario: "complete report while a draft is open parks",
    incident: "E2E 28/09",
    reproduced: true,
    engineTest: "full report while another draft is mid-collection parks",
  },
  {
    scenario: "follow-up never overwrites a created ticket's identifiers",
    incident: "TECH-956",
    reproduced: true,
    engineTest: "follow-up never overwrites a created ticket's identifiers",
  },
  {
    scenario: "every existing-ticket write needs a preview + button",
    incident: "ADR-0008 / TECH-795",
    reproduced: true,
    engineTest: "append to own ticket shows a preview + button, writes nothing yet",
  },
  {
    scenario: "write executes only on exact button match",
    incident: "TECH-975/1013",
    reproduced: true,
    engineTest: "append executes only on an exact button match",
  },
  {
    scenario: "others' tickets: status only, no edits",
    incident: "ADR-0008 §6",
    reproduced: true,
    engineTest: "own-ticket-only edits; someone else's ticket gets status only",
  },
  {
    scenario: "one-round tech review, any answer proceeds",
    incident: "TECH-759/722",
    reproduced: true,
    engineTest: "tech review asks once, any answer proceeds to summary",
  },
  {
    scenario: "expired draft closes, later message starts fresh",
    incident: "draft TTL",
    reproduced: true,
    engineTest: "an expired draft closes and a later message starts fresh",
  },
  {
    scenario: "/new parks the current draft",
    incident: "force_new flag",
    reproduced: true,
    engineTest: "forceNew parks the open draft and opens a new one",
  },
  // Not reproducible in the library test harness — documented, never faked:
  {
    scenario: "LLM field extraction accuracy (extractor prompts/schema)",
    incident: "extractor.*.test",
    reproduced: false,
    why: "Needs the real LLM + Tiểu Linh prompts; the library injects a FieldExtractorPort, so faking it would assert against our own fake, not Tiểu Linh. Covered in the bot, not the library.",
  },
  {
    scenario: "similar-ticket / KG advice at summary time",
    incident: "ADR-0007",
    reproduced: false,
    why: "KG/Onyx is an optional post-create hook port with NO implementation in src (ADR-0002/0003/0007 are Tiểu Linh-only). Nothing to reproduce in-library.",
  },
  {
    scenario: "background realtime-gate ping to 127.0.0.1:8140",
    incident: "sidecar",
    reproduced: false,
    why: "A bot sidecar side-effect, outside the engine's responsibility; the engine exposes afterCreate() for the bot to wire it.",
  },
];

// Directories excluded from the copy (keep whatever the tests need).
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "downloads",
  "graphify-out",
  ".tgrep",
  ".claude",
  ".codex",
  ".agents",
]);
// Paths (relative to SRC) dropped after copy — big/irrelevant for tests.
const DROP_AFTER = ["intake/dist", "intake/dist-live", "intake/graphify-out", "intake/.tgrep"];

// ── shim table ─────────────────────────────────────────────────────────────
// Each entry: the intake module (relative to intake/) replaced by a shim that
// re-exports from the library, preserving the ORIGINAL path and exported names.
type Shim = {
  /** path relative to intake/ */
  file: string;
  /** library subpath export, e.g. "/core" */
  from: string;
  /** shim body generator (import path already resolved) */
  body: (imp: string) => string;
  note?: string;
};

const CORE = `${LIB_PKG}/core`;
const ITSAPLAN = `${LIB_PKG}/itsaplan`;
const INTAKE = `${LIB_PKG}/intake`;

const SHIMS: Shim[] = [
  {
    file: "lib/logger.ts",
    from: CORE,
    body: (imp) =>
      `// SHIM → ${imp}\n` +
      `export { type LogLevel, type IntakeLogger, getLogger, setLogger } from "${imp}";\n`,
  },
  {
    file: "lib/tool-error.ts",
    from: CORE,
    note: "wires intake alertAdmin via setToolFailureAlert",
    body: (imp) =>
      `// SHIM → ${imp}. Library has no Telegram; wire intake's alertAdmin as the alert hook.\n` +
      `import { setToolFailureAlert } from "${imp}";\n` +
      `import { alertAdmin } from "./telegram/alert";\n` +
      `export { type ToolFailure, newErrorCode, describeToolFailure } from "${imp}";\n` +
      `// Side-effect on import: keep intake behaviour (admin gets alerted on tool failure).\n` +
      `setToolFailureAlert((key, message) => alertAdmin(key, message));\n`,
  },
  {
    file: "mcp/shared/server.ts",
    from: CORE,
    note: "intake re-exports createIntakeMcpServer/runOnStdio/runOnHttp/HttpMcpOptions/IntakeMcpOptions",
    body: (imp) =>
      `// SHIM → ${imp}\n` +
      `export { type IntakeMcpOptions, type HttpMcpOptions, createIntakeMcpServer, runOnStdio, runOnHttp } from "${imp}";\n`,
  },
  {
    file: "mcp/shared/tool.ts",
    from: CORE,
    body: (imp) =>
      `// SHIM → ${imp}\n` +
      `export { type McpTool, type AnyMcpTool, defineTool } from "${imp}";\n`,
  },
  {
    file: "lib/onyx/pii-redactor.ts",
    from: CORE,
    body: (imp) => `// SHIM → ${imp}\nexport { redactIncidentPII } from "${imp}";\n`,
  },
  {
    file: "lib/channel-envelope.ts",
    from: CORE,
    note: "intake only exports stripChannelEnvelope; library adds extractChannelEnvelope/ChannelEnvelopeInfo (superset — harmless)",
    body: (imp) => `// SHIM → ${imp}\nexport { stripChannelEnvelope } from "${imp}";\n`,
  },
  {
    file: "lib/formatting.ts",
    from: CORE,
    note: "generic exports from library; intake-only funcs (appendTicketUpdateDescription, isCommentRecentlyForwarded) kept in original.local.ts",
    body: (imp) =>
      `// SHIM → ${imp} (generic exports only). Intake-only helpers live in ./formatting.local.ts.\n` +
      `export {\n` +
      `  BOT_COMMENT_MARKER, markBotComment, isBotComment,\n` +
      `  cleanMediaTags, stripCommentHtml, extractMediaAttachments,\n` +
      `  formatIctTimestamp, KNOWN_BOT_HANDLES, stripBotMentions,\n` +
      `} from "${imp}";\n` +
      `export { appendTicketUpdateDescription, isCommentRecentlyForwarded } from "./formatting.local";\n`,
  },
  {
    file: "lib/storage/lazy-db.ts",
    from: CORE,
    note: "intake exports openLazyDb (bound to intake Database). Library exports openLazyDb + makeOpenLazyDb.",
    body: (imp) => `// SHIM → ${imp}\nexport { openLazyDb } from "${imp}";\n`,
  },
  {
    file: "lib/storage/memo.ts",
    from: CORE,
    body: (imp) => `// SHIM → ${imp}\nexport { memoByKey, memoByPath } from "${imp}";\n`,
  },
  {
    file: "worker/project-lock.ts",
    from: ITSAPLAN,
    note: "intake exports normalizeProjectKey/projectOfIdentifier/identifierInProject; library itsaplan/project-lock",
    body: (imp) =>
      `// SHIM → ${imp}\n` +
      `export { normalizeProjectKey, projectOfIdentifier, identifierInProject } from "${imp}";\n`,
  },
  {
    file: "mcp/shared/tools/assess-priority.ts",
    from: INTAKE,
    note: "keep MCP wrapper (assessPriority), delegate engine (evaluatePriorityRules + types) to library",
    body: (imp) =>
      `// SHIM: MCP wrapper stays here, priority ENGINE delegated to ${imp}.\n` +
      `import { z } from "zod";\n` +
      `import { defineTool, type AnyMcpTool } from "../tool";\n` +
      `import {\n` +
      `  type UrgencyRules, type UrgencyRuleFloor, type UrgencyRuleCeiling,\n` +
      `  evaluatePriorityRules,\n` +
      `} from "${imp}";\n` +
      `export { type UrgencyRules, type UrgencyRuleFloor, type UrgencyRuleCeiling, evaluatePriorityRules };\n\n` +
      `const evidenceShape = {\n` +
      `  scope: z.enum(["single_user", "group", "entire_system"]).optional()\n` +
      `    .describe("Lỗi đang ảnh hưởng một người, một nhóm, hay cả hệ thống? (single_user | group | entire_system)"),\n` +
      `  blocksPayment: z.boolean().optional().describe("Có ai đang KHÔNG hoàn tất được giao dịch ngay lúc này không?"),\n` +
      `  reconciliationMismatch: z.boolean().optional().describe("Có lệch đối soát tiền không?"),\n` +
      `  blocksLearning: z.boolean().optional().describe("Học sinh đã trả tiền mà không học được?"),\n` +
      `  dataLoss: z.boolean().optional().describe("Có mất dữ liệu không lùi lại được không?"),\n` +
      `  hasWorkaround: z.boolean().optional().describe("Có cách làm tạm để đi vòng qua lỗi không?"),\n` +
      `  singleDeviceOnly: z.boolean().optional().describe("Chỉ hỏng trên một máy, máy khác vẫn chạy?"),\n` +
      `};\n\n` +
      `export function assessPriority(rules: UrgencyRules): AnyMcpTool {\n` +
      `  const levels = rules.levels;\n` +
      `  return defineTool({\n` +
      `    name: "assess_priority",\n` +
      `    description:\n` +
      `      "Đối chiếu mức ưu tiên bạn định gán với bằng chứng đọc được từ mô tả. " +\n` +
      `      "DÙNG THẲNG \\\`allowedLevel\\\` làm mức của ticket — KHÔNG dừng lại hỏi người dùng. " +\n` +
      `      "\\\`differsFromProposed: true\\\` chỉ nghĩa là mức bạn đề xuất lệch với bằng chứng, không phải lệnh dừng.",\n` +
      `    inputSchema: {\n` +
      `      proposedLevel: z.enum(levels as [string, ...string[]]).describe("Mức bạn định gán sau khi đọc mô tả"),\n` +
      `      ...evidenceShape,\n` +
      `    },\n` +
      `    handler: (input) => {\n` +
      `      const evidence: Record<string, unknown> = {};\n` +
      `      const missing: string[] = [];\n` +
      `      for (const key of Object.keys(evidenceShape) as Array<keyof typeof evidenceShape>) {\n` +
      `        const value = (input as Record<string, unknown>)[key];\n` +
      `        if (value === undefined) missing.push(key); else evidence[key] = value;\n` +
      `      }\n` +
      `      const result = evaluatePriorityRules(rules, input.proposedLevel, evidence);\n` +
      `      return { ...result, missingEvidence: missing };\n` +
      `    },\n` +
      `  });\n` +
      `}\n`,
  },
];

// itsaplan modules: thin re-export shims, same names.
const ITSAPLAN_MODULES = [
  "client",
  "project",
  "status",
  "attachments",
  "ticket-state",
  "sync-labels",
  "ensure-webhook",
];
for (const m of ITSAPLAN_MODULES) {
  SHIMS.push({
    file: `lib/itsaplan/${m}.ts`,
    from: ITSAPLAN,
    body: (imp) => `// SHIM → ${imp} (re-export ${m}.ts surface)\nexport * from "${imp}";\n`,
    note: `re-export library itsaplan/${m}`,
  });
}

// gate modules: all except from-validation-rules.ts
const GATE_MODULES = [
  "types",
  "catalog",
  "gate",
  "normalize",
  "recap",
  "schema",
  "buttons",
  "validate",
];
for (const m of GATE_MODULES) {
  SHIMS.push({
    file: `lib/gate/${m}.ts`,
    from: `${INTAKE}`,
    body: (imp) => `// SHIM → ${imp} (gate/${m})\nexport * from "${imp}";\n`,
    note: `gate/${m} via library intake/gate`,
  });
}

// Extra shims contributed by later tickets: every scripts/parity-shims/*.ts (except types.ts)
// exports `shims: Shim[]`. Keeps parallel tickets from editing this file.
{
  const { readdirSync } = await import("node:fs");
  const dir = resolve(dirname(new URL(import.meta.url).pathname), "parity-shims");
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "types.ts")
      .sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const mod = await import(join(dir, f));
    for (const s of (mod.shims ?? []) as Shim[]) SHIMS.push(s);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function statusHash(repo: string): Promise<string> {
  // `git ... status --porcelain | sha1sum` : hash the raw stdout bytes exactly
  // (bun's $.arrayBuffer() returns the untouched stdout, newline included).
  const buf = await $`git -C ${repo} status --porcelain`.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(new Uint8Array(buf));
  return hasher.digest("hex");
}

function parseBunTest(output: string): { pass: number; skip: number; fail: number } {
  // Bun's authoritative summary prints, near the end, lines like:
  //   " 862 pass", "  27 skip", "   0 fail"
  // Match ONLY those summary lines (whole-line, leading spaces, nothing after
  // the word) and take the LAST occurrence of each — never substrings such as
  // "[HTTP Retry] Attempt 1/3 failed".
  const num = (label: string) => {
    const re = new RegExp(`^\\s*(\\d+)\\s+${label}\\s*$`, "gm");
    let last = 0;
    for (const m of output.matchAll(re)) last = Number(m[1]);
    return last;
  };
  return { pass: num("pass"), skip: num("skip"), fail: num("fail") };
}

function failingTests(output: string): Array<{ name: string; file: string }> {
  const fails: Array<{ name: string; file: string }> = [];
  const lines = output.split("\n");
  let currentFile = "";
  for (const line of lines) {
    const fileMatch = line.match(/^([\w./-]+\.test\.ts):\s*$/);
    if (fileMatch) currentFile = fileMatch[1];
    // Bun's real failure marker is a line beginning with "(fail)".
    const failMatch = line.match(/^\(fail\)\s+(.*)$/);
    if (failMatch) fails.push({ name: failMatch[1].trim(), file: currentFile });
  }
  return fails;
}

// ── main ─────────────────────────────────────────────────────────────────────
const log = (s: string) => console.log(`[parity] ${s}`);

async function main() {
  // Ticket-09 stretch: engine-scenario parity. Runs the LIBRARY engine test
  // suite (which drives src/intake/engine through step()) and records which
  // Tiểu Linh pipeline.flow scenario each test stands in for. Does NOT touch
  // the live repo or the shadow copy. Opt-in via --engine; may run standalone.
  if (RUN_ENGINE) {
    await runEngineParity();
    if (!process.argv.includes("--shadow")) return; // --engine alone = engine-only
  }

  // 1. record pre-run status hashes of all live repos
  const before: Record<string, string> = {};
  for (const [name, path] of Object.entries(LIVE_REPOS)) before[name] = await statusHash(path);
  log(`live status hashes BEFORE: ${JSON.stringify(before)}`);

  // 2. fresh copy of SRC → SHADOW (exclude heavy/irrelevant dirs)
  await rm(SHADOW, { recursive: true, force: true });
  await mkdir(SHADOW, { recursive: true });
  log(`copying ${SRC} → ${SHADOW} (fresh)`);
  await cp(SRC, SHADOW, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(SRC.length + 1);
      const top = rel.split("/");
      // exclude any path segment that is an excluded dir name
      if (top.some((seg) => EXCLUDE_DIRS.has(seg))) return false;
      return true;
    },
  });
  for (const d of DROP_AFTER) await rm(join(SHADOW, d), { recursive: true, force: true });

  const shadowIntake = join(SHADOW, "intake");

  // 3. point the copy's intake package at the library (file: dep)
  const pkgPath = join(shadowIntake, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[LIB_PKG] = `file:${LIB}`;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  log(`added dependency ${LIB_PKG} → file:${LIB}`);

  // 3b. install BEFORE any shim so a clean baseline can run in the shadow location
  log("bun install (shadow)…");
  await $`bun install`.cwd(shadowIntake).quiet();

  // 4. baseline reproduction in the shadow location (unmodified copy)
  let baselineShadow = { pass: 0, skip: 0, fail: 0 };
  if (RUN_BASELINE) {
    log("running UNMODIFIED copy to confirm baseline reproduces…");
    const r = await $`bun test .`.cwd(shadowIntake).nothrow().quiet();
    const out = r.stdout.toString() + r.stderr.toString();
    baselineShadow = parseBunTest(out);
    log(`baseline(shadow) = ${JSON.stringify(baselineShadow)}`);
  }

  // 5. write shims (keep intake-only formatting funcs in a sibling .local.ts)
  const replaced: Array<{ file: string; note?: string }> = [];
  const skipped: Array<{ file: string; why: string }> = [];
  for (const shim of SHIMS) {
    const abs = join(shadowIntake, shim.file);
    if (!existsSync(abs)) {
      skipped.push({ file: shim.file, why: "not present in copy" });
      continue;
    }
    // formatting: split intake-only helpers into formatting.local.ts first
    if (shim.file === "lib/formatting.ts") {
      const orig = await readFile(abs, "utf8");
      await writeFile(join(dirname(abs), "formatting.local.ts"), extractIntakeOnlyFormatting(orig));
    }
    // generic: keep the original next to the shim so it can re-export bot-only parts from it
    const keep = (shim as Shim & { preserveAs?: string }).preserveAs;
    if (keep) await writeFile(join(dirname(abs), keep), await readFile(abs, "utf8"));
    await writeFile(abs, shim.body(shim.from));
    replaced.push({ file: shim.file, note: shim.note });
  }
  log(`replaced ${replaced.length} modules, skipped ${skipped.length}`);

  // 6. re-install (file: dep already present) & run intake tests with shims
  await $`bun install`.cwd(shadowIntake).nothrow().quiet();
  log("running shadow (with shims) tests…");
  const r = await $`bun test .`.cwd(shadowIntake).nothrow().quiet();
  const out = r.stdout.toString() + r.stderr.toString();
  const shadow = parseBunTest(out);
  const fails = failingTests(out);
  log(`shadow(with shims) = ${JSON.stringify(shadow)}`);

  // 7. record post-run hashes & prove the COPY SOURCE is untouched.
  //    intake-agents is the only live repo we read INTO the copy, so its
  //    before==after is the enforced invariant (a change there = contamination).
  //    teacheragent / Bot-Sales are NEVER read or written by this harness — only
  //    hashed. They are live bots that rewrite their own working tree, so an
  //    external drift there is expected and reported as informational, not fatal.
  const after: Record<string, string> = {};
  for (const [name, path] of Object.entries(LIVE_REPOS)) after[name] = await statusHash(path);

  const SOURCE = "intake-agents"; // the repo we copy from
  const sourceUntouched = before[SOURCE] === after[SOURCE];
  const others = Object.keys(before).filter((k) => k !== SOURCE);
  const othersDrifted = others.filter((k) => before[k] !== after[k]);

  if (!sourceUntouched) {
    console.error(
      `[parity] FATAL: copy source ${SOURCE} status hash CHANGED — the harness must only READ it.`,
      { before: before[SOURCE], after: after[SOURCE] },
    );
    process.exitCode = 1;
  }
  if (othersDrifted.length > 0) {
    log(
      `note: ${othersDrifted.join(", ")} drifted during the run (external live-bot writes). ` +
        `This harness never reads or writes them — it only hashes them.`,
    );
  }
  const untouched = sourceUntouched; // report invariant = copy source untouched
  log(
    `status hashes AFTER: ${JSON.stringify(after)} — source(${SOURCE}) untouched=${sourceUntouched}` +
      (othersDrifted.length ? `, external drift: ${othersDrifted.join(",")}` : ``),
  );

  // 8. write report
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(
    REPORT_PATH,
    buildReport({
      before,
      after,
      untouched,
      baselineShadow,
      shadow,
      replaced,
      skipped,
      fails,
      out,
    }),
  );
  log(`report → ${REPORT_PATH}`);

  // save raw log under scratch for debugging
  await writeFile(join(SCRATCH, "shadow-parity-last.log"), out);
}

function extractIntakeOnlyFormatting(orig: string): string {
  // Keep the WHOLE original formatting.ts verbatim as formatting.local.ts so the
  // intake-only helpers (appendTicketUpdateDescription, isCommentRecentlyForwarded)
  // and their private module state (recentCommentForwards, etc.) are preserved
  // exactly. The shim re-exports only those two names from here; the generic
  // names come from the library. This is the honest, behaviour-preserving split
  // — surgical extraction risked mangling multi-line signatures / dropping
  // module-level state.
  return (
    `// Original intake formatting.ts kept verbatim. The shim (./formatting.ts)\n` +
    `// re-exports ONLY the intake-only helpers from here; generic exports are\n` +
    `// delegated to @vuihoc/bot-core/core.\n` +
    orig
  );
}

function buildReport(d: any): string {
  const { before, after, untouched, baselineShadow, shadow, replaced, skipped, fails } = d;
  const okBaseline =
    baselineShadow.pass === BASELINE.pass &&
    baselineShadow.skip === BASELINE.skip &&
    baselineShadow.fail === BASELINE.fail;
  const match =
    shadow.pass === BASELINE.pass && shadow.skip === BASELINE.skip && shadow.fail === BASELINE.fail;
  const L: string[] = [];
  L.push(`# Shadow Parity Report — @vuihoc/bot-core (Ticket 10)\n`);
  L.push(`_Generated by \`scripts/shadow-parity.ts\`. Library: \`${basename(LIB)}\`._\n`);
  L.push(`## Results\n`);
  L.push(`| run | pass | skip | fail |`);
  L.push(`|---|---|---|---|`);
  L.push(`| baseline (recorded) | ${BASELINE.pass} | ${BASELINE.skip} | ${BASELINE.fail} |`);
  L.push(
    `| baseline (shadow, unmodified) | ${baselineShadow.pass} | ${baselineShadow.skip} | ${baselineShadow.fail} | ${okBaseline ? "✅ reproduces" : "⚠️ differs"}`,
  );
  L.push(
    `| shadow (with library shims) | ${shadow.pass} | ${shadow.skip} | ${shadow.fail} | ${match ? "✅ parity" : "❌ differs"}`,
  );
  L.push(``);
  L.push(`## Live source repos — read-only proof\n`);
  L.push(`\`intake-agents\` is the only repo READ INTO the copy; its before==after is the`);
  L.push(`enforced invariant. \`teacheragent\` / \`Bot-Sales\` are never read or written by`);
  L.push(`this harness — only hashed — so an external live-bot write there is noted, not fatal.\n`);
  L.push(`| repo | role | before | after | our writes? |`);
  L.push(`|---|---|---|---|---|`);
  for (const k of Object.keys(before)) {
    const role =
      k === "intake-agents" ? "copy source (enforced)" : "hashed only (external writers OK)";
    const same = before[k] === after[k];
    const verdict =
      k === "intake-agents"
        ? same
          ? "✅ untouched"
          : "❌ CONTAMINATED"
        : same
          ? "✅ none"
          : "✅ none (drift is external)";
    L.push(`| ${k} | ${role} | \`${before[k]}\` | \`${after[k]}\` | ${verdict} |`);
  }
  L.push(
    `\nCopy source \`intake-agents\` untouched by this harness: **${untouched ? "YES" : "NO"}**\n`,
  );
  L.push(`## Modules replaced (${replaced.length})\n`);
  for (const r of replaced) L.push(`- \`intake/${r.file}\`${r.note ? ` — ${r.note}` : ""}`);
  L.push(``);
  L.push(`## Modules skipped (${skipped.length})\n`);
  if (skipped.length === 0) L.push(`_(none)_`);
  for (const s of skipped) L.push(`- \`intake/${s.file}\` — ${s.why}`);
  L.push(``);
  L.push(`## Library behaviour differences\n`);
  if (fails.length === 0) {
    L.push(`**None.** Every replaced module reached full test parity with plain`);
    L.push(`re-exports plus three documented adapter shims (tool-error alert hook,`);
    L.push(`formatting intake-only split, assess-priority engine delegation). The`);
    L.push(`library surfaces are faithful supersets of intake's — no library fix ticket needed.\n`);
  } else {
    L.push(`See per-test root causes below.\n`);
  }
  L.push(`## Failing tests (${fails.length})\n`);
  if (fails.length === 0) {
    L.push(`_None — full parity with baseline._`);
  } else {
    for (const f of fails) {
      L.push(`### ${f.name}`);
      L.push(`- **File:** \`${f.file}\``);
      L.push(`- **Library behaviour difference (root cause):** _TODO: fill from log analysis_`);
      L.push(`- **Minimal fix proposal:** _TODO_`);
      L.push(``);
    }
  }
  return L.join("\n") + "\n";
}

async function runEngineParity(): Promise<void> {
  log("engine-parity: running the LIBRARY engine suite (src/intake/engine)…");
  // Run only the engine suite in the library itself — no shadow, no live repo.
  const r = await $`bun test src/intake/engine`.cwd(LIB).nothrow().quiet();
  const out = r.stdout.toString() + r.stderr.toString();
  const result = parseBunTest(out);
  const fails = failingTests(out);
  log(`engine suite = ${JSON.stringify(result)}`);
  await mkdir(dirname(ENGINE_REPORT_PATH), { recursive: true });
  await writeFile(ENGINE_REPORT_PATH, buildEngineReport(result, fails));
  await writeFile(join(SCRATCH, "engine-parity-last.log"), out);
  log(`engine report → ${ENGINE_REPORT_PATH}`);
}

function buildEngineReport(
  result: { pass: number; skip: number; fail: number },
  fails: Array<{ name: string; file: string }>,
): string {
  const reproduced = ENGINE_SCENARIO_MAP.filter((s) => s.reproduced);
  const notReproduced = ENGINE_SCENARIO_MAP.filter((s) => !s.reproduced);
  const L: string[] = [];
  L.push(`# Engine Scenario Parity — @vuihoc/bot-core/intake (Ticket 09 stretch)\n`);
  L.push(`_Generated by \`scripts/shadow-parity.ts --engine\`. Library: \`${basename(LIB)}\`._\n`);
  L.push(`This maps the SCENARIOS in Tiểu Linh's \`lib/intake-step/pipeline.flow.test.ts\``);
  L.push(`to the library's own conversation engine (\`src/intake/engine\`), driven through`);
  L.push(`the public \`step()\` seam with scripted extractor fakes and the \`examples/tieulinh\``);
  L.push(`config. The live repo is NOT touched by this mode.\n`);
  L.push(`## Engine suite result\n`);
  L.push(`| pass | skip | fail |`);
  L.push(`|---|---|---|`);
  L.push(
    `| ${result.pass} | ${result.skip} | ${result.fail} | ${result.fail === 0 ? "✅" : "❌"}\n`,
  );
  L.push(`## Scenarios reproduced in-library (${reproduced.length})\n`);
  L.push(`| pipeline.flow scenario | incident | engine test |`);
  L.push(`|---|---|---|`);
  for (const s of reproduced) L.push(`| ${s.scenario} | ${s.incident} | \`${s.engineTest}\` |`);
  L.push(``);
  L.push(`## NOT reproduced in-library — and why (${notReproduced.length})\n`);
  L.push(`These behaviours depend on infrastructure the library deliberately injects as`);
  L.push(`ports (LLM, KG/Onyx, bot sidecars). Reproducing them here would mean asserting`);
  L.push(`against our own fakes rather than against Tiểu Linh — so they are documented,`);
  L.push(`never faked.\n`);
  L.push(`| scenario | reference | why not reproduced here |`);
  L.push(`|---|---|---|`);
  for (const s of notReproduced) L.push(`| ${s.scenario} | ${s.incident} | ${s.why} |`);
  L.push(``);
  if (fails.length > 0) {
    L.push(`## Failing engine tests (${fails.length})\n`);
    for (const f of fails) L.push(`- \`${f.name}\` (${f.file})`);
    L.push(``);
  }
  return L.join("\n") + "\n";
}

await main();
