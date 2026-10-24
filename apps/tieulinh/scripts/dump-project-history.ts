#!/usr/bin/env bun
/**
 * Dump toàn bộ ticket của một dự án (issue đầy đủ + timeline) ra JSON để đo
 * ticket tương tự offline (scripts/eval-similar-tickets.ts). CHỈ ĐỌC.
 *
 *   bun scripts/dump-project-history.ts [--project TECH] [--out data/history/TECH.json]
 *
 * Cần ITSAPLAN_BASE_URL + ITSAPLAN_API_KEY (Bun tự nạp apps/tieulinh/.env). File dump
 * chứa dữ liệu thật (SĐT, tên) — thư mục data/history/ đã bị .gitignore.
 */
import { ItsaplanClient } from "../lib/itsaplan/client";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const project = arg("--project", "TECH").toUpperCase();
const out = arg("--out", `data/history/${project}.json`);

const baseUrl = process.env.ITSAPLAN_BASE_URL;
const apiKey = process.env.ITSAPLAN_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Thiếu ITSAPLAN_BASE_URL / ITSAPLAN_API_KEY.");
  process.exit(1);
}
const client = new ItsaplanClient(baseUrl, apiKey);

// Itsaplan trả 500 khi bị gọi dồn — thử lại có giãn cách.
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (err) {
      if (attempt >= 4) throw err;
      await Bun.sleep(400 * (attempt + 1));
    }
  }
}

const list = await retry(() => client.listProjectIssues(project, { limit: 1000 }));
const columns = await retry(() => client.listProjectColumns(project));
const issues: Array<{ issue: unknown; timeline: unknown[] }> = [];
for (const item of list) {
  issues.push({ issue: await retry(() => client.getIssue(item.id)), timeline: await retry(() => client.getIssueTimeline(item.id)) });
  await Bun.sleep(40);
}
await Bun.write(out, JSON.stringify({ project, dumpedAt: new Date().toISOString(), columns, issues }));
console.log(`${project}: ${issues.length} ticket → ${out}`);
