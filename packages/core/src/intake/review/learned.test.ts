import { describe, expect, it } from "bun:test";
import {
  intakeSystemsOf,
  learnedItems,
  learnedReport,
  learnedShares,
  type AskCommentRow,
  type AskLearnDataProvider,
  type AskTicketRow,
} from "./learned";

class MemoryAskLearnStore implements AskLearnDataProvider {
  private tickets: AskTicketRow[] = [];
  private comments: AskCommentRow[] = [];

  upsertTicket(t: AskTicketRow) {
    this.tickets = this.tickets.filter((x) => x.issueKey !== t.issueKey);
    this.tickets.push(t);
  }

  upsertComment(c: AskCommentRow) {
    this.comments = this.comments.filter((x) => x.commentId !== c.commentId);
    this.comments.push(c);
  }

  ticketsOf(system: string): AskTicketRow[] {
    return this.tickets.filter((t) => t.system === system);
  }

  needsCommentsOf(system: string): AskCommentRow[] {
    return this.comments.filter((c) => c.system === system && c.needsInfo);
  }

  systems(): string[] {
    return [...new Set(this.tickets.map((t) => t.system))];
  }
}

const NOW = Date.parse("2026-10-16T00:00:00Z");
const DAY = 86_400_000;
const at = (daysBefore: number) => NOW - daysBefore * DAY;

function addTicket(
  store: MemoryAskLearnStore,
  key: string,
  system: string,
  createdAt: number,
  item: "STEPS" | "TIME",
  commentAt: number,
  alreadyInReport = false,
) {
  store.upsertTicket({ issueKey: key, system, createdAt });
  store.upsertComment({
    commentId: `c-${key}`,
    issueKey: key,
    system,
    createdAt: commentAt,
    needsInfo: true,
    kind: "ask",
    items: [item],
    alreadyInReport,
  });
}

describe("learnedItems", () => {
  it("mục cần gần đây được học; mục chỉ cần từ 2 năm trước rơi ra", () => {
    const store = new MemoryAskLearnStore();
    for (let i = 0; i < 5; i++)
      addTicket(store, `OLD-${i}`, "CRM_Vuihoc", at(730), "TIME", at(730));
    for (let i = 0; i < 4; i++) addTicket(store, `NEW-${i}`, "CRM_Vuihoc", at(6), "STEPS", at(6));
    const items = learnedItems(store, "CRM_Vuihoc", NOW);
    expect(items).toContain("STEPS");
    expect(items).not.toContain("TIME");
    // Cùng dữ liệu nhìn lại thời điểm 2 năm trước thì TIME là mục đáng học.
    expect(learnedItems(store, "CRM_Vuihoc", at(730))).toContain("TIME");
  });

  it("dưới ngưỡng số ticket hoặc tỉ lệ thì không học", () => {
    const store = new MemoryAskLearnStore();
    addTicket(store, "T-1", "LMS_Vuihoc", at(1), "STEPS", at(1));
    expect(learnedItems(store, "LMS_Vuihoc", NOW)).toEqual([]);
  });

  it("bình luận đã có trong báo cáo (already_in_report) không được tính", () => {
    const store = new MemoryAskLearnStore();
    for (let i = 0; i < 3; i++)
      addTicket(store, `A-${i}`, "DUO_Vuihoc", at(1), "TIME", at(1), true);
    expect(learnedItems(store, "DUO_Vuihoc", NOW)).toEqual([]);
  });

  it("học theo từng hệ thống, không lẫn sang hệ thống khác", () => {
    const store = new MemoryAskLearnStore();
    for (let i = 0; i < 3; i++) addTicket(store, `X-${i}`, "CARE_Vuihoc", at(1), "STEPS", at(1));
    expect(learnedItems(store, "CARE_Vuihoc", NOW)).toContain("STEPS");
    expect(learnedItems(store, "CRM_Vuihoc", NOW)).toEqual([]);
    expect(learnedItems(store, "", NOW)).toEqual([]);
  });

  it("nhãn cũ (OMS_Vuihoc) được gộp vào hệ thống chuẩn lúc truy vấn", () => {
    const store = new MemoryAskLearnStore();
    for (let i = 0; i < 3; i++) addTicket(store, `O-${i}`, "OMS_Vuihoc", at(1), "STEPS", at(1));
    expect(learnedItems(store, "CRM_Vuihoc", NOW)).toContain("STEPS");
    expect(learnedItems(store, "OMS_Vuihoc", NOW)).toEqual([]);
  });

  it("nhãn App/Web chưa rõ được đếm cho cả DUO_Vuihoc và VH_Tự học", () => {
    const store = new MemoryAskLearnStore();
    for (let i = 0; i < 3; i++)
      addTicket(store, `W-${i}`, "Vuihoc (App/Web_Vuihoc + ERP_DUO)", at(1), "TIME", at(1));
    expect(learnedItems(store, "DUO_Vuihoc", NOW)).toContain("TIME");
    expect(learnedItems(store, "VH_Tự học", NOW)).toContain("TIME");
    expect(learnedItems(store, "CRM_Vuihoc", NOW)).toEqual([]);
  });

  it("learnedReport: 9 hệ thống chuẩn + nhãn chưa map", () => {
    const store = new MemoryAskLearnStore();
    for (let i = 0; i < 3; i++) addTicket(store, `R-${i}`, "CARE_Vuihoc", at(1), "STEPS", at(1));
    addTicket(store, "X-1", "Chưa xác định (đội Kỹ thuật sẽ phân loại)", at(1), "TIME", at(1));
    const rep = learnedReport(store, NOW);
    expect(rep.systems.length).toBe(9);
    const care = rep.systems.find((r) => r.system === "CARE_Vuihoc");
    expect(care?.tickets).toBe(3);
    expect(care?.learned).toEqual(["STEPS"]);
    expect(rep.unmapped).toEqual([
      { label: "Chưa xác định (đội Kỹ thuật sẽ phân loại)", tickets: 1 },
    ]);
  });
});

