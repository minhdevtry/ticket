import { describe, expect, it } from "bun:test";
import { buildChecklist, ChecklistTechReviewer, CHECKLIST_CLOSING } from "./checklist-review";

const base = { attachments: 0, known: {} as Record<string, string> };

describe("ChecklistTechReviewer", () => {
  it("không có ảnh → luôn xin ảnh màn hình, một tin, kết bằng 'không có'", async () => {
    const out = await new ChecklistTechReviewer().review({
      ...base,
      description: "Không vào được app",
    });
    expect(out.missing).toContain("ảnh màn hình");
    expect(out.question).toContain("1. Ảnh chụp màn hình");
    expect(out.question?.endsWith(CHECKLIST_CLOSING)).toBe(true);
  });

  it("có ảnh đính kèm → không xin ảnh nữa", () => {
    const out = buildChecklist({ ...base, attachments: 1, description: "Không vào được app" });
    expect(out.missing).not.toContain("ảnh màn hình");
  });

  it("CARE → xin link student-detail; đã có link thì bỏ", () => {
    const ask = buildChecklist({ ...base, system: "CARE", description: "Không chuyển được phí" });
    expect(ask.missing).toContain("link chi tiết CARE");
    expect(ask.question).toContain("se-care.example.com/student-care/student-detail");
    const have = buildChecklist({
      ...base,
      system: "CARE",
      description:
        "Không chuyển được phí https://se-care.example.com/student-care/student-detail/774883?taskType=1",
    });
    expect(have.missing).not.toContain("link chi tiết CARE");
  });

  it("CRM → xin link contact, LMS/khoá → xin UID hoặc link LMS", () => {
    expect(
      buildChecklist({ ...base, system: "CRM", description: "Báo trùng tài khoản" }).missing,
    ).toContain("link contact CRM");
    expect(
      buildChecklist({ ...base, system: "LMS", description: "Sai hạn khoá Toán" }).missing,
    ).toContain("UID/link LMS");
    expect(
      buildChecklist({ ...base, system: "LMS", description: "Sai hạn khoá Toán uid: 90000009" })
        .missing,
    ).not.toContain("UID/link LMS");
  });

  it("mã đơn hàng: hỏi khi nói về đơn/hạn, bỏ khi đã có DH…", () => {
    expect(buildChecklist({ ...base, description: "Đơn chưa lên khoá" }).missing).toContain(
      "mã đơn hàng",
    );
    expect(
      buildChecklist({ ...base, description: "Đơn DH900001 chưa lên khoá" }).missing,
    ).not.toContain("mã đơn hàng");
  });

  it("không hỏi nguyên nhân, không xin mật khẩu TeamViewer", () => {
    const q =
      buildChecklist({ ...base, system: "CRM", description: "Máy tính không gọi được" }).question ??
      "";
    expect(q.toLowerCase()).not.toContain("nguyên nhân");
    expect(q.toLowerCase()).not.toContain("teamviewer");
    expect(q.toLowerCase()).not.toContain("mật khẩu");
  });

  it("việc rõ ràng không thuộc TECH (chấm công/AMIS) → không hỏi", () => {
    expect(buildChecklist({ ...base, description: "Sai công tháng này trên AMIS" })).toEqual({
      missing: [],
    });
  });

  it("báo đủ hết → missing rỗng", () => {
    const out = buildChecklist({
      ...base,
      attachments: 2,
      known: { "Tài khoản HS / SĐT": "0900000006", "Thiết bị": "iPhone" },
      description:
        "Hôm nay 9h sau khi bấm vào bài học thì app đứng; đúng ra phải mở video. đơn DH900001 uid: 123456, khoá Toán lớp 3 của học sinh Nam",
    });
    expect(out.missing).toEqual([]);
    expect(out.question).toBeUndefined();
  });
});

