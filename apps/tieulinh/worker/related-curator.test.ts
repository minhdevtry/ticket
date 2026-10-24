import { describe, expect, it } from "bun:test";
import { RelatedTicketsCurator } from "./related-curator";
import type { CorpusTicket } from "../lib/kg/similar-finder";

const PIN =
  "- **Nguyên nhân:** Bị gắn trùng tk học do cùng tên\n- **Cách khắc phục:** Gỡ tk học 1 con bị trùng & thêm chữ BỎ";
const KG: CorpusTicket[] = [
  {
    identifier: "TECH-337",
    title: "Bị gắn trùng tk học do cùng tên",
    causeCluster: "A",
    humanCause: "Bị gắn trùng tk học do cùng tên",
  },
  {
    identifier: "TECH-769",
    title: "Bị gắn trùng tk học do cùng tên",
    causeCluster: "A",
    humanCause: "Bị gắn trùng tk học do cùng tên",
  },
  {
    identifier: "TECH-840",
    title: "Do id đơn hàng bị > 1 triệu",
    causeCluster: "C",
    humanCause: "Do id đơn hàng bị > 1 triệu",
  },
];

function world(
  over: {
    labelIds?: number[];
    pinned?: boolean;
    identifier?: string;
    title?: string;
    description?: string;
    columnId?: number;
    burst?: boolean;
    otherSideBurst?: boolean;
  } = {},
) {
  const identifier = over.identifier ?? "TECH-920";
  const issues: Record<number, any> = {
    793: {
      id: 793,
      identifier,
      title: over.title ?? "Bị gắn trùng tk học do cùng tên",
      description: over.description ?? "### Mô tả\n> Bị gắn trùng tk học do cùng tên",
      columnId: over.columnId ?? 3,
      labelIds: over.labelIds ?? [8],
      fields: [
        { fieldId: 3, name: "Related Tickets", value: "TECH-337, TECH-840, TEST-KG-TAXON-A-1" },
      ],
      links: [
        { id: 11, issue: { id: 88, identifier: "TECH-337" } },
        { id: 12, issue: { id: 700, identifier: "TECH-840" } },
      ],
    },
    88: {
      id: 88,
      identifier: "TECH-337",
      labelIds: [],
      fields: [{ fieldId: 3, name: "Related Tickets", value: "TECH-337, TECH-769" }],
      links: [],
    },
    528: { id: 528, identifier: "TECH-769", labelIds: [], fields: [], links: [] },
    700: { id: 700, identifier: "TECH-840", labelIds: [], fields: [], links: [] },
  };
  const bySeq: Record<number, number> = { 337: 88, 769: 528, 840: 700, 920: 793 };
  const timeline = [
    {
      kind: "activity",
      action: "link_add",
      actorName: "Tiểu Linh",
      createdAt: "2026-09-26T01:39:00Z",
      payload: { to: { value: "TECH-337" } },
    },
    {
      kind: "activity",
      action: "link_add",
      actorName: "Tiểu Linh",
      createdAt: "2026-09-26T01:39:00Z",
      payload: { to: { value: "TECH-840" } },
    },
    // Đợt gắn hàng loạt của thuật toán cũ (≥ 5 link trong 2 phút, trước 26/09 15:08) = rác được phép dọn.
    ...(over.burst
      ? ["TECH-1", "TECH-2", "TECH-3"].map((v) => ({
          kind: "activity",
          action: "link_add",
          actorName: "Tiểu Linh",
          createdAt: "2026-09-26T01:39:30Z",
          payload: { to: { value: v } },
        }))
      : []),
    ...(over.pinned === false
      ? []
      : [
          {
            kind: "comment",
            pinned: true,
            actorName: "TechLead_A",
            body: PIN,
            createdAt: "2026-09-26T01:54:10Z",
          },
        ]),
  ];
  const writes: string[] = [];
  const client = {
    getIssue: async (id: number) => issues[id],
    getIssueTimeline: async (id: number) =>
      id === 793
        ? timeline
        : id === 700 && over.otherSideBurst
          ? ["TECH-920", "TECH-11", "TECH-12", "TECH-13", "TECH-14"].map((v) => ({
              kind: "activity",
              action: "link_add",
              actorName: "Tiểu Linh",
              createdAt: "2026-09-26T02:00:00Z",
              payload: { to: { value: v } },
            }))
          : [],
    getIssueByNumber: async (_p: string, seq: number) => issues[bySeq[seq]],
    getProject: async () => ({
      labels: [
        { id: 8, name: "Hỗ trợ" },
        { id: 9, name: "IT Support" },
      ],
    }),
    listProjectColumns: async () => [
      { id: 3, name: "Đang xử lý", stateType: "in_progress" },
      { id: 4, name: "Done", stateType: "completed" },
      { id: 5, name: "Huỷ", stateType: "canceled" },
    ],
    listCustomFields: async () => [{ id: 3, name: "Related Tickets", fieldType: "markdown" }],
    setCustomFieldValue: async (id: number, fieldId: number, value: string) =>
      void writes.push(`field #${id} f${fieldId} = ${value}`),
    addLink: async (from: number, to: number) => {
      writes.push(`link ${from}→${to}`);
      return { id: 1, kind: "relates" };
    },
    deleteLink: async (id: number, linkId: number) =>
      void writes.push(`unlink #${id} link${linkId}`),
  };
  const corpus = { loadSimilarityCorpus: async () => KG };
  // Mô phỏng SimilarTicketSource mới (KG + Onyx + BM25 + LLM) cho mode "suggested":
  // tái hiện đúng gợi ý mà thuật toán BM25 cũ từng trả cho fixture này (cụm A = 337+769),
  // để các test suggested/cleanupOnly hiện có không phải đổi kỳ vọng.
  const similarSource = {
    calls: [] as Array<{ text: string; excludeIds?: string[] }>,
    find: async (text: string, opts?: { excludeIds?: string[] }) => {
      similarSource.calls.push({ text, excludeIds: opts?.excludeIds });
      return { clusterId: "A", share: 1, members: KG.filter((k) => k.causeCluster === "A") };
    },
  };
  return { client, corpus, writes, similarSource };
}

