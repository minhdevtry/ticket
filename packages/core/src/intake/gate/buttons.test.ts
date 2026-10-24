import { describe, expect, test } from "bun:test";
import { fieldButtons, iconFor, labelButtons, layoutButtons } from "./buttons";
import { createCatalog } from "./catalog";
import { fixtureCatalog } from "./catalog.fixture";
import { normalizeValue } from "./normalize";
import { MAX_CALLBACK_DATA_BYTES, type InlineButton } from "./types";

const button = (text: string): InlineButton => ({ text, callbackData: text });

describe("layoutButtons", () => {
  test("puts two short choices on a row", () => {
    const rows = layoutButtons([button("CS"), button("Vận hành"), button("Kế toán")]);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([["CS", "Vận hành"], ["Kế toán"]]);
  });

  test("gives a long label the whole row so it is not truncated", () => {
    const rows = layoutButtons([button("CS"), button("Trang quản trị nội bộ"), button("Kế toán")]);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ["CS"],
      ["Trang quản trị nội bộ"],
      ["Kế toán"],
    ]);
  });

  test("does not open a row it never fills", () => {
    expect(layoutButtons([])).toEqual([]);
  });
});

describe("fieldButtons", () => {
  test("offers the vocabulary of an enum field", () => {
    const rows = fieldButtons(fixtureCatalog, fixtureCatalog.variants["1"].fields.phong_ban)!;
    expect(rows.flat().map((b) => b.callbackData)).toEqual(["CS", "Vận hành", "Marketing"]);
  });

  test("sends back the bare value, not the decorated label", () => {
    // The callback data is matched against the vocabulary, so an emoji in it
    // would fail to normalize.
    const rows = fieldButtons(fixtureCatalog, fixtureCatalog.variants["1"].fields.phong_ban)!;
    expect(rows[0][0]).toEqual({ text: "🎧 CS", callbackData: "CS" });
  });

  test("has nothing to offer for a free-text field", () => {
    expect(fieldButtons(fixtureCatalog, fixtureCatalog.variants["1"].fields.van_de)).toBeNull();
  });
});

describe("iconFor", () => {
  test("uses the icon the catalog declares", () => {
    expect(iconFor(fixtureCatalog, "CS")).toBe("🎧");
  });

  test("falls back to a neutral marker rather than leaving a gap", () => {
    expect(iconFor(fixtureCatalog, "Marketing")).toBe("🔹");
  });
});

describe("labelButtons", () => {
  test("builds a menu from labels that are not part of any vocabulary", () => {
    const rows = labelButtons(fixtureCatalog, ["Xác nhận", "Sửa lại"]);
    expect(rows).toEqual([
      [
        { text: "🔹 Xác nhận", callbackData: "Xác nhận" },
        { text: "🔹 Sửa lại", callbackData: "Sửa lại" },
      ],
    ]);
  });
});

describe("nhãn nút ngắn (`_nhan_nut`)", () => {
  /**
   * Hàng rào cho sự cố 14/09/2026: `callback_data` quá 64 byte làm Telegram từ
   * chối CẢ tin nhắn (400 BUTTON_DATA_INVALID), nên bot câm hẳn chứ không phải
   * mất nút. Soi trên một catalog dựng tại chỗ (fixture của thư viện không mang
   * dữ liệu của bot nào).
   */
  const WELL_FORMED = createCatalog({
    fields: {
      nhanh: {
        "1": {
          ten: "Thử",
          truong: { phong_ban: { bat_buoc: true, kieu: "enum:phong_ban", duoc_hoi: true } },
        },
      },
    },
    enums: { phong_ban: ["CS", "Vận hành", "Marketing"] },
  });

  test("mọi giá trị enum ngắn đều nằm trong trần byte của callback_data", () => {
    const overflowing: Array<[string, number]> = [];
    for (const variant of Object.values(WELL_FORMED.variants)) {
      for (const field of Object.values(variant.fields)) {
        const rows = fieldButtons(WELL_FORMED, field);
        if (!rows) continue;
        for (const btn of rows.flat()) {
          const bytes = Buffer.byteLength(btn.callbackData, "utf8");
          if (bytes > MAX_CALLBACK_DATA_BYTES) overflowing.push([btn.callbackData, bytes]);
        }
      }
    }
    expect(overflowing).toEqual([]);
  });

  const LONG_VALUE = "Không gấp, Product team có thể đánh giá theo quy trình thông thường";
  const labelledCatalog = createCatalog({
    fields: {
      nhanh: {
        "1": {
          ten: "Thử",
          truong: { muc_khan_cap: { bat_buoc: true, kieu: "enum:muc_khan_cap", duoc_hoi: true } },
        },
      },
    },
    enums: { muc_khan_cap: [LONG_VALUE], _nhan_nut: { [LONG_VALUE]: "Không gấp" } },
  });

  test("bấm nút gửi về nhãn ngắn, và nhãn ngắn chuẩn hoá lại đúng giá trị đầy đủ", () => {
    const field = labelledCatalog.variants["1"].fields.muc_khan_cap;
    const sent = fieldButtons(labelledCatalog, field)!.flat().map((b) => b.callbackData);
    expect(sent).toEqual(["Không gấp"]);
    expect(sent.map((s) => normalizeValue(labelledCatalog, field, s))).toEqual([LONG_VALUE]);
  });

  test("nhãn ngắn chỉ thay mặt trên nút — icon vẫn tra theo giá trị đầy đủ", () => {
    const field = labelledCatalog.variants["1"].fields.muc_khan_cap;
    const first = fieldButtons(labelledCatalog, field)![0][0];
    expect(first.text).toBe(`${iconFor(labelledCatalog, LONG_VALUE)} Không gấp`);
  });

  test("catalog khai giá trị quá dài mà không có nhãn ngắn thì chết ngay lúc dựng", () => {
    const tooLong = "Không gấp, Product team có thể đánh giá theo quy trình thông thường";
    expect(() =>
      createCatalog({
        fields: {
          nhanh: {
            "1": {
              ten: "Thử",
              truong: { muc_khan_cap: { bat_buoc: true, kieu: "enum:muc_khan_cap", duoc_hoi: true } },
            },
          },
        },
        enums: { muc_khan_cap: [tooLong] },
      }),
    ).toThrow(/BUTTON_DATA_INVALID/);
  });
});
