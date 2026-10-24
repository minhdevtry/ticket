import { describe, expect, it } from "bun:test";
import { DIFFERENT_CAUSE_SIMILARITY, planRelatedTickets, planSuggestedTickets, type RelatedTarget } from "./related-plan";
import type { CorpusTicket } from "./similar-finder";

// KG: cụm A "trùng tk học do cùng tên", cụm B "đối tượng liên hệ = Con", cụm C "id đơn > 1 triệu".
const KG: CorpusTicket[] = [
  { identifier: "TECH-337", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
  { identifier: "TECH-769", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
  { identifier: "TECH-616", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học cho con cùng tên" },
  { identifier: "TECH-868", title: "", causeCluster: "B", humanCause: "Do HS đăng ký qua App Vuihoc chọn là Học sinh nên đối tượng liên hệ = Con" },
  { identifier: "TECH-840", title: "", causeCluster: "C", humanCause: "Do id đơn hàng bị > 1 triệu" },
  { identifier: "TECH-728", title: "", causeCluster: "TECH-728" }, // chưa có nguyên nhân người viết
];

const target = (over: Partial<RelatedTarget> = {}): RelatedTarget => ({
  identifier: "TECH-920",
  humanCause: "Bị gắn trùng tk học do cùng tên",
  positives: [],
  negatives: [],
  fieldKeys: [],
  links: [],
  ...over,
});

describe("planRelatedTickets", () => {
  it("chưa có nguyên nhân người viết → không đụng gì (giữ gợi ý lúc tạo ticket)", () => {
    const p = planRelatedTickets(target({ humanCause: undefined, fieldKeys: ["TECH-840"] }), KG);
    expect(p.clusterId).toBeNull();
    expect(p.fieldValue).toBeNull();
    expect(p.addLinks).toEqual([]);
    expect(p.removeLinks).toEqual([]);
  });

  it("đủ cả cụm cùng nguyên nhân, trường Related Tickets có cả mã chính nó (tech lead dặn 22/09)", () => {
    const p = planRelatedTickets(target(), KG);
    expect(p.clusterId).toBe("A");
    expect(p.desired).toEqual(["TECH-337", "TECH-616", "TECH-769"]);
    expect(p.fieldValue).toBe("TECH-337, TECH-616, TECH-769, TECH-920");
    expect(p.addLinks).toEqual(["TECH-337", "TECH-616", "TECH-769"]);
  });

  it("gỡ link bot gắn sang ticket đã biết là KHÁC nguyên nhân; giữ link người gắn và ticket chưa rõ nguyên nhân", () => {
    const p = planRelatedTickets(
      target({
        fieldKeys: ["TECH-337", "TECH-840", "TECH-868", "TECH-728", "TEST-KG-TAXON-A-1"],
        links: [
          { identifier: "TECH-337", linkId: 1, addedByHuman: false },
          { identifier: "TECH-840", linkId: 2, addedByHuman: false },
          { identifier: "TECH-868", linkId: 3, addedByHuman: true },
          { identifier: "TECH-728", linkId: 4, addedByHuman: false },
        ],
      }),
      KG,
    );
    expect(p.removeLinks).toEqual([{ identifier: "TECH-840", linkId: 2 }]);
    // 868 người gắn → giữ; 728 chưa rõ nguyên nhân → không dám gỡ; mã test → bỏ.
    expect(p.fieldValue).toBe("TECH-337, TECH-616, TECH-728, TECH-769, TECH-868, TECH-920");
    expect(p.addLinks).toEqual(["TECH-616", "TECH-769"]);
  });

  it("người đã gỡ link với một ticket trong cụm → coi là loại khác, không nhận cả cụm đó", () => {
    const p = planRelatedTickets(target({ negatives: ["TECH-616"] }), KG);
    expect(p.clusterId).toBeNull();
    expect(p.desired).toEqual([]);
  });

  it("người gắn thêm (dương) luôn có mặt dù khác cụm", () => {
    const p = planRelatedTickets(target({ positives: ["TECH-868"] }), KG);
    expect(p.desired).toEqual(["TECH-337", "TECH-616", "TECH-769", "TECH-868"]);
  });

  it("câu nguyên nhân không giống cụm nào → chỉ giữ tín hiệu người, không đoán", () => {
    const p = planRelatedTickets(target({ humanCause: "Do sale bấm nhầm nút huỷ đơn" }), KG);
    expect(p.clusterId).toBeNull();
    expect(p.desired).toEqual([]);
    expect(p.addLinks).toEqual([]);
  });

  it("đã đủ và đúng rồi thì không ghi gì (chạy lại nhiều lần vẫn vậy)", () => {
    const p = planRelatedTickets(
      target({
        fieldKeys: ["TECH-920", "TECH-769", "TECH-616", "TECH-337"],
        links: ["TECH-337", "TECH-616", "TECH-769"].map((identifier, i) => ({ identifier, linkId: i, addedByHuman: false })),
      }),
      KG,
    );
    expect(p.fieldValue).toBeNull();
    expect(p.addLinks).toEqual([]);
    expect(p.removeLinks).toEqual([]);
  });

  it("khác cụm nhưng câu nguyên nhân giống (như TECH-909) → không thêm vào desired nhưng KHÔNG gỡ link/trường", () => {
    const kgWith909: CorpusTicket[] = [
      ...KG,
      { identifier: "TECH-909", title: "", causeCluster: "D", humanCause: "Bị gắn trùng tk học do cùng tên" },
    ];
    const p = planRelatedTickets(
      target({
        fieldKeys: ["TECH-909"],
        links: [{ identifier: "TECH-909", linkId: 9, addedByHuman: false }],
      }),
      kgWith909,
    );
    expect(p.clusterId).toBe("A");
    expect(p.desired).not.toContain("TECH-909");
    expect(p.removeLinks).toEqual([]);
    expect(p.fieldValue).toContain("TECH-909");
  });

  it("target TECH-920 có trong corpus cụm A (3 ticket), thêm cụm D 1 ticket câu y hệt → chọn A", () => {
    const corpusWithSelfInA: CorpusTicket[] = [
      { identifier: "TECH-909", title: "", causeCluster: "D", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-920", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-337", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-769", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-616", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học cho con cùng tên" },
    ];
    const p = planRelatedTickets(target({ identifier: "TECH-920" }), corpusWithSelfInA);
    expect(p.clusterId).toBe("A");
    expect(p.desired).toEqual(["TECH-337", "TECH-616", "TECH-769"]);
  });

  it("hoà điểm khi self không có trong corpus → chọn cụm đông hơn", () => {
    // Cụm D 1 ticket đứng trước trong corpus, cụm A 3 ticket đứng sau, câu y hệt
    const corpusWithoutSelf: CorpusTicket[] = [
      { identifier: "TECH-909", title: "", causeCluster: "D", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-337", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-769", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-616", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
    ];
    const p = planRelatedTickets(target({ identifier: "TECH-920" }), corpusWithoutSelf);
    expect(p.clusterId).toBe("A");
    expect(p.desired).toEqual(["TECH-337", "TECH-616", "TECH-769"]);
  });

  it("âm phía bên kia: corpus có ticket X cùng câu nguyên nhân với target và negatives: [target] → X không vào desired, cụm của X không được chọn", () => {
    const corpusWithNegativeX: CorpusTicket[] = [
      {
        identifier: "TECH-922",
        title: "",
        causeCluster: "CL-X",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: ["TECH-920"],
      },
    ];
    const p = planRelatedTickets(
      target({
        identifier: "TECH-920",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: [],
      }),
      corpusWithNegativeX,
    );
    expect(p.clusterId).toBeNull();
    expect(p.desired).not.toContain("TECH-922");
    expect(p.desired).toEqual([]);
  });

  it("cùng cụm KG của self: self có trong corpus với cụm S, ticket Y cụm S câu khác hẳn, link bot sang Y → không gỡ", () => {
    const corpusWithSelfAndY: CorpusTicket[] = [
      { identifier: "TECH-728", title: "", causeCluster: "S", humanCause: "Lỗi đồng bộ danh sách học sinh" },
      { identifier: "TECH-454", title: "", causeCluster: "S", humanCause: "Lỗi phân quyền giảng viên CMS hoàn toàn khác" },
    ];
    const p = planRelatedTickets(
      target({
        identifier: "TECH-728",
        humanCause: "Lỗi đồng bộ danh sách học sinh",
        fieldKeys: ["TECH-454"],
        links: [{ identifier: "TECH-454", linkId: 101, addedByHuman: false }],
      }),
      corpusWithSelfAndY,
    );
    expect(p.removeLinks).toEqual([]);
  });

  it("câu lệch nhẹ: target câu 'Bị gắn trùng tk học do cts có nhiều con trùng tên' thuộc cụm A (A có câu 'Bị gắn trùng tk học do cùng tên'); Z cụm D câu 'Bị gắn trùng tk học do cùng tên'; link bot sang Z → không gỡ", () => {
    const corpusForFuzzy: CorpusTicket[] = [
      { identifier: "TECH-489", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cts có nhiều con trùng tên" },
      { identifier: "TECH-337", title: "", causeCluster: "A", humanCause: "Bị gắn trùng tk học do cùng tên" },
      { identifier: "TECH-909", title: "", causeCluster: "D", humanCause: "Bị gắn trùng tk học do cùng tên" },
    ];
    const p = planRelatedTickets(
      target({
        identifier: "TECH-489",
        humanCause: "Bị gắn trùng tk học do cts có nhiều con trùng tên",
        fieldKeys: ["TECH-909"],
        links: [{ identifier: "TECH-909", linkId: 202, addedByHuman: false }],
      }),
      corpusForFuzzy,
    );
    expect(p.removeLinks).toEqual([]);
  });

  it("741/612: target câu 741 (cụm A, không có 612), corpus có 612 cụm B câu 612, link bot sang 612 → GỠ (tech lead muốn giữ thì tự gắn link; link người gắn không bao giờ bị gỡ)", () => {
    const corpus741: CorpusTicket[] = [
      {
        identifier: "TECH-741",
        title: "",
        causeCluster: "A",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
      },
      {
        identifier: "TECH-742",
        title: "",
        causeCluster: "A",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
      },
      {
        identifier: "TECH-612",
        title: "",
        causeCluster: "B",
        humanCause: "Do chưa mở khóa học GS Toán THPT sau khi chuyển phí",
      },
    ];
    // Link bot gắn sang 612 (sim 0.5 < 0.6) → tự gỡ khi chốt vì bỏ vùng xám.
    // Nếu tech lead muốn giữ thì tự gắn link (addedByHuman: true), link người gắn không bao giờ bị gỡ.
    const p = planRelatedTickets(
      target({
        identifier: "TECH-741",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
        fieldKeys: ["TECH-612"],
        links: [{ identifier: "TECH-612", linkId: 612, addedByHuman: false }],
      }),
      corpus741,
    );
    expect(p.removeLinks).toEqual([{ identifier: "TECH-612", linkId: 612 }]);
    expect(p.fieldValue).not.toContain("TECH-612");
    expect(p.fieldValue).toBe("TECH-741, TECH-742");

    // Đối chứng: nếu link do người gắn (addedByHuman = true) thì KHÔNG bao giờ bị gỡ
    const pHuman = planRelatedTickets(
      target({
        identifier: "TECH-741",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
        fieldKeys: ["TECH-612"],
        links: [{ identifier: "TECH-612", linkId: 612, addedByHuman: true }],
      }),
      corpus741,
    );
    expect(pHuman.removeLinks).toEqual([]);
    expect(pHuman.fieldValue).toContain("TECH-612");
  });

  it("người đã tách: link bot sang X, X ∈ target.negatives, câu X giống hệt target → vẫn gỡ link, bỏ khỏi trường", () => {
    const corpus: CorpusTicket[] = [
      {
        identifier: "TECH-337",
        title: "",
        causeCluster: "A",
        humanCause: "Bị gắn trùng tk học do cùng tên",
      },
    ];
    const p = planRelatedTickets(
      target({
        identifier: "TECH-920",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: ["TECH-337"],
        fieldKeys: ["TECH-337"],
        links: [{ identifier: "TECH-337", linkId: 10, addedByHuman: false }],
      }),
      corpus,
    );
    expect(p.removeLinks).toEqual([{ identifier: "TECH-337", linkId: 10 }]);
    expect(p.fieldValue).toBe("");
  });

  it("âm phía kia: link bot sang Y, Y.negatives chứa target → gỡ", () => {
    const corpus: CorpusTicket[] = [
      {
        identifier: "TECH-922",
        title: "",
        causeCluster: "B",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: ["TECH-920"],
      },
    ];
    const p = planRelatedTickets(
      target({
        identifier: "TECH-920",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: [],
        fieldKeys: ["TECH-922"],
        links: [{ identifier: "TECH-922", linkId: 20, addedByHuman: false }],
      }),
      corpus,
    );
    expect(p.removeLinks).toEqual([{ identifier: "TECH-922", linkId: 20 }]);
    expect(p.fieldValue).toBe("");
  });

  it("khác hẳn: câu 'Do id đơn hàng bị > 1 triệu' vs 'Bị gắn trùng tk học do cùng tên' → gỡ", () => {
    const corpus: CorpusTicket[] = [
      {
        identifier: "TECH-840",
        title: "",
        causeCluster: "C",
        humanCause: "Do id đơn hàng bị > 1 triệu",
      },
    ];
    const p = planRelatedTickets(
      target({
        identifier: "TECH-920",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: [],
        fieldKeys: ["TECH-840"],
        links: [{ identifier: "TECH-840", linkId: 30, addedByHuman: false }],
      }),
      corpus,
    );
    expect(p.removeLinks).toEqual([{ identifier: "TECH-840", linkId: 30 }]);
    expect(p.fieldValue).toBe("");
  });

  it("hằng số DIFFERENT_CAUSE_SIMILARITY = 0.6 và nhận options.differentSimilarity ghi đè", () => {
    expect(DIFFERENT_CAUSE_SIMILARITY).toBe(0.6);
    const corpus741: CorpusTicket[] = [
      {
        identifier: "TECH-742",
        title: "",
        causeCluster: "A",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
      },
      {
        identifier: "TECH-612",
        title: "",
        causeCluster: "B",
        humanCause: "Do chưa mở khóa học GS Toán THPT sau khi chuyển phí",
      },
    ];
    // Với mặc định mới (0.6), 612 (sim 0.5) bị gỡ vì bỏ vùng xám
    const pDefault = planRelatedTickets(
      target({
        identifier: "TECH-741",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
        fieldKeys: ["TECH-612"],
        links: [{ identifier: "TECH-612", linkId: 612, addedByHuman: false }],
      }),
      corpus741,
    );
    expect(pDefault.removeLinks).toEqual([{ identifier: "TECH-612", linkId: 612 }]);

    // Với ngưỡng ghi đè 0.3 (vùng xám cũ), 612 không bị gỡ
    const pOverride = planRelatedTickets(
      target({
        identifier: "TECH-741",
        humanCause: "Do mở thiếu khóa học GS Tiếng Anh TH sau khi chuyển phí",
        fieldKeys: ["TECH-612"],
        links: [{ identifier: "TECH-612", linkId: 612, addedByHuman: false }],
      }),
      corpus741,
      { differentSimilarity: 0.3 },
    );
    expect(pOverride.removeLinks).toEqual([]);
  });
});

describe("planSuggestedTickets", () => {
  it("(1) rác bot 30 mã + link bot, gợi ý = cụm A 3 mã → trường = A + self, gỡ link bot ngoài A, giữ link người gắn", () => {
    const botKeys = Array.from({ length: 30 }, (_, i) => `TECH-${1001 + i}`);
    const botLinks = botKeys.map((id, i) => ({ identifier: id, linkId: i + 1, addedByHuman: false }));
    const humanLink = { identifier: "TECH-337", linkId: 999, addedByHuman: true };

    const suggestedA = {
      clusterId: "A",
      members: [
        { identifier: "TECH-337" },
        { identifier: "TECH-616" },
        { identifier: "TECH-769" },
      ],
    };

    const p = planSuggestedTickets(
      target({
        identifier: "TECH-920",
        fieldKeys: botKeys,
        links: [...botLinks, humanLink],
        positives: [],
      }),
      KG,
      suggestedA,
    );

    expect(p.clusterId).toBe("A");
    expect(p.desired).toEqual(["TECH-337", "TECH-616", "TECH-769"]);
    expect(p.fieldValue).toBe("TECH-337, TECH-616, TECH-769, TECH-920");
    // Gỡ 30 link bot ngoài A
    expect(p.removeLinks).toHaveLength(30);
    expect(p.removeLinks).toEqual(botLinks.map((l) => ({ identifier: l.identifier, linkId: l.linkId })));
    // Giữ link người gắn TECH-337
    expect(p.removeLinks.some((l) => l.identifier === "TECH-337")).toBe(false);
    // Thêm link thiếu trong desired (616 và 769, 337 đã có)
    expect(p.addLinks).toEqual(["TECH-616", "TECH-769"]);
  });

  it("(2) gợi ý null → trường chỉ còn mã người (hoặc \"\"), gỡ hết link bot, giữ link người", () => {
    const botKeys = Array.from({ length: 30 }, (_, i) => `TECH-${1001 + i}`);
    const botLinks = botKeys.map((id, i) => ({ identifier: id, linkId: i + 1, addedByHuman: false }));

    // Trường hợp 2a: không có mã người → trường rỗng "", gỡ hết link bot
    const pNoHuman = planSuggestedTickets(
      target({
        identifier: "TECH-920",
        fieldKeys: botKeys,
        links: botLinks,
        positives: [],
      }),
      KG,
      null,
    );
    expect(pNoHuman.clusterId).toBeNull();
    expect(pNoHuman.desired).toEqual([]);
    expect(pNoHuman.fieldValue).toBe("");
    expect(pNoHuman.removeLinks).toEqual(botLinks.map((l) => ({ identifier: l.identifier, linkId: l.linkId })));
    expect(pNoHuman.addLinks).toEqual([]);

    // Trường hợp 2b: có mã người và link người → trường chỉ còn mã người + self, giữ link người
    const humanLink = { identifier: "TECH-868", linkId: 888, addedByHuman: true };
    const pHuman = planSuggestedTickets(
      target({
        identifier: "TECH-920",
        fieldKeys: [...botKeys, "TECH-868"],
        links: [...botLinks, humanLink],
        positives: ["TECH-868"],
      }),
      KG,
      null,
    );
    expect(pHuman.clusterId).toBeNull();
    expect(pHuman.desired).toEqual(["TECH-868"]);
    expect(pHuman.fieldValue).toBe("TECH-868, TECH-920");
    expect(pHuman.removeLinks).toEqual(botLinks.map((l) => ({ identifier: l.identifier, linkId: l.linkId })));
    expect(pHuman.removeLinks.some((l) => l.identifier === "TECH-868")).toBe(false);
    expect(pHuman.addLinks).toEqual([]);
  });

  it("(3) negatives hai phía loại khỏi desired", () => {
    const corpusWithNegative: CorpusTicket[] = [
      ...KG,
      {
        identifier: "TECH-769",
        title: "",
        causeCluster: "A",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negatives: ["TECH-920"], // Phía kia gỡ TECH-920
      },
    ];

    const suggestedA = {
      clusterId: "A",
      members: [
        { identifier: "TECH-337" },
        { identifier: "TECH-616" },
        { identifier: "TECH-769" },
      ],
    };

    const p = planSuggestedTickets(
      target({
        identifier: "TECH-920",
        fieldKeys: ["TECH-337", "TECH-616", "TECH-769"],
        negatives: ["TECH-616"], // Phía target gỡ TECH-616
        links: [
          { identifier: "TECH-337", linkId: 1, addedByHuman: false },
          { identifier: "TECH-616", linkId: 2, addedByHuman: false },
          { identifier: "TECH-769", linkId: 3, addedByHuman: false },
        ],
      }),
      corpusWithNegative,
      suggestedA,
    );

    // Cả 616 (từ target) lẫn 769 (từ corpus hai phía) đều bị loại khỏi desired
    expect(p.desired).toEqual(["TECH-337"]);
    expect(p.fieldValue).toBe("TECH-337, TECH-920");
    // Link bot sang 616 và 769 bị gỡ vì không còn trong desired
    expect(p.removeLinks).toEqual([
      { identifier: "TECH-616", linkId: 2 },
      { identifier: "TECH-769", linkId: 3 },
    ]);
  });

  it("(4) ticket Done chưa ghim có 30 mã bot, gợi ý cụm A (3 mã, 1 mã trong đó đang có) → trường = mã đó + self, addLinks rỗng, gỡ link bot còn lại; ticket mở → như cũ (thêm đủ)", () => {
    const botKeys = Array.from({ length: 30 }, (_, i) => `TECH-${1001 + i}`);
    const botLinks = botKeys.map((id, i) => ({ identifier: id, linkId: i + 1, addedByHuman: false }));
    const existingMember = "TECH-337";
    const existingLink = { identifier: existingMember, linkId: 999, addedByHuman: false };

    const suggestedA = {
      clusterId: "A",
      members: [
        { identifier: "TECH-337" },
        { identifier: "TECH-616" },
        { identifier: "TECH-769" },
      ],
    };

    // 4a: ticket Done chưa ghim (cleanupOnly: true)
    const pDone = planSuggestedTickets(
      target({
        identifier: "TECH-920",
        fieldKeys: [...botKeys, existingMember],
        links: [...botLinks, existingLink],
        positives: [],
      }),
      KG,
      suggestedA,
      { cleanupOnly: true },
    );

    // desired = (gợi ý ∩ mã/link đang có) = {TECH-337}
    expect(pDone.desired).toEqual(["TECH-337"]);
    // trường = mã đó + self
    expect(pDone.fieldValue).toBe("TECH-337, TECH-920");
    // addLinks rỗng
    expect(pDone.addLinks).toEqual([]);
    // gỡ link bot còn lại (30 link bot)
    expect(pDone.removeLinks).toHaveLength(30);
    expect(pDone.removeLinks.every((l) => botKeys.includes(l.identifier))).toBe(true);
    expect(pDone.removeLinks.some((l) => l.identifier === existingMember)).toBe(false);

    // 4b: ticket mở (cleanupOnly: false) → như cũ (thêm đủ)
    const pOpen = planSuggestedTickets(
      target({
        identifier: "TECH-920",
        fieldKeys: [...botKeys, existingMember],
        links: [...botLinks, existingLink],
        positives: [],
      }),
      KG,
      suggestedA,
      { cleanupOnly: false },
    );

    expect(pOpen.desired).toEqual(["TECH-337", "TECH-616", "TECH-769"]);
    expect(pOpen.fieldValue).toBe("TECH-337, TECH-616, TECH-769, TECH-920");
    // Thêm đủ link còn thiếu (616 và 769)
    expect(pOpen.addLinks).toEqual(["TECH-616", "TECH-769"]);
    // Gỡ 30 link bot ngoài cụm A
    expect(pOpen.removeLinks).toHaveLength(30);
  });
});
