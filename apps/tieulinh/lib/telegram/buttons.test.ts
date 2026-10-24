import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, expect, test } from "bun:test";
import {
  getConfirmationButtons,
  getDepartmentButtons,
  getBranchButtons,
  toTelegramButtons,
  savePendingButtons,
  clearPendingButtons,
} from "./buttons";

describe("getConfirmationButtons", () => {
  test("dùng đúng chữ được truyền vào, callback_data cố định 'đúng rồi'", () => {
    const buttons = getConfirmationButtons("Đúng rồi, gửi Product team");
    expect(buttons).toEqual([[{ text: "Đúng rồi, gửi Product team", callback_data: "đúng rồi" }]]);
  });
});

describe("getDepartmentButtons", () => {
  test("xếp options thành hàng đôi, giữ đúng label và callback_data truyền vào", () => {
    const options = [
      { label: "Vận hành", callbackData: "Vận hành" },
      { label: "Vận đơn", callbackData: "Vận đơn" },
      { label: "CSKH", callbackData: "CSKH" },
      { label: "CSHV", callbackData: "CSHV" },
      { label: "Chuyên môn", callbackData: "Chuyên môn" },
      { label: "Sale", callbackData: "Sale" },
      { label: "Quản lý lớp", callbackData: "Quản lý lớp" },
    ];
    const buttons = getDepartmentButtons(options);

    expect(buttons).toHaveLength(4);
    expect(buttons.flat()).toHaveLength(7);
    expect(buttons.flat().map((b) => b.text)).toEqual(options.map((o) => o.label));
  });

  test("không tự bịa thêm hay bớt phòng ban nào so với danh sách truyền vào", () => {
    const buttons = getDepartmentButtons([{ label: "Marketing", callbackData: "Marketing" }]);
    expect(buttons.flat()).toEqual([{ text: "Marketing", callback_data: "Marketing" }]);
  });
});

describe("getBranchButtons", () => {
  test("trả về danh sách 3 nút nhánh chuẩn cho IRIS", () => {
    const buttons = getBranchButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons.flat().map((b) => b.callback_data)).toEqual([
      "Order tính năng",
      "Đề xuất ý tưởng mới",
      "Kiểm tra trạng thái ticket",
    ]);
  });
});

describe("toTelegramButtons", () => {
  test("đổi callbackData -> callback_data, giữ nguyên text và bố cục hàng", () => {
    const rows = [
      [
        { text: "📢 Marketing", callbackData: "Marketing" },
        { text: "⚙️ Vận hành", callbackData: "Vận hành" },
      ],
      [{ text: "✍️ Khác", callbackData: "Khác" }],
    ];
    const buttons = toTelegramButtons(rows);
    expect(buttons).toEqual([
      [
        { text: "📢 Marketing", callback_data: "Marketing" },
        { text: "⚙️ Vận hành", callback_data: "Vận hành" },
      ],
      [{ text: "✍️ Khác", callback_data: "Khác" }],
    ]);
  });
});

describe("savePendingButtons & clearPendingButtons", () => {
  const testTid = "9999999999";
  const filePath = path.join(os.homedir(), ".vhbot", "iris-nut-bam", `${testTid}.json`);

  test("savePendingButtons ghi file JSON chứa danh sách nút", () => {
    const buttons = getBranchButtons();
    savePendingButtons(testTid, buttons);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.buttons).toEqual(buttons);
    expect(content.ts).toBeGreaterThan(0);
  });

  test("clearPendingButtons xóa file nút tạm", () => {
    clearPendingButtons(testTid);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

