import { describe, expect, it } from "bun:test";
import { RelatedRecheck, corpusSignature } from "./related-recheck";

const NOW = Date.parse("2026-09-29T08:00:00Z");
const day = 24 * 3600 * 1000;

function setup(corpus: any[]) {
  const runs: number[] = [];
  const state = { corpus };
  const recheck = new RelatedRecheck({
    projectKey: "TECH",
    now: () => NOW,
    corpus: { loadSimilarityCorpus: async () => state.corpus },
    curator: { run: async (id: number) => (runs.push(id), { status: id === 3 ? "error" : "unchanged" }) as any },
    itsaplan: {
      listProjectColumns: async () => [
        { id: 1, name: "Backlog", stateType: "backlog", position: 1 },
        { id: 4, name: "Done", stateType: "completed", position: 4 },
        { id: 5, name: "Canceled", stateType: "canceled", position: 5 },
      ] as any,
      // Như Itsaplan thật: danh sách KHÔNG có createdAt, phải đọc chi tiết.
      getIssue: async (id: number) => ({ id, createdAt: new Date(NOW - (id === 4 ? 30 : 2) * day).toISOString() }) as any,
      listProjectIssues: async () =>
        [
          { id: 1, columnId: 1 },
          { id: 2, columnId: 4, createdAt: new Date(NOW - 2 * day).toISOString() },
          { id: 3, columnId: 1, createdAt: new Date(NOW - 3 * day).toISOString() },
          { id: 4, columnId: 1, createdAt: new Date(NOW - 30 * day).toISOString() },
          { id: 6, columnId: 5, createdAt: new Date(NOW - 1 * day).toISOString() },
        ] as any,
    },
  });
  return { recheck, runs, state };
}

describe("RelatedRecheck", () => {
  it("chỉ tra ticket đang mở trong cửa sổ; kho chưa đổi thì không tra lại; lỗi thì lượt sau thử lại", async () => {
    const { recheck, runs, state } = setup([{ identifier: "TECH-1", causeCluster: "TECH-1", humanCause: "a" }]);
    await recheck.sweep();
    expect(runs).toEqual([1, 3]);
    await recheck.sweep();
    expect(runs).toEqual([1, 3, 3]);
    state.corpus = [...state.corpus, { identifier: "TECH-9", causeCluster: "TECH-1", humanCause: "b" }];
    await recheck.sweep();
    expect(runs).toEqual([1, 3, 3, 1, 3]);
  });

  it("chữ ký kho đổi khi thêm ticket hoặc đổi cụm/nguyên nhân", () => {
    const a = [{ identifier: "TECH-1", causeCluster: "TECH-1", humanCause: "x" }] as any;
    expect(corpusSignature(a)).toBe(corpusSignature([...a]));
    expect(corpusSignature(a)).not.toBe(corpusSignature([{ ...a[0], causeCluster: "TECH-2" }] as any));
    expect(corpusSignature(a)).not.toBe(corpusSignature([{ ...a[0], humanCause: "xyz" }] as any));
  });
});
