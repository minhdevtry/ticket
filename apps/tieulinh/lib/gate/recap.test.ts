import { describe, expect, test } from "bun:test";
import { fixtureCatalog } from "./catalog.fixture";
import { evaluateGate } from "./gate";
import { buildRecap } from "./recap";
import { createRecord } from "./types";

/** A conversation where the bot spent its budget on both members of a oneOf group. */
function exhaustedOneOf() {
  const record = createRecord("3", { tieu_de: "Xuất báo cáo tay", van_de: "Mỗi tháng mất 3 tiếng" });
  record.questionCount = { tan_suat: 3, quy_mo: 3 };
  return record;
}

function recapFor(values: Record<string, string>, derived?: Record<string, string>) {
  const record = createRecord("1", values);
  return buildRecap(fixtureCatalog, record, evaluateGate(fixtureCatalog, record), { derived });
}

describe("buildRecap", () => {
  test("reads back captured values in the order the catalog declares", () => {
    const recap = recapFor({ tieu_de: "Xuất báo cáo tay", van_de: "Mỗi tháng mất 3 tiếng", phong_ban: "CS" });

    expect(recap.split("\n").slice(0, 3)).toEqual([
      "- Tiêu đề: Xuất báo cáo tay",
      "- Vấn đề: Mỗi tháng mất 3 tiếng",
      "- Bộ phận: CS",
    ]);
  });

  test("never shows the user a field marked internal", () => {
    const recap = recapFor({ tieu_de: "Xuất báo cáo tay", ghi_chu_noi_bo: "Khách này hay giục" });

    expect(recap).not.toContain("Khách này hay giục");
    expect(recap).not.toContain("Ghi chú nội bộ");
  });

  test("skips a field nobody answered rather than printing an empty line", () => {
    const recap = recapFor({ tieu_de: "Xuất báo cáo tay" });
    expect(recap.split("\n").filter((l) => l.startsWith("- ") && l.endsWith(": "))).toEqual([]);
  });

  test("shows a value the app derived under its own label", () => {
    // `nhom` is filled by the app, so it has no field spec to take a label from.
    const recap = recapFor({ tieu_de: "Xuất báo cáo tay" }, { nhom: "Vận hành" });
    expect(recap).toContain("- Nhóm: Vận hành");
  });

  test("lists what the bot gave up on, so a human can follow up", () => {
    // Only questions the gate has stopped asking end up here; a field it will
    // ask again next turn is not yet an open question.
    const recap = buildRecap(fixtureCatalog, exhaustedOneOf(), evaluateGate(fixtureCatalog, exhaustedOneOf()), {});

    expect(recap).toContain("Còn thiếu, ghi lại để hỏi sau:");
    expect(recap).toContain("Chưa có Tần suất, Quy mô");
  });

  test("says nothing about open questions when everything is answered", () => {
    const recap = recapFor({
      tieu_de: "Xuất báo cáo tay",
      van_de: "Mỗi tháng mất 3 tiếng",
      phong_ban: "CS",
      he_thong: "LiveClass",
    });

    expect(recap).not.toContain("Còn thiếu");
  });

  test("uses the heading the bot chose for its own voice", () => {
    const record = exhaustedOneOf();
    const recap = buildRecap(fixtureCatalog, record, evaluateGate(fixtureCatalog, record), {
      openQuestionsHeading: "Em ghi nhận còn thiếu:",
    });

    expect(recap).toContain("Em ghi nhận còn thiếu:");
    expect(recap).not.toContain("Còn thiếu, ghi lại để hỏi sau:");
  });
});
