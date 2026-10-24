import { describe, expect, test } from "bun:test";
import { MAX_CALLBACK_DATA_BYTES, fieldButtons } from "@vuihoc/bot-core/intake";
import { fixtureCatalog } from "./catalog.fixture";

// Các test chung của gate/buttons nằm ở packages/core. Ở đây chỉ còn phần riêng
// của Tiểu Linh: catalog fixture của bot không được vượt trần callback_data.
describe("nhãn nút ngắn (`_nhan_nut`) trên catalog fixture của Tiểu Linh", () => {
  /**
   * Hàng rào cho sự cố 14/09/2026: `callback_data` quá 64 byte làm Telegram từ
   * chối CẢ tin nhắn (400 BUTTON_DATA_INVALID), nên bot câm hẳn chứ không phải
   * mất nút. Chạy trên toàn bộ catalog fixture.
   */
  test("mọi giá trị enum của catalog fixture đều nằm trong trần byte của callback_data", () => {
    const overflowing: Array<[string, number]> = [];
    for (const variant of Object.values(fixtureCatalog.variants)) {
      for (const field of Object.values(variant.fields)) {
        const rows = fieldButtons(fixtureCatalog, field);
        if (!rows) continue;
        for (const btn of rows.flat()) {
          const bytes = Buffer.byteLength(btn.callbackData, "utf8");
          if (bytes > MAX_CALLBACK_DATA_BYTES) overflowing.push([btn.callbackData, bytes]);
        }
      }
    }
    expect(overflowing).toEqual([]);
  });
});
