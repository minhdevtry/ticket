import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingButtons,
  dropUnsendableButtons,
  MAX_CALLBACK_DATA_BYTES,
  normalizeTelegramId,
  readPendingButtons,
  savePendingButtons,
  type TelegramButton,
} from "./pending-buttons";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pending-buttons-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okRow: TelegramButton[][] = [[{ text: "Tạo ticket", callback_data: "đúng rồi" }]];

describe("normalizeTelegramId", () => {
  test("giữ chữ số", () => {
    expect(normalizeTelegramId("tg_555")).toBe("555");
    expect(normalizeTelegramId(555)).toBe("555");
    expect(normalizeTelegramId("abc")).toBeNull();
    expect(normalizeTelegramId(null)).toBeNull();
  });
});

describe("dropUnsendableButtons — luật phòng thủ của Tiểu Linh", () => {
  test("loại nút callback_data quá 64 byte, giữ nút hợp lệ", () => {
    const long = "x".repeat(MAX_CALLBACK_DATA_BYTES + 1);
    const dropped: string[] = [];
    const kept = dropUnsendableButtons(
      [[{ text: "a", callback_data: "ngan" }, { text: "b", callback_data: long }]],
      (msg) => dropped.push(msg),
    );
    expect(kept).toEqual([[{ text: "a", callback_data: "ngan" }]]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("Telegram từ chối CẢ tin nhắn");
  });

  test("hàng rỗng sau khi lọc bị loại khỏi kết quả", () => {
    const long = "x".repeat(MAX_CALLBACK_DATA_BYTES + 1);
    const kept = dropUnsendableButtons([[{ text: "b", callback_data: long }]]);
    expect(kept).toEqual([]);
  });

  test("đo theo BYTE không phải ký tự (tiếng Việt nhiều byte)", () => {
    // 33 ký tự 'đ' = 66 byte > 64
    const kept = dropUnsendableButtons([[{ text: "x", callback_data: "đ".repeat(33) }]]);
    expect(kept).toEqual([]);
  });
});

describe("save/read/clear pending buttons", () => {
  test("ghi rồi đọc lại đúng bộ nút", () => {
    const n = savePendingButtons("555", okRow, { dir });
    expect(n).toBe(1);
    const read = readPendingButtons("555", { dir });
    expect(read?.buttons).toEqual(okRow);
    expect(typeof read?.ts).toBe("number");
  });

  test("ghi bộ rỗng ⇒ xoá file (không đính nút cũ)", () => {
    savePendingButtons("555", okRow, { dir });
    const n = savePendingButtons("555", [], { dir });
    expect(n).toBe(0);
    expect(readPendingButtons("555", { dir })).toBeNull();
  });

  test("tất cả nút quá dài ⇒ không ghi file", () => {
    const long = "x".repeat(MAX_CALLBACK_DATA_BYTES + 1);
    const n = savePendingButtons("555", [[{ text: "a", callback_data: long }]], { dir });
    expect(n).toBe(0);
    expect(readPendingButtons("555", { dir })).toBeNull();
  });

  test("id không hợp lệ ⇒ no-op", () => {
    expect(savePendingButtons("abc", okRow, { dir })).toBe(0);
    expect(savePendingButtons(null, okRow, { dir })).toBe(0);
  });

  test("clear xoá file", () => {
    savePendingButtons("555", okRow, { dir });
    expect(existsSync(join(dir, "555.json"))).toBe(true);
    clearPendingButtons("555", { dir });
    expect(existsSync(join(dir, "555.json"))).toBe(false);
    // clear lần hai không ném
    clearPendingButtons("555", { dir });
  });

  test("thư mục do người gọi truyền — hai bot dùng hai thư mục khác nhau", () => {
    const dirB = mkdtempSync(join(tmpdir(), "pending-buttons-b-"));
    try {
      savePendingButtons("555", okRow, { dir });
      expect(readPendingButtons("555", { dir: dirB })).toBeNull(); // cô lập
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("ts cố định được qua now injectable", () => {
    savePendingButtons("555", okRow, { dir, now: () => 123456 });
    expect(readPendingButtons("555", { dir })?.ts).toBe(123456);
  });

  test("file JSON hỏng ⇒ read trả null", () => {
    const fs = require("node:fs");
    fs.writeFileSync(join(dir, "555.json"), "{hong", "utf8");
    expect(readPendingButtons("555", { dir })).toBeNull();
  });
});