describe("learnedShares", () => {
  it("trả về tỉ lệ cho mọi mục có trọng số, kể cả không qua ngưỡng minTickets / minShare", () => {
    const store = new MemoryAskLearnStore();
    // 1 ticket với STEPS -> minTickets=2 chưa đủ, nhưng learnedShares vẫn phải trả về
    addTicket(store, "TECH-1", "CRM_Vuihoc", at(1), "STEPS", at(1));
    const items = learnedItems(store, "CRM_Vuihoc", NOW);
    expect(items).toEqual([]); // chưa qua ngưỡng

    const shares = learnedShares(store, "CRM_Vuihoc", NOW);
    expect(shares.STEPS).toBeGreaterThan(0.99); // 1 ticket duy nhất, tỉ lệ ~ 1.0
    expect(shares.TIME).toBeUndefined(); // không có TIME
  });

  it("nhãn cũ (OMS_Vuihoc) gộp vào CRM_Vuihoc theo taxonomy absorbs", () => {
    const store = new MemoryAskLearnStore();
    addTicket(store, "O-1", "OMS_Vuihoc", at(1), "STEPS", at(1));
    const sharesCRM = learnedShares(store, "CRM_Vuihoc", NOW);
    expect(sharesCRM.STEPS).toBeGreaterThan(0.99);
    const sharesOMS = learnedShares(store, "OMS_Vuihoc", NOW);
    expect(sharesOMS).toEqual({});
  });

  it("hệ thống rỗng hoặc không có ticket → trả về object rỗng", () => {
    const store = new MemoryAskLearnStore();
    expect(learnedShares(store, "", NOW)).toEqual({});
    expect(learnedShares(store, "Khong_Ton_Tai", NOW)).toEqual({});
  });
});

describe("intakeSystemsOf", () => {
  it("nhãn chuẩn và nhãn gộp theo taxonomy absorbs", () => {
    expect(intakeSystemsOf("CRM_Vuihoc")).toEqual(["CRM_Vuihoc"]);
    expect(intakeSystemsOf("OMS_Vuihoc")).toEqual(["CRM_Vuihoc"]);
    expect(intakeSystemsOf("CRM_VH")).toEqual(["CRM_Vuihoc"]);
    expect(intakeSystemsOf("Bitu Chat")).toEqual(["DUO_Vuihoc"]);
    expect(intakeSystemsOf("TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)")).toEqual(["TUTOR_Vuihoc"]);
    expect(intakeSystemsOf("Khác (liên quan bên IT)")).toEqual(["Khác_Hạ tầng_IT"]);
    expect(intakeSystemsOf("SMS")).toEqual(["Khác_Hạ tầng_IT"]);
  });

  it("nhãn App/Web chưa rõ → cả DUO_Vuihoc lẫn VH_Tự học", () => {
    for (const l of [
      "Vuihoc (App/Web_Vuihoc + ERP_DUO)",
      "App/Web_Vuihoc",
      "Web_Vuihoc",
      "APP/WEB/CARE_Vuihoc",
    ]) {
      expect(intakeSystemsOf(l)).toEqual(["DUO_Vuihoc", "VH_Tự học"]);
    }
  });

  it("nhãn lạ hoặc rỗng → không map", () => {
    expect(intakeSystemsOf("Chưa xác định (đội Kỹ thuật sẽ phân loại)")).toEqual([]);
    expect(intakeSystemsOf("  ")).toEqual([]);
  });
});
