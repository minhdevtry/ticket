#!/usr/bin/env bun
// Chấm data/similar-recent-results-<mode>.json (ghi bởi scripts/eval-similar-recent.ts):
// precision/recall GHI (accepted) theo đáp án người, số ca gắn bừa trên nhóm
// đáp án rỗng, và tỉ lệ "possible" (hiển thị, không ghi) chứa đúng cụm.
// Dùng: bun scripts/score-similar-recent.ts <mechanism|applicability>
const mode = process.argv[2] ?? "mechanism";
const DATA_DIR = `${import.meta.dir}/../data`;
const results = JSON.parse(
  await Bun.file(`${DATA_DIR}/similar-recent-results-${mode}.json`).text(),
) as Array<{
  id: string;
  gold: string[];
  accepted: string[];
  possible: string[];
  question?: string;
}>;

const withGold = results.filter((r) => r.gold.length > 0);
const emptyGold = results.filter((r) => r.gold.length === 0);

let answered = 0,
  P = 0,
  R = 0,
  written = 0,
  wrong = 0;
for (const r of withGold) {
  const pred = [...new Set(r.accepted)];
  const gold = new Set(r.gold);
  if (!pred.length) continue;
  answered++;
  const hit = pred.filter((x) => gold.has(x)).length;
  P += hit / pred.length;
  R += hit / r.gold.length;
  written += pred.length;
  wrong += pred.length - hit;
}
let falseWrite = 0;
for (const r of emptyGold) if (r.accepted.length) falseWrite++;

let displayHit = 0,
  displayable = 0;
for (const r of withGold) {
  if (r.accepted.some((x) => r.gold.includes(x))) continue; // đã ghi đúng rồi, không tính vào "possible"
  displayable++;
  if (r.possible.some((x) => r.gold.includes(x))) displayHit++;
}

console.log(`=== ${mode} — GHI (accepted) so với đáp án người ===`);
console.log(`Tổng ca có đáp án: ${withGold.length}, tổng ca đáp án rỗng: ${emptyGold.length}`);
console.log(
  `trả lời ${answered}/${withGold.length} (${((100 * answered) / withGold.length).toFixed(0)}%) | đúng ${((100 * P) / Math.max(1, answered)).toFixed(0)}% | đủ ${((100 * R) / Math.max(1, answered)).toFixed(0)}% | ghi ${written} mã, sai ${wrong}`,
);
console.log(`Gắn bừa trên nhóm đáp án rỗng: ${falseWrite}/${emptyGold.length}`);
console.log(`=== HIỂN THỊ (possible) khi KHÔNG ghi đúng ===`);
console.log(
  `Trong ${displayable} ca chưa ghi đúng cụm: có gợi ý đúng cụm (possible) ${displayHit}/${displayable}`,
);
