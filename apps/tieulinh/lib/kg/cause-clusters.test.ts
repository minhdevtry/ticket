import { describe, expect, it } from "bun:test";
import { buildCauseClusters, causeSimilarity } from "./cause-clusters";

const node = (
  id: string,
  humanCause?: string,
  positives: string[] = [],
  negatives: string[] = [],
) => ({
  id,
  humanCause,
  positives,
  negatives,
});

describe("causeSimilarity", () => {
  it("cùng mẫu câu tech lead, khác vài chữ → giống", () => {
    expect(
      causeSimilarity("Bị gắn trùng tk học do cùng tên", "Bị gắn trùng tk học cho con cùng tên"),
    ).toBeGreaterThanOrEqual(0.6);
  });
  it("tech lead tách 'khi book test cho con chưa có tk' thành nguyên nhân khác → không đủ giống", () => {
    expect(
      causeSimilarity(
        "Bị gắn trùng tk học do cùng tên",
        "Bị gắn trùng tk học khi book lịch test cho con cùng tên & chưa có tk học",
      ),
    ).toBeLessThan(0.6);
  });
  it("bỏ tiền tố 'Chưa rõ nguyên nhân', dấu, số dài", () => {
    expect(
      causeSimilarity(
        "Chưa rõ nguyên nhân - HS GS Toán 1:10 bị mất dòng bên ERP 12345678",
        "HS GS Toán 1:10 bị mất dòng bên ERP 87654321",
      ),
    ).toBe(1);
  });
  it("thiếu câu → 0", () => {
    expect(causeSimilarity(undefined, "x y z")).toBe(0);
  });
});

describe("buildCauseClusters", () => {
  it("gộp câu nguyên nhân giống nhau; mã cụm là ticket nhỏ nhất", () => {
    const c = buildCauseClusters([
      node("TECH-920", "Bị gắn trùng tk học do cùng tên"),
      node("TECH-769", "Bị gắn trùng tk học do cùng tên"),
      node("TECH-616", "Bị gắn trùng tk học cho con cùng tên"),
      node("TECH-840", "Do id đơn hàng bị > 1 triệu"),
    ]);
    expect(c.get("TECH-920")).toBe("TECH-616");
    expect(c.get("TECH-769")).toBe("TECH-616");
    expect(c.get("TECH-840")).toBe("TECH-840");
  });

  it("người gỡ link giữa hai ticket → không bao giờ chung cụm, kể cả câu giống hệt", () => {
    const c = buildCauseClusters([
      node("TECH-1", "Do hệ thống web vuihoc bị cao tải"),
      node("TECH-2", "Do hệ thống web vuihoc bị cao tải", [], ["TECH-3"]),
      node("TECH-3", "Do hệ thống web vuihoc bị cao tải"),
    ]);
    expect(c.get("TECH-2")).not.toBe(c.get("TECH-3"));
    // TECH-1 chỉ vào được một trong hai phía.
    expect([c.get("TECH-2"), c.get("TECH-3")]).toContain(c.get("TECH-1")!);
  });

  it("link người gắn gộp cả khi câu chữ khác hoặc thiếu comment ghim", () => {
    const c = buildCauseClusters([
      node("TECH-10", "Nguyên nhân A", ["TECH-11"]),
      node("TECH-11"),
      node("TECH-12", "Khác hẳn"),
    ]);
    expect(c.get("TECH-11")).toBe(c.get("TECH-10"));
    expect(c.get("TECH-12")).toBe("TECH-12");
  });

  it("tín hiệu tới ticket không có trong KG thì bỏ qua", () => {
    const c = buildCauseClusters([node("TECH-5", "x", ["TECH-999"], ["TECH-998"])]);
    expect([...c.entries()]).toEqual([["TECH-5", "TECH-5"]]);
  });
});
