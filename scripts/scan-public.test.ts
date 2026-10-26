import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDenylist } from "./lib/denylist";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scan-denylist-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readDenylist", () => {
  test("đọc file đơn .scan-denylist", () => {
    writeFileSync(join(dir, ".scan-denylist"), "# ghi chú\nsdt-01\n\n");
    expect(readDenylist(dir)).toEqual(["sdt-01"]);
  });

  test("đọc nhiều fragment, mỗi file một chủ sở hữu", () => {
    mkdirSync(join(dir, ".scan-denylist.d"));
    writeFileSync(join(dir, ".scan-denylist.d", "01-claude.txt"), "a-01\nb-02\n");
    writeFileSync(join(dir, ".scan-denylist.d", "02-omp.txt"), "c-03\n");
    expect(readDenylist(dir)).toEqual(["a-01", "b-02", "c-03"]);
  });

  test("fragment của agent khác không bị mất khi thêm dòng mới", () => {
    mkdirSync(join(dir, ".scan-denylist.d"));
    writeFileSync(join(dir, ".scan-denylist.d", "01-claude.txt"), "a-01\n");
    writeFileSync(join(dir, ".scan-denylist.d", "02-omp.txt"), "c-03\n");
    // agent mới thêm vào file của chính nó, file người khác không đụng tới
    writeFileSync(join(dir, ".scan-denylist.d", "03-new.txt"), "d-04\n");
    expect(readDenylist(dir)).toEqual(["a-01", "c-03", "d-04"]);
  });

  test("bỏ qua dòng trống, dòng ghi chú và file không phải .txt", () => {
    mkdirSync(join(dir, ".scan-denylist.d"));
    writeFileSync(join(dir, ".scan-denylist.d", "a.txt"), "# note\n\nx-01\n");
    writeFileSync(join(dir, ".scan-denylist.d", "b.md"), "y-02\n");
    expect(readDenylist(dir)).toEqual(["x-01"]);
  });

  test("không có gì thì trả về mảng rỗng", () => {
    expect(readDenylist(dir)).toEqual([]);
  });
});
