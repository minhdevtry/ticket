import { describe, expect, test } from "bun:test";
import { memoByKey, memoByPath } from "./memo";

/**
 * Điều duy nhất đáng khoá: cùng khoá thì phải trả về **đúng một** thực thể. Bỏ
 * sót nghĩa là mở thêm connection SQLite tới cùng một file — thứ `openLazyDb`
 * sinh ra để dẹp. NGUỒN: intake `lib/storage/memo.test.ts`.
 */

describe("memoByPath", () => {
  test("cùng dbPath chỉ dựng một lần, các lượt sau trả lại y hệt", () => {
    let built = 0;
    const open = memoByPath((dbPath: string) => ({ dbPath, id: ++built }));

    const a = open("data/x.db");
    const b = open("data/x.db");

    expect(a).toBe(b);
    expect(built).toBe(1);
  });

  test("khác dbPath thì tách riêng, không dùng nhầm của nhau", () => {
    const open = memoByPath((dbPath: string) => ({ dbPath }));

    const x = open("data/x.db");
    const y = open("data/y.db");

    expect(x).not.toBe(y);
    expect(y.dbPath).toBe("data/y.db");
  });
});

describe("memoByKey", () => {
  test("khoá rút từ tham số, nên config khác nhau cùng dbPath vẫn dùng chung", () => {
    let built = 0;
    const service = memoByKey(
      (config: { dbPath: string; adminIds: string[] }) => config.dbPath,
      (config) => ({ config, id: ++built }),
    );

    const first = service({ dbPath: "data/x.db", adminIds: ["1"] });
    const second = service({ dbPath: "data/x.db", adminIds: ["2"] });

    expect(second).toBe(first);
    expect(second.config.adminIds).toEqual(["1"]);
    expect(built).toBe(1);
  });
});
