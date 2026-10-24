import { describe, expect, it } from "bun:test";
import { SimilarityIndex, searchTokens, type CorpusTicket } from "./similar-finder";

const t = (
  identifier: string,
  title: string,
  causeCluster?: string,
  extra: Partial<CorpusTicket> = {},
): CorpusTicket => ({
  identifier,
  title,
  causeCluster,
  ...extra,
});

// Mô phỏng đúng tình huống TECH-920: nhiều cụm cùng triệu chứng "không lên được đơn".
const CORPUS: CorpusTicket[] = [
  t("TECH-769", "CRM báo trùng tài khoản con khi lên đơn", "TECH-337", {
    humanCause: "Bị gắn trùng tk học do cùng tên",
    humanFix: "Gỡ tk học 1 con bị trùng & thêm chữ BỎ",
    resolvedAt: "2026-09-21T09:00:00Z",
  }),
  t("TECH-775", "Không tạo được đơn do trùng tài khoản con", "TECH-337", {
    resolvedAt: "2026-09-22T09:00:00Z",
  }),
  t("TECH-337", "Không thể lên đơn do trùng tên con và tài khoản Vuihoc", "TECH-337", {
    resolvedAt: "2026-09-01T09:00:00Z",
  }),
  t("TECH-909", "Tài khoản con bị trùng, sale không lên được đơn", "TECH-337", {
    resolvedAt: "2026-09-25T09:00:00Z",
  }),
  t("TECH-840", "Không tạo được đơn với số điện thoại trên OMS", "TECH-813"),
  t("TECH-703", "Web Vuihoc chậm, không vào được lớp", "TECH-703"),
  t("TECH-704", "Web vuihoc quay vòng không vào học được", "TECH-703"),
  t("TECH-600", "Phụ huynh không đăng nhập được app", undefined),
];

describe("searchTokens", () => {
  it("bỏ dấu, mở viết tắt, thêm cặp từ đôi, bỏ số", () => {
    const tk = searchTokens("Trùng tk học 0900000018");
    expect(tk).toContain("trung");
    expect(tk).toContain("tai_khoan");
    expect(tk).toContain("hoc");
    expect(tk.some((x) => /\d{5,}/.test(x))).toBe(false);
  });
});

// SimilarityIndex giờ CHỈ còn là kênh ứng viên BM25 thuần — không còn bỏ phiếu
// cụm/ngưỡng tự quyết định (chuyển sang lib/kg/similar-ticket-source.ts +
// similar-judge.ts, xem docs/superpowers/specs/2026-09-26-ticket-tuong-tu-design.md).
describe("SimilarityIndex.search", () => {
  const index = new SimilarityIndex(CORPUS);

  it("trả về ticket khớp chữ nhất trước, không quan tâm cụm", () => {
    const hits = index.search("bị trùng tài khoản con, sale không lên được đơn");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.ticket.identifier)).toContain("TECH-909");
  });

  it("loại excludeIds", () => {
    const hits = index.search("bị trùng tài khoản con, sale không lên được đơn", {
      excludeIds: ["TECH-909"],
    });
    expect(hits.map((h) => h.ticket.identifier)).not.toContain("TECH-909");
  });

  it("cắt ở topN", () => {
    const hits = index.search("trùng tài khoản không lên được đơn", { topN: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("không có chữ nào khớp → rỗng", () => {
    expect(index.search("zzzz qqqq")).toEqual([]);
    expect(index.search("")).toEqual([]);
  });

  it("size đúng bằng số ticket trong kho", () => {
    expect(index.size).toBe(CORPUS.length);
  });
});
