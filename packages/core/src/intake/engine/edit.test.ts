import { describe, expect, it } from "bun:test";
import { applyEditOps, descriptionBody, planEdit } from "./edit";

const llm = { baseUrl: "", apiKey: "", model: "m" };
const DESC = `## Thông tin sự cố

- Người báo: A - telegram:1
- Tài khoản HS / SĐT: 0900000006
- Bộ phận: CSKH

### Mô tả

> Khoá gia hạn sai hạn

![a.jpg](/attachments/1/raw)

---
*Nguồn: Bot*`;

describe("sửa ticket", () => {
  it("planEdit lọc thao tác hợp lệ", async () => {
    const ops = await planEdit(
      llm,
      { title: "t", description: DESC, instruction: "x" },
      async () =>
        '{"ops":[{"type":"field","label":"Tài khoản HS / SĐT","value":"0900000015"},{"type":"bogus"},{"type":"title","value":" "}]}',
    );
    expect(ops).toEqual([{ type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" }]);
  });

  it("applyEditOps: sửa dòng có sẵn, thêm dòng mới vào cuối Thông tin sự cố, thay câu mô tả duy nhất (nhận labels tuỳ biến)", () => {
    const r = applyEditOps(
      "Cũ",
      DESC,
      [
        { type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" },
        { type: "field", label: "Mã khách hàng", value: "90000006" },
        { type: "replace", old: "Khoá gia hạn sai hạn", new: "Khoá gia hạn DH900002 sai hạn" },
        { type: "replace", old: "không có", new: "x" },
        { type: "title", value: "Mới" },
      ],
      { title: "Tiêu đề", description: "Mô tả", notPresent: "(chưa có)" },
    );
    expect(r.title).toBe("Mới");
    expect(r.description).toContain("- Tài khoản HS / SĐT: 0900000015");
    expect(r.description).toContain("- Bộ phận: CSKH\n- Mã khách hàng: 90000006\n\n### Mô tả");
    expect(r.description).toContain("> Khoá gia hạn DH900002 sai hạn");
    expect(r.rejected).toHaveLength(1);
    expect(r.changes.map((c) => c.what)).toEqual([
      "Tài khoản HS / SĐT",
      "Mã khách hàng",
      "Mô tả",
      "Tiêu đề",
    ]);
    expect(r.changes[1].before).toBe("(chưa có)");
  });

  it("applyEditOps: fallback nhãn trung lập khi không truyền labels", () => {
    const r = applyEditOps("Cũ", DESC, [
      { type: "title", value: "Mới" },
      { type: "field", label: "Trường mới", value: "Giá trị" },
      { type: "replace", old: "Khoá gia hạn sai hạn", new: "Đã sửa" },
    ]);
    expect(r.changes.map((c) => c.what)).toEqual(["Title", "Trường mới", "Description"]);
    expect(r.changes[1].before).toBe("(none)");
  });

  it("planEdit cho phép override editPrompt", async () => {
    let capturedPrompt = "";
    await planEdit(
      llm,
      { title: "t", description: DESC, instruction: "x" },
      async (_llm, prompt) => {
        capturedPrompt = prompt;
        return '{"ops":[]}';
      },
      { editPrompt: "Custom prompt" },
    );
    expect(capturedPrompt).toBe("Custom prompt");
  });

  it("descriptionBody lấy phần Mô tả và ảnh", () => {
    const { body, images } = descriptionBody(DESC);
    expect(body).toContain("> Khoá gia hạn sai hạn");
    expect(body).not.toContain("Nguồn");
    expect(images).toEqual(["![a.jpg](/attachments/1/raw)"]);
  });
});
