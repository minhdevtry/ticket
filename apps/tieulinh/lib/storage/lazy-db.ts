import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { applySchema } from "./schema";
import { memoByPath } from "./memo";

/**
 * Mở một kết nối SQLite lười, đã áp schema, cache theo đường dẫn.
 *
 * Trước đây `binding-repository.ts`, `session-repository.ts`, và
 * `identity.ts` mỗi file tự viết lại đúng đoạn này (mkdir thư mục cha, mở
 * DB, áp schema) — ba lần giống hệt nhau, và ba kết nối riêng biệt tới
 * cùng một file khi các repo dùng chung `dbPath`. Gom về đây thì sửa một
 * chỗ là sửa cho cả ba, và các repo dùng chung `dbPath` giờ chia sẻ đúng
 * một kết nối.
 */
export const openLazyDb = memoByPath<Database>((dbPath) => {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  applySchema(db, { wal: dbPath !== ":memory:" });
  return db;
});
