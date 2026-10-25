#!/usr/bin/env bun
/**
 * Ghi bản ghi vàng của lễ tân legacy vào `packages/core/golden/intake/`.
 *
 *   bun run golden:record            ghi (ghi đè) các file JSON
 *   bun run golden:record --check    không ghi; thoát 1 nếu file trong repo khác bản ghi mới
 *
 * Dữ liệu tổng hợp, tất định; chạy lại hai lần ra cùng từng byte. Xem docs/how-to/golden-scripts.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_DIR, recordGolden } from "./record";

const check = process.argv.includes("--check");
const files = await recordGolden();
let drift = 0;
mkdirSync(GOLDEN_DIR, { recursive: true });
for (const [name, content] of files) {
  const path = join(GOLDEN_DIR, name);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== content) {
      drift++;
      console.error(`lệch: ${name}`);
    }
  } else {
    writeFileSync(path, content);
    console.log(`đã ghi ${name}`);
  }
}
if (check && drift > 0) {
  console.error(`${drift} fixture khác bản ghi mới: chạy bun run golden:record rồi commit.`);
  process.exit(1);
}
