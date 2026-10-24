#!/usr/bin/env bun
/**
 * Tiểu Linh tự học "người báo hay phải bổ sung gì" theo hệ thống (W25).
 *
 * Cách dùng:
 *   bun apps/tieulinh/scripts/ask-learn.ts ingest --db PATH [--project TECH] [--limit N] [--concurrency C]
 *       [--from-jsonl FILE] [--exclude FILE] [--timeout-ms MS] [--dry-run]
 *   bun apps/tieulinh/scripts/ask-learn.ts report --db PATH
 *
 * ingest: đọc ticket từ Itsaplan (mặc định, chỉ đọc) hoặc từ file JSONL nghiên cứu; chỉ
 * phân loại các bình luận ứng viên chưa có trong kho bằng LLM (llmConfigFromEnv: OPENAI_*).
 * --exclude FILE: bỏ các ticket có query_id/ticket_id trong file (mỗi dòng JSON hoặc một mã).
 * --timeout-ms: hạn mỗi lần phân loại (mặc định 30000; gateway dev chậm dưới tải thì tăng).
 * --dry-run: chỉ đếm, không gọi LLM, không ghi kho.
 * report: in bảng học được theo hệ thống. Không bao giờ ghi lên Itsaplan.
 *
 * Nightly (không tự cài — xem docs/INTAKE-ASK-LEARNING-20261016.md): chạy `ingest` theo lịch.
 */
import { createItsaplanClient } from "../lib/itsaplan/client-factory";
import * as fs from "node:fs";
import {
  isLlmConfigured,
  llmConfigFromEnv,
  complete as defaultComplete,
  type LlmConfig,
} from "../worker/llm";
import { openAskLearnStore, type AskLearnStore } from "../lib/ask-learning/store";
import { ingest, type IngestSummary } from "../lib/ask-learning/ingest";
import { learnedReport } from "../lib/ask-learning/learned";
import {
  ticketsFromItsaplan,
  ticketsFromJsonl,
  type ItsaplanReadSource,
  type SourceTicket,
} from "../lib/ask-learning/source";

export interface CliDeps {
  env?: Record<string, string | undefined>;
  complete?: Parameters<typeof ingest>[0]["completeFn"];
  itsaplan?: ItsaplanReadSource;
  now?: () => number;
  out?: (line: string) => void;
}

function parseFlags(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[a.slice(2)] = true;
    } else {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return flags;
}

function readExcludeIds(file: string): Set<string> {
  const ids = new Set<string>();
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("{")) {
      const r = JSON.parse(s) as Record<string, unknown>;
      const id = r.query_id ?? r.ticket_id;
      if (typeof id === "string") ids.add(id);
    } else {
      ids.add(s);
    }
  }
  return ids;
}

export function formatReport(report: ReturnType<typeof learnedReport>): string[] {
  const lines = [
    "Hệ thống (intake) | ticket | trọng số ticket | nhãn gộp vào | mục học được (tỉ lệ)",
  ];
  for (const r of report.systems) {
    const top = r.stats
      .slice(0, 6)
      .map(
        (s) => `${s.item}${r.learned.includes(s.item) ? "*" : ""} ${(s.share * 100).toFixed(1)}%`,
      )
      .join(", ");
    lines.push(
      `${r.system} | ${r.tickets} | ${r.weightedTickets.toFixed(1)} | ${r.labels.join("; ") || "-"} | ${top || "-"}  [học: ${r.learned.join(", ") || "-"}]`,
    );
  }
  if (report.unmapped.length > 0) {
    lines.push("Nhãn chưa map sang hệ thống intake (không học được):");
    for (const u of report.unmapped) lines.push(`  ${u.label} | ${u.tickets} ticket`);
  }
  lines.push(
    "(* = qua ngưỡng, đưa vào checklist; App/Web chưa rõ được đếm cho cả DUO_Vuihoc và VH_Tự học)",
  );
  return lines;
}

function formatSummary(s: IngestSummary): string {
  return [
    `Tóm tắt: quét ${s.scannedTickets} ticket`,
    `ứng viên ${s.candidates}`,
    `đã phân loại trước đó ${s.alreadyClassified}`,
    `cần phân loại ${s.toClassify}`,
    `phân loại mới ${s.classified}`,
    `cần bổ sung ${s.needsInfo}`,
    `lỗi ${s.errors}`,
    s.dryRun ? "(chạy thử: không gọi LLM, không ghi)" : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => console.log(line));
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  const dbPath = typeof flags.db === "string" ? flags.db : "";
  if (!dbPath) {
    console.error("Thiếu --db PATH");
    return 2;
  }
  const store: AskLearnStore = openAskLearnStore(dbPath);

  if (cmd === "report") {
    for (const line of formatReport(learnedReport(store, (deps.now ?? Date.now)()))) out(line);
    return 0;
  }
  if (cmd !== "ingest") {
    console.error("Cách dùng: ask-learn.ts ingest|report --db PATH");
    return 2;
  }

  const dryRun = flags["dry-run"] === true;
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : 0;
  const concurrency = typeof flags.concurrency === "string" ? Number(flags.concurrency) : 8;
  const projectKey = (typeof flags.project === "string" ? flags.project : "TECH").toUpperCase();
  const llm: LlmConfig = llmConfigFromEnv(env);
  const timeoutMs =
    typeof flags["timeout-ms"] === "string" ? Number(flags["timeout-ms"]) : undefined;

  let tickets: SourceTicket[];
  if (typeof flags["from-jsonl"] === "string") {
    const lines = fs.readFileSync(flags["from-jsonl"], "utf-8").split("\n");
    tickets = ticketsFromJsonl(limit > 0 ? lines.filter((l) => l.trim()).slice(0, limit) : lines);
  } else {
    const baseUrl = env.ITSAPLAN_BASE_URL ?? "";
    const apiKey = env.ITSAPLAN_AGENT_KEY || env.ITSAPLAN_API_KEY || "";
    const client =
      deps.itsaplan ?? (baseUrl && apiKey ? createItsaplanClient(baseUrl, apiKey) : undefined);
    if (!client) {
      console.error("Thiếu ITSAPLAN_BASE_URL / ITSAPLAN_API_KEY (hoặc dùng --from-jsonl)");
      return 2;
    }
    tickets = await ticketsFromItsaplan(client, projectKey, {
      limit: limit > 0 ? limit : 1000,
      concurrency,
    });
  }

  if (typeof flags.exclude === "string") {
    const skip = readExcludeIds(flags.exclude);
    tickets = tickets.filter((t) => !skip.has(t.issueKey));
  }
  const withSystem = tickets.filter((t) => t.systemRaw.trim().length > 0).length;
  out(`[ask-learn] nguồn: ${tickets.length} ticket (${withSystem} có hệ thống)`);

  if (!dryRun && !isLlmConfigured(llm)) {
    console.error("Chưa cấu hình LLM (OPENAI_BASE_URL / OPENAI_MODEL)");
    return 2;
  }

  const summary = await ingest({
    store,
    tickets,
    llm,
    concurrency,
    dryRun,
    completeFn: deps.complete ?? defaultComplete,
    timeoutMs,
    now: deps.now,
    log: out,
  });
  out(formatSummary(summary));
  return 0;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
