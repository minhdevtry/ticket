#!/usr/bin/env bun
/**
 * Dựng bộ đáp án "ticket tương tự" từ dữ liệu THẬT gần đây, để đo A/B judgeMode
 * (similar-judge.ts::JudgeMode) — xem scripts/eval-similar-recent.ts. Đáp án
 * ticket X = humanKnowledgeOf(timeline, X).positives (link/Related Tickets
 * NGƯỜI gắn + mã nhắc trong comment ghim của người, trừ mã người đã gỡ) — trừ
 * chính X. Nguồn: data/history/TECH.json (scripts/dump-project-history.ts).
 *
 *   bun scripts/build-similar-gold-recent.ts
 *
 * Ghi data/similar-recent-gold.json: { withPositives, pinnedNoPositives }.
 * pinnedNoPositives = ticket có ghim Nguyên nhân nhưng KHÔNG gắn ticket tương
 * tự nào — đáp án RỖNG, dùng để đo "gắn bừa".
 */
import { humanKnowledgeOf, isSystemActor } from "../lib/kg/human-signals";

const DATA_DIR = `${import.meta.dir}/../data`;
const dump = JSON.parse(await Bun.file(`${DATA_DIR}/history/TECH.json`).text()) as {
  issues: Array<{ issue: any; timeline: any[] }>;
};

const CUTOFF = "2026-09-20";

interface Row {
  id: string;
  createdAt: string;
  title: string;
  positives: string[];
  cause?: string;
  fix?: string;
  pinnedActor?: string;
}
const rows: Row[] = [];
for (const { issue, timeline } of dump.issues) {
  const id = issue.identifier.toUpperCase();
  if (!issue.createdAt || issue.createdAt < CUTOFF) continue;
  const hk = humanKnowledgeOf(timeline, id);
  const positives = hk.positives.filter((x) => x !== id);
  const pin = (timeline ?? [])
    .filter((c: any) => c?.kind === "comment" && c.pinned && !isSystemActor(c.actorName))
    .sort((a: any, b: any) =>
      String(a.pinnedAt ?? a.createdAt ?? "").localeCompare(
        String(b.pinnedAt ?? b.createdAt ?? ""),
      ),
    )
    .at(-1);
  rows.push({
    id,
    createdAt: issue.createdAt,
    title: issue.title,
    positives,
    cause: hk.cause,
    fix: hk.fix,
    pinnedActor: pin?.actorName,
  });
}

const withPositives = rows.filter((r) => r.positives.length > 0);
const pinnedNoPositives = rows.filter((r) => r.positives.length === 0 && r.cause);

console.log(`Tổng ticket TECH tạo từ ${CUTOFF}: ${rows.length}`);
console.log(`Có người gắn tương tự (positives>0): ${withPositives.length}`);
console.log(
  `Có ghim nguyên nhân nhưng KHÔNG gắn tương tự (đáp án rỗng): ${pinnedNoPositives.length}`,
);

await Bun.write(
  `${DATA_DIR}/similar-recent-gold.json`,
  JSON.stringify({ withPositives, pinnedNoPositives }, null, 1),
);
console.log(`Đã ghi ${DATA_DIR}/similar-recent-gold.json`);
