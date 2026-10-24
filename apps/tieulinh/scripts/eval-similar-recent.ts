#!/usr/bin/env bun
/**
 * Đo A (judgeMode="mechanism") vs B (judgeMode="applicability") trên bộ đáp án
 * THẬT gần đây (data/similar-recent-gold.json, dựng bằng
 * scripts/build-similar-gold-recent.ts — humanKnowledgeOf trên tín hiệu người
 * thật, KHÔNG phải gợi ý bot).
 *
 * Corpus: y hệt cách production tính (buildCauseClusters/humanKnowledgeOf/
 * similarContextOf/symptomsOfDescription) trên TOÀN BỘ ticket TECH dump
 * (data/history/TECH.json, scripts/dump-project-history.ts) — không cần Memgraph.
 *
 * Chạy:  bun scripts/eval-similar-recent.ts <mechanism|applicability>
 * Cache Onyx/LLM tại data/similar-recent-*-cache.json (không cache lỗi).
 *
 * Kết luận đo 29/09 (xem lib/kg/similar-judge.ts::JudgeMode): applicability
 * tăng recall/answered nhưng tăng đều "gắn bừa" trên CẢ BA bộ đo (recent-real,
 * dev, test) — KHÔNG đổi mặc định, giữ "mechanism".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { humanKnowledgeOf } from "../lib/kg/human-signals";
import { buildCauseClusters, type CauseClusterInput } from "../lib/kg/cause-clusters";
import { symptomsOfDescription, type CorpusTicket } from "../lib/kg/similar-finder";
import { similarContextOf } from "../lib/kg/similar-context";
import { LlmSimilarTickets } from "../lib/kg/similar-ticket-source";
import type { JudgeMode } from "../lib/kg/similar-judge";
import { extractRootCauseAndResolution } from "../lib/onyx/rest-search";

const judgeMode = (process.argv[2] ?? "mechanism").trim() as JudgeMode;
if (judgeMode !== "mechanism" && judgeMode !== "applicability") {
  console.error("Dùng: bun scripts/eval-similar-recent.ts <mechanism|applicability>");
  process.exit(1);
}

const DATA_DIR = `${import.meta.dir}/../data`;
mkdirSync(DATA_DIR, { recursive: true });
const OUT_DIR = DATA_DIR;

// ─── 1) Corpus TOÀN BỘ 500 ticket TECH (Aug20->Sep29), y hệt eval-similar-bench.ts ───
interface DumpTicket {
  issue: {
    identifier: string;
    title: string;
    description?: string;
    createdAt?: string;
    statusSince?: string;
    updatedAt?: string;
  };
  timeline: any[];
}
const dump = JSON.parse(readFileSync(`${DATA_DIR}/history/TECH.json`, "utf8")) as {
  issues: DumpTicket[];
};
const validIds = new Set(dump.issues.map((t) => t.issue.identifier.toUpperCase()));

const humanByTicket = new Map<string, ReturnType<typeof humanKnowledgeOf>>();
for (const t of dump.issues)
  humanByTicket.set(
    t.issue.identifier.toUpperCase(),
    humanKnowledgeOf(t.timeline, t.issue.identifier),
  );

const negatives2Way = new Map<string, Set<string>>();
for (const id of validIds) negatives2Way.set(id, new Set());
for (const [id, h] of humanByTicket) {
  for (const n of h.negatives) {
    const other = n.toUpperCase();
    negatives2Way.get(id)?.add(other);
    if (validIds.has(other)) negatives2Way.get(other)?.add(id);
  }
}

const clusterInput: CauseClusterInput[] = dump.issues.map((t) => {
  const id = t.issue.identifier.toUpperCase();
  const h = humanByTicket.get(id)!;
  return { id, humanCause: h.cause, positives: h.positives, negatives: h.negatives };
});
const clusterOf = buildCauseClusters(clusterInput);

const corpus: CorpusTicket[] = dump.issues.map((t) => {
  const id = t.issue.identifier.toUpperCase();
  const h = humanByTicket.get(id)!;
  const negs = [...(negatives2Way.get(id) ?? [])];
  const ctx = similarContextOf(t.issue, t.timeline);
  return {
    identifier: id,
    title: t.issue.title ?? "",
    symptomsText: symptomsOfDescription(t.issue.description),
    description: ctx.description,
    humanNotes: ctx.humanNotes,
    system: ctx.system,
    product: ctx.product,
    causeCluster: clusterOf.get(id),
    humanCause: h.cause,
    humanFix: h.fix,
    resolvedAt: t.issue.statusSince ?? t.issue.updatedAt ?? t.issue.createdAt,
    negatives: negs.length ? negs : undefined,
  };
});
console.log(
  `Kho: ${corpus.length} ticket, ${new Set(corpus.map((c) => c.causeCluster)).size} cụm.`,
);
const descById = new Map(
  dump.issues.map((t) => [t.issue.identifier.toUpperCase(), t.issue.description]),
);
const titleById = new Map(
  dump.issues.map((t) => [t.issue.identifier.toUpperCase(), t.issue.title]),
);

// ─── 2) Onyx /api/search thô (CHỈ ĐỌC), lọc lại theo kho — y hệt eval-similar-bench.ts ───
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Thiếu biến môi trường ${name}`);
  return v;
}
const ONYX_BASE_URL = need("ONYX_BASE_URL");
const ONYX_API_KEY = need("ONYX_API_KEY");
const OPENAI_BASE_URL = need("OPENAI_BASE_URL");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODEL = need("OPENAI_MODEL");

interface OnyxHit {
  identifier: string;
  rootCause?: string;
  resolution?: string;
}
const ONYX_CACHE_PATH = `${DATA_DIR}/similar-recent-onyx-cache.json`;
const onyxCache: Record<string, OnyxHit[]> = existsSync(ONYX_CACHE_PATH)
  ? JSON.parse(readFileSync(ONYX_CACHE_PATH, "utf8"))
  : {};
function saveOnyxCache() {
  writeFileSync(ONYX_CACHE_PATH, JSON.stringify(onyxCache, null, 1));
}
let onyxCalls = 0;
async function rawOnyxSearch(query: string): Promise<OnyxHit[]> {
  const key = query.trim();
  if (key in onyxCache) return onyxCache[key];
  onyxCalls++;
  const res = await fetch(`${ONYX_BASE_URL}/api/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ONYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok)
    throw new Error(`Onyx /api/search lỗi HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; content?: string }> };
  const byId = new Map<string, OnyxHit>();
  for (const r of data.results ?? []) {
    const id = r.title?.match(/TECH-\d+/)?.[0];
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      identifier: id,
      ...extractRootCauseAndResolution(`${r.title ?? ""}\n${r.content ?? ""}`),
    });
  }
  const hits = [...byId.values()];
  onyxCache[key] = hits;
  saveOnyxCache();
  return hits;
}
const onyx = {
  searchSimilar: async (query: string) => {
    const hits = await rawOnyxSearch(query);
    return hits.map((h) => ({
      identifier: h.identifier.toUpperCase(),
      title: h.identifier,
      rootCause: h.rootCause,
      resolution: h.resolution,
      verifiedOnTracker: true,
    }));
  },
};

// ─── 3) LLM proxy cục bộ CHỈ để cache — gọi ĐÚNG complete()/verifyCandidate() thật ───
const LLM_CACHE_PATH = `${DATA_DIR}/similar-recent-llm-cache-${judgeMode}.json`;
const llmCache: Record<string, string> = existsSync(LLM_CACHE_PATH)
  ? JSON.parse(readFileSync(LLM_CACHE_PATH, "utf8"))
  : {};
function saveLlmCache() {
  writeFileSync(LLM_CACHE_PATH, JSON.stringify(llmCache, null, 1));
}
let llmCalls = 0;
const llmProxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const bodyText = await req.text();
    const key = createHash("sha256").update(bodyText).digest("hex");
    if (key in llmCache)
      return new Response(llmCache[key], { headers: { "Content-Type": "application/json" } });
    llmCalls++;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const upstream = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(OPENAI_API_KEY ? { Authorization: `Bearer ${OPENAI_API_KEY}` } : {}),
          },
          body: bodyText,
        });
        const text = await upstream.text();
        if (upstream.ok) {
          llmCache[key] = text;
          saveLlmCache();
          return new Response(text, { headers: { "Content-Type": "application/json" } });
        }
        lastErr = new Error(`LLM upstream ${upstream.status}: ${text.slice(0, 200)}`);
      } catch (err) {
        lastErr = err;
      }
    }
    return new Response(JSON.stringify({ error: String(lastErr) }), { status: 502 });
  },
});
const llm = { baseUrl: `http://127.0.0.1:${llmProxy.port}`, apiKey: "", model: OPENAI_MODEL };

// ─── 4) Pipeline thật, judgeMode theo tham số dòng lệnh ───
const memgraph = { loadSimilarityCorpus: async () => corpus };
const src = new LlmSimilarTickets({
  memgraph,
  onyx,
  llm,
  projectKey: "TECH",
  maxCandidates: Number(process.env.SIMILAR_MAX_CANDIDATES ?? 14),
  llmConcurrency: Number(process.env.SIMILAR_LLM_CONCURRENCY ?? 5),
  timeoutMs: Number(process.env.SIMILAR_TIMEOUT_MS ?? 180_000),
  judgeMode,
});

// ─── 5) Bộ đáp án ───
interface GoldRow {
  id: string;
  createdAt: string;
  title: string;
  positives: string[];
  cause?: string;
}
const gold = JSON.parse(readFileSync(`${OUT_DIR}/similar-recent-gold.json`, "utf8")) as {
  withPositives: GoldRow[];
  pinnedNoPositives: GoldRow[];
};
// chỉ giữ mã TECH-*, trong kho, khác chính nó
const cleanPositives = (r: GoldRow) =>
  r.positives
    .map((x) => x.toUpperCase())
    .filter((x) => /^TECH-\d+$/.test(x) && x !== r.id && validIds.has(x));
const withPositives = gold.withPositives
  .map((r) => ({ ...r, positives: cleanPositives(r) }))
  .filter((r) => r.positives.length > 0);
const pinnedNoPositives = gold.pinnedNoPositives;

const TICKET_CONCURRENCY = Number(process.env.EVAL_TICKET_CONCURRENCY ?? 6);

async function main() {
  const allRows = [
    ...withPositives.map((r) => ({ ...r, isEmpty: false })),
    ...pinnedNoPositives.map((r) => ({ ...r, isEmpty: true })),
  ];
  const results: Array<{
    id: string;
    gold: string[];
    accepted: string[];
    possible: string[];
    question?: string;
  }> = new Array(allRows.length);
  const t0 = Date.now();
  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < allRows.length) {
      const i = idx++;
      const r = allRows[i];
      const desc = descById.get(r.id) ?? "";
      const title = titleById.get(r.id) ?? r.title;
      const text = `${title}\n${symptomsOfDescription(desc)}`;
      let accepted: string[] = [];
      let possible: string[] = [];
      let question: string | undefined;
      try {
        const match = await src.find(text, { excludeIds: [r.id] });
        accepted = (match?.members ?? [])
          .map((m) => m.identifier.toUpperCase())
          .filter((x) => x !== r.id);
        possible = (match?.possible ?? []).flatMap((p) => p.sampleIds.map((s) => s.toUpperCase()));
        question = match?.question;
      } catch (err: any) {
        console.warn(`${r.id}: lỗi — ${err?.message ?? err}`);
      }
      results[i] = { id: r.id, gold: r.isEmpty ? [] : r.positives, accepted, possible, question };
      done++;
      console.log(
        `[${done}/${allRows.length} ${((Date.now() - t0) / 1000).toFixed(0)}s] ${r.id} (gold=[${(r.isEmpty ? [] : r.positives).join(",")}]) -> accepted=[${accepted.join(",")}] possible=[${possible.join(",")}]`,
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(TICKET_CONCURRENCY, allRows.length)) }, worker),
  );

  writeFileSync(
    `${OUT_DIR}/similar-recent-results-${judgeMode}.json`,
    JSON.stringify(results, null, 1),
  );
  console.log(`\nĐã ghi ${OUT_DIR}/similar-recent-results-${judgeMode}.json`);
  console.log(`Lời gọi Onyx thật: ${onyxCalls}. Lời gọi LLM thật: ${llmCalls}.`);
  llmProxy.stop(true);
}

main().catch((err) => {
  console.error(err);
  llmProxy.stop(true);
  process.exit(1);
});
