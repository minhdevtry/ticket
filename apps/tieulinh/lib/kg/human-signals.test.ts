import { describe, expect, it } from "bun:test";
import {
  humanLinkSignals,
  isSystemActor,
  parsePinnedKnowledge,
  pinnedKnowledgeOf,
} from "./human-signals";

// Mẫu thật của tech lead trên TECH-920 (26/09).
const PIN_920 = `Anh @TechUser_B

- **Nguyên nhân:** Bị gắn trùng tk học do cùng tên

- **Cách khắc phục:** Gỡ tk học 1 con bị trùng & thêm chữ BỎ

- **Ticket tương tự:**

  - Xem thêm các Dòng 228, 238 (sheet T06/2026) + Dòng 2, 23 (sheet T08/2026) <https://docs.google.com/x>`;

describe("isSystemActor", () => {
  it("bot, admin (script/worker), Onyx không phải người", () => {
    for (const a of [
      "Tiểu Linh",
      "VUIHOC Tiểu Linh",
      "admin",
      "Onyx Second Brain",
      "ticket-bot",
      "tieulinh",
    ]) {
      expect(isSystemActor(a)).toBe(true);
    }
  });
  it("người thật", () => {
    for (const a of ["TechLead_A", "TechUser_B", "TechUser_E"])
      expect(isSystemActor(a)).toBe(false);
  });
});

describe("parsePinnedKnowledge", () => {
  it("tách Nguyên nhân / Cách khắc phục theo mẫu comment ghim", () => {
    const k = parsePinnedKnowledge(PIN_920);
    expect(k.cause).toBe("Bị gắn trùng tk học do cùng tên");
    expect(k.fix).toBe("Gỡ tk học 1 con bị trùng & thêm chữ BỎ");
  });

  it("mục nhiều dòng (Issue 1/2) gom lại, bỏ markdown, giải mã &gt;", () => {
    const k = parsePinnedKnowledge(
      "- **Nguyên nhân:**\n  - **Issue 1:** Do id đơn hàng bị &gt; 1 triệu\n  - **Issue 2:** Chưa rõ\n- **Cách khắc phục:** Sửa code",
    );
    expect(k.cause).toBe("Issue 1: Do id đơn hàng bị > 1 triệu - Issue 2: Chưa rõ");
    expect(k.fix).toBe("Sửa code");
  });

  it("không có mục Nguyên nhân (comment ghim chỉ là lời nhắn) → không có tri thức", () => {
    const k = parsePinnedKnowledge("@tieulinh TECH check thấy đã lên đủ dữ liệu. Bạn ktra lại nhé");
    expect(k.cause).toBeUndefined();
    expect(k.fix).toBeUndefined();
  });

  it("mã TECH nhắc trong comment ghim là tín hiệu cùng nguyên nhân", () => {
    const k = parsePinnedKnowledge(
      "- **Nguyên nhân:** Bị sai số buổi (như TECH-338, TECH-405)\n- **Cách khắc phục:** x",
      "TECH-544",
    );
    expect(k.mentionedIds).toEqual(["TECH-338", "TECH-405"]);
  });

  it("nhận diện đúng nhãn và bỏ thẻ khi comment ghim có <mark>/<span> tô màu", () => {
    const body = [
      '- <mark data-color="#fef08a" style="background-color: #fef08a; color: inherit">**Nguyên nhân:**</mark> <span style="color: #ef4444">Bị gắn trùng tk học</span> do cùng tên (như <mark data-color="#bbf7d0">TECH-338</mark>)',
      '- **<span style="color: #22c55e">Cách khắc phục</span>:** Gỡ tk học <mark data-color="#fef08a">1 con bị trùng</mark>',
    ].join("\n");
    const k = parsePinnedKnowledge(body, "TECH-544");
    expect(k.cause).toBe("Bị gắn trùng tk học do cùng tên (như TECH-338)");
    expect(k.fix).toBe("Gỡ tk học 1 con bị trùng");
    expect(k.mentionedIds).toEqual(["TECH-338"]);
  });
});