const make = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
  new RelatedTicketsCurator({
    itsaplan: w.client as any,
    corpus: w.corpus,
    similarSource: w.similarSource as any,
    projectKey: "TECH",
    ...over,
  });

describe("RelatedTicketsCurator.run", () => {
  it("có nguyên nhân ghim → đủ cụm (có cả mã chính nó), gỡ link bot sai, thêm mã mới vào ticket cũ cùng cụm", async () => {
    const w = world();
    const r = await make(w).run(793);
    expect(r.status).toBe("applied");
    expect(r.mode).toBe("pinned");
    expect(w.writes).toEqual([
      "field #793 f3 = TECH-337, TECH-769, TECH-920",
      "link 793→528",
      "unlink #793 link12",
      "field #88 f3 = TECH-337, TECH-769, TECH-920",
      "field #528 f3 = TECH-769, TECH-920",
    ]);
  });

  it("chạy thử (dryRun) → không ghi gì, trả kế hoạch", async () => {
    const w = world();
    const r = await make(w, { dryRun: true }).run(793);
    expect(r.status).toBe("dry_run");
    expect(r.mode).toBe("pinned");
    expect(r.plan?.desired).toEqual(["TECH-337", "TECH-769"]);
    expect(r.propagate).toEqual(["TECH-337", "TECH-769"]);
    expect(w.writes).toEqual([]);
  });

  it("ticket không ghim → mode 'suggested', ghi đúng, không propagate ở nhánh suggested", async () => {
    const w = world({ pinned: false, burst: true });
    const r = await make(w).run(793);
    expect(r.status).toBe("applied");
    expect(r.mode).toBe("suggested");
    expect(r.propagate).toEqual([]);
    expect(w.writes).toEqual([
      "field #793 f3 = TECH-337, TECH-769, TECH-920",
      "link 793→528",
      "unlink #793 link12",
    ]);
  });

  it("ticket Done chưa ghim → cleanupOnly: chỉ bớt không thêm, addLinks rỗng, gỡ link bot", async () => {
    const w = world({ pinned: false, columnId: 4, burst: true });
    const r = await make(w).run(793);
    expect(r.status).toBe("applied");
    expect(r.mode).toBe("suggested");
    expect(r.plan?.desired).toEqual(["TECH-337"]);
    expect(r.plan?.addLinks).toEqual([]);
    expect(r.propagate).toEqual([]);
    expect(w.writes).toEqual(["field #793 f3 = TECH-337, TECH-920", "unlink #793 link12"]);
  });

  it("mode 'suggested' dùng similarSource đã tiêm (KG+Onyx+LLM mới), không tự dò BM25 nữa", async () => {
    const w = world({ pinned: false });
    // similarSource trả lời KHÁC hẳn cụm mà BM25/text-match cũ từng chọn (A, gồm 337/769)
    // để chứng minh curator thực sự dùng kết quả được tiêm vào, không tính lại nội bộ.
    w.similarSource.find = async (text: string, opts?: { excludeIds?: string[] }) => {
      w.similarSource.calls.push({ text, excludeIds: opts?.excludeIds });
      return { clusterId: "C", share: 1, members: KG.filter((k) => k.causeCluster === "C") };
    };
    const r = await make(w).run(793);
    expect(r.status).toBe("applied");
    expect(r.mode).toBe("suggested");
    expect(r.plan?.desired).toEqual(["TECH-840"]);
    expect(w.similarSource.calls).toHaveLength(1);
    expect(w.similarSource.calls[0].excludeIds).toEqual(["TECH-920"]);
    expect(w.similarSource.calls[0].text).toContain("Bị gắn trùng tk học do cùng tên");
  });

  it("mode 'suggested' không có similarSource → không gợi ý gì, chỉ dọn theo mã/link người đã gắn", async () => {
    const w = world({ pinned: false });
    const r = await new RelatedTicketsCurator({
      itsaplan: w.client as any,
      corpus: w.corpus,
      projectKey: "TECH",
    }).run(793);
    expect(r.status).toBe("applied");
    expect(r.mode).toBe("suggested");
    expect(r.plan?.desired).toEqual([]);
  });

  it("ticket IT Support xử lý như mọi ticket TECH (người dùng chốt 27/09)", async () => {
    const w = world({ labelIds: [9] });
    expect((await make(w).run(793)).status).toBe("applied");
    expect(w.writes.length).toBeGreaterThan(0);
  });

  it("ticket dự án khác → bỏ qua", async () => {
    const w = world({ identifier: "PO-12" });
    expect((await make(w).run(793)).status).toBe("other_project");
    expect(w.writes).toEqual([]);
  });

  it("schedule gộp nhiều sự kiện liền nhau thành một lần chạy", async () => {
    const w = world();
    const c = make(w, { delayMs: 20 });
    c.schedule(793);
    c.schedule(793);
    c.schedule(793);
    await Bun.sleep(80);
    expect(w.writes.filter((x) => x.startsWith("field #793"))).toHaveLength(1);
  });
  it("ticket chưa ghim: link bot LẺ (không phải đợt hàng loạt của thuật toán cũ) → KHÔNG gỡ dù gợi ý mới không có (28/09 TECH-873↔886)", async () => {
    const w = world({ pinned: false, columnId: 4 });
    const r = await make(w).run(793);
    expect(r.plan?.removeLinks).toEqual([]);
    expect(w.writes.filter((x) => x.startsWith("unlink"))).toEqual([]);
  });
  it("link bot lẻ ở phía này nhưng nằm trong đợt hàng loạt ở PHÍA KIA → vẫn là rác, gỡ (28/09 TECH-529→934)", async () => {
    const w = world({ pinned: false, columnId: 4, otherSideBurst: true });
    const r = await make(w).run(793);
    expect(r.plan?.removeLinks.map((l) => l.identifier)).toEqual(["TECH-840"]);
  });
});