describe("tự học: mục học được nối thêm vào checklist", () => {
  const sample = { ...base, system: "CRM", description: "Báo trùng tài khoản" };

  it("không có mục học được → kết quả y như buildChecklist(input)", () => {
    expect(buildChecklist(sample, [])).toEqual(buildChecklist(sample));
  });

  it("mục học được chưa có dòng cố định → thêm dòng cuối, đánh số tiếp, vẫn một tin và kết bằng 'không có'", () => {
    const out = buildChecklist(sample, ["ERROR_TEXT"]);
    expect(out.missing).toContain("học thêm: ERROR_TEXT");
    expect(out.question).toContain("Nội dung thông báo lỗi hiện trên màn hình");
    const lines = out.question!.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines[lines.length - 1]).toContain("Nội dung thông báo lỗi");
    expect(out.question!.endsWith(CHECKLIST_CLOSING)).toBe(true);
  });

  it("mục đã được hỏi hoặc đã có sẵn ở dòng cố định → không lặp lại", () => {
    const asked = buildChecklist(sample, ["SCREENSHOT", "CRM_CONTACT_LINK", "STEPS", "TIME"]);
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    expect(count(asked.question!, "Ảnh chụp màn hình lỗi")).toBe(1);
    expect(count(asked.question!, "Link chi tiết contact trên se-crm")).toBe(1);
    expect(asked.missing.filter((m) => m.startsWith("học thêm"))).toEqual([]);
    const have = buildChecklist(
      {
        ...sample,
        attachments: 1,
        description: "Báo trùng https://se-crm.example.com/contact/detail/12",
      },
      ["SCREENSHOT", "CRM_CONTACT_LINK"],
    );
    expect(have.missing.some((m) => m.startsWith("học thêm"))).toBe(false);
  });

  it("OTHER và mục lạ bị bỏ qua; trùng lặp chỉ một lần", () => {
    const out = buildChecklist(sample, ["OTHER", "FOO", "ERROR_TEXT", "ERROR_TEXT"]);
    expect(out.missing.filter((m) => m.startsWith("học thêm"))).toEqual(["học thêm: ERROR_TEXT"]);
  });

  it("NOT_TECH vẫn không hỏi dù có mục học được", () => {
    expect(
      buildChecklist({ ...base, description: "Sai công tháng này trên AMIS" }, ["ERROR_TEXT"]),
    ).toEqual({ missing: [] });
  });

  it("ChecklistTechReviewer: bộ học lỗi thì vẫn hỏi như cũ", async () => {
    const reviewer = new ChecklistTechReviewer(() => {
      throw new Error("db hỏng");
    });
    const out = await reviewer.review({ ...base, description: "Không vào được app" });
    expect(out).toEqual(buildChecklist({ ...base, description: "Không vào được app" }));
  });

  it("ChecklistTechReviewer: đưa đúng hệ thống cho bộ học", async () => {
    let seen = "";
    const reviewer = new ChecklistTechReviewer((system) => {
      seen = system;
      return ["EXTENT"];
    });
    const out = await reviewer.review({
      ...base,
      system: "LMS_Vuihoc",
      description: "Sai hạn khoá Toán",
    });
    expect(seen).toBe("LMS_Vuihoc");
    expect(out.missing).toContain("học thêm: EXTENT");
  });

  it("sắp xếp theo tỉ lệ (W26): CARE có CARE_STUDENT_LINK tỉ lệ cao nhất → đứng ngay sau ảnh màn hình", () => {
    const input = { ...base, system: "CARE_Vuihoc", description: "Không chuyển phí được" };
    const shares = {
      CARE_STUDENT_LINK: 0.08,
      STUDENT_ID: 0.044,
      SCREENSHOT: 0.029,
      STEPS: 0.016,
      ORDER_CODE: 0.016,
    };
    const out = buildChecklist(input, [], shares);
    expect(out.missing[0]).toBe("ảnh màn hình");
    expect(out.missing[1]).toBe("link chi tiết CARE");
    expect(out.missing[2]).toBe("học sinh/khoá/lớp");
    expect(out.missing[3]).toBe("mã đơn hàng");
    expect(out.missing[4]).toBe("bước thao tác");
    expect(out.question).toContain("1. Ảnh chụp màn hình");
    expect(out.question).toContain("2. Link chi tiết học sinh trên se-care");
    expect(out.question).toContain("3. Học sinh nào, khoá học/lớp/buổi học");
    expect(out.question?.endsWith(CHECKLIST_CLOSING)).toBe(true);
  });

  it("ảnh màn hình luôn được ghim đầu tiên khi được hỏi, kể cả tỉ lệ thấp hơn mục khác", () => {
    const input = { ...base, system: "CARE_Vuihoc", description: "Lỗi chuyển phí" };
    const shares = {
      CARE_STUDENT_LINK: 0.5,
      SCREENSHOT: 0.01,
      STEPS: 0.2,
    };
    const out = buildChecklist(input, [], shares);
    expect(out.missing[0]).toBe("ảnh màn hình");
    expect(out.missing[1]).toBe("link chi tiết CARE");
    expect(out.missing[2]).toBe("bước thao tác");
  });

  it("đã có ảnh đính kèm → không hỏi ảnh màn hình, mục có tỉ lệ cao nhất đứng đầu", () => {
    const input = { ...base, attachments: 1, system: "CARE_Vuihoc", description: "Lỗi chuyển phí" };
    const shares = {
      CARE_STUDENT_LINK: 0.5,
      SCREENSHOT: 0.99,
      STEPS: 0.2,
    };
    const out = buildChecklist(input, [], shares);
    expect(out.missing).not.toContain("ảnh màn hình");
    expect(out.missing[0]).toBe("link chi tiết CARE");
    expect(out.missing[1]).toBe("bước thao tác");
    expect(out.question).toContain("1. Link chi tiết học sinh trên se-care");
  });

  it("hoà tỉ lệ (stable ties): giữ thứ tự base, mục học thêm cùng tỉ lệ đứng sau mục cố định", () => {
    const input = { ...base, description: "Báo lỗi chung" };
    const shares = {
      STEPS: 0.15,
      EXPECTED_VS_ACTUAL: 0.15,
      EXTENT: 0.15,
    };
    const out = buildChecklist(input, ["EXTENT"], shares);
    expect(out.missing[0]).toBe("ảnh màn hình");
    expect(out.missing[1]).toBe("bước thao tác");
    expect(out.missing[2]).toBe("đang hiện vs đúng");
    expect(out.missing[3]).toBe("học thêm: EXTENT");
  });

  it("không có tỉ lệ (hoặc tất cả bằng 0) → đầu ra trùng khớp 100% từng byte với bản cũ", () => {
    const input = { ...base, system: "CRM", description: "Báo trùng tài khoản" };
    const baseOut = buildChecklist(input);
    expect(buildChecklist(input, [], {})).toEqual(baseOut);
    expect(buildChecklist(input, [], { SCREENSHOT: 0, STEPS: 0 })).toEqual(baseOut);
    expect(buildChecklist(input, { items: [], shares: {} })).toEqual(baseOut);
  });

  it("ChecklistTechReviewer: tra cứu lỗi → không sắp xếp, kết quả như cũ", async () => {
    const reviewerThrow = new ChecklistTechReviewer(() => {
      throw new Error("Lỗi kết nối kho SQLite");
    });
    const outThrow = await reviewerThrow.review({
      ...base,
      system: "CARE_Vuihoc",
      description: "Không chuyển được phí",
    });
    expect(outThrow).toEqual(
      buildChecklist({ ...base, system: "CARE_Vuihoc", description: "Không chuyển được phí" }),
    );

    const reviewerErrResult = new ChecklistTechReviewer(() => ({ items: [], shares: {} }));
    const outErr = await reviewerErrResult.review({
      ...base,
      system: "CARE_Vuihoc",
      description: "Không chuyển được phí",
    });
    expect(outErr).toEqual(
      buildChecklist({ ...base, system: "CARE_Vuihoc", description: "Không chuyển được phí" }),
    );
  });
});