describe("pinnedKnowledgeOf", () => {
  it("chỉ lấy comment ghim của người, bản ghim mới nhất", () => {
    const tl = [
      {
        kind: "comment",
        pinned: true,
        actorName: "Tiểu Linh",
        body: "- **Nguyên nhân:** bot đoán",
        createdAt: "2026-09-26T03:00:00Z",
      },
      {
        kind: "comment",
        pinned: true,
        actorName: "TechLead_A",
        body: "- **Nguyên nhân:** cũ",
        createdAt: "2026-09-25T01:00:00Z",
      },
      {
        kind: "comment",
        pinned: true,
        actorName: "TechLead_A",
        body: PIN_920,
        createdAt: "2026-09-26T01:00:00Z",
      },
      {
        kind: "comment",
        pinned: false,
        actorName: "TechLead_A",
        body: "- **Nguyên nhân:** không ghim",
        createdAt: "2026-09-26T02:00:00Z",
      },
    ];
    expect(pinnedKnowledgeOf(tl, "TECH-920")?.cause).toBe("Bị gắn trùng tk học do cùng tên");
  });
  it("không có comment ghim → null", () => {
    expect(
      pinnedKnowledgeOf(
        [{ kind: "comment", pinned: false, actorName: "TechLead_A", body: "x" }],
        "TECH-1",
      ),
    ).toBeNull();
  });
});

describe("humanLinkSignals", () => {
  const field = (actor: string, value: string, at: string) => ({
    kind: "activity",
    action: "field",
    actorName: actor,
    createdAt: at,
    payload: { subject: { value: "Related Tickets", id: 3 }, to: { value } },
  });
  const link = (action: string, actor: string, to: string, at: string) => ({
    kind: "activity",
    action,
    actorName: actor,
    createdAt: at,
    payload: { subject: { value: "relates" }, to: { value: to } },
  });

  it("link bot gắn KHÔNG phải tri thức; link người gắn là dương, người gỡ là âm", () => {
    const s = humanLinkSignals(
      [
        link("link_add", "Tiểu Linh", "TECH-1", "2026-09-20T01:00:00Z"),
        link("link_add", "Tiểu Linh", "TECH-2", "2026-09-20T01:00:00Z"),
        link("link_add", "TechLead_A", "TECH-3", "2026-09-20T02:00:00Z"),
        link("link_remove", "TechLead_A", "TECH-2", "2026-09-20T03:00:00Z"),
      ],
      "TECH-9",
    );
    expect(s.positives).toEqual(["TECH-3"]);
    expect(s.negatives).toEqual(["TECH-2"]);
  });

  it("bot gắn lại sau khi người gỡ → vẫn là âm (hành động cuối của NGƯỜI quyết định)", () => {
    const s = humanLinkSignals(
      [
        link("link_remove", "TechLead_A", "TECH-695", "2026-09-23T06:31:00Z"),
        link("link_add", "Tiểu Linh", "TECH-695", "2026-09-26T01:39:00Z"),
      ],
      "TECH-769",
    );
    expect(s.negatives).toEqual(["TECH-695"]);
    expect(s.positives).toEqual([]);
  });

  it("trường Related Tickets: chỉ mã NGƯỜI thêm là dương, mã người xoá là âm; lần ghi của bot/admin không tính", () => {
    const s = humanLinkSignals(
      [
        field("Tiểu Linh", "TECH-1, TECH-2, TEST-KG-A-1", "2026-09-26T01:39:00Z"),
        // Tech lead lưu lại danh sách của bot, chỉ bỏ mã test: không có nghĩa là chị duyệt TECH-1, TECH-2.
        field("TechLead_A", "TECH-1, TECH-2", "2026-09-26T01:53:00Z"),
        field("TechLead_A", "TECH-1, TECH-2, TECH-5", "2026-09-26T02:00:00Z"),
        field("admin", "TECH-1", "2026-09-26T03:00:00Z"),
      ],
      "TECH-920",
    );
    expect(s.positives).toEqual(["TECH-5"]);
    expect(s.negatives).toEqual(["TEST-KG-A-1"]);
  });

  it("bỏ chính nó", () => {
    const s = humanLinkSignals(
      [field("TechLead_A", "TECH-7, TECH-8", "2026-09-21T08:27:00Z")],
      "TECH-7",
    );
    expect(s.positives).toEqual(["TECH-8"]);
  });
});
