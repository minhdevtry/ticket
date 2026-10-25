import { describe, expect, it } from "bun:test";
import {
  cleanIncidentDescription,
  isBotAuthoredComment,
  similarContextOf,
} from "./similar-context";

const DESCRIPTION = `## Thông tin sự cố

- Người báo: SA_LocKG - 1000000011
- Sản phẩm: Duo
- Hệ thống: Vuihoc (App/Web_Vuihoc + ERP_DUO)

### Mô tả

> Không lên được đơn do trùng tài khoản Vuihoc.

### Chẩn đoán & Gợi ý

- Triệu chứng và luồng kỹ thuật tương đồng với TECH-337: dữ liệu contact bị trùng.

---

*Nguồn: ticket-intake (Telegram) · 2026-09-12 12:16*`;

describe("cleanIncidentDescription", () => {
  it("bỏ khối '## Thông tin sự cố', TOÀN BỘ mục '### Chẩn đoán & Gợi ý' (không chỉ dòng tiêu đề), chữ ký nguồn", () => {
    const cleaned = cleanIncidentDescription(DESCRIPTION);
    expect(cleaned).toContain("Không lên được đơn do trùng tài khoản Vuihoc");
    expect(cleaned).not.toContain("Chẩn đoán");
    expect(cleaned).not.toContain("tương đồng với TECH-337");
    expect(cleaned).not.toContain("Nguồn:");
    expect(cleaned).not.toContain("Người báo:");
  });

  it("rỗng/null -> chuỗi rỗng, không throw", () => {
    expect(cleanIncidentDescription(null)).toBe("");
    expect(cleanIncidentDescription(undefined)).toBe("");
    expect(cleanIncidentDescription("")).toBe("");
  });
});

describe("isBotAuthoredComment", () => {
  it("dấu <!-- intake-bot --> tính là bot dù actorName không khớp isSystemActor", () => {
    expect(isBotAuthoredComment({ actorName: "Iris", body: "Đã đóng <!-- intake-bot -->" })).toBe(
      true,
    );
  });
  it("actorName hệ thống (Tiểu Linh/onyx/admin/bot) tính là bot", () => {
    expect(isBotAuthoredComment({ actorName: "Tiểu Linh", body: "Đã xử lý" })).toBe(true);
    expect(isBotAuthoredComment({ actorName: "onyx", body: "..." })).toBe(true);
  });
  it("boilerplate Onyx ingest tính là bot dù actor lạ", () => {
    expect(
      isBotAuthoredComment({
        actorName: "SomeSvc",
        body: "[Onyx Second Brain] Đã nạp bài học kinh nghiệm",
      }),
    ).toBe(true);
  });
  it("người thật, không dấu bot -> không phải bot", () => {
    expect(isBotAuthoredComment({ actorName: "TechLead_A", body: "Đã xử lý xong" })).toBe(false);
  });
});

describe("similarContextOf", () => {
  const issue = { description: DESCRIPTION };

  it("system/product bóc từ description", () => {
    const ctx = similarContextOf(issue, []);
    expect(ctx.system).toContain("Vuihoc");
    expect(ctx.product).toBe("Duo");
  });

  it("humanNotes: chỉ comment người thật, comment ghim xếp trước", () => {
    const timeline = [
      {
        kind: "comment",
        actorName: "TechUser_B",
        body: "Đã kiểm tra, chưa rõ nguyên nhân.",
        pinned: false,
      },
      { kind: "comment", actorName: "Tiểu Linh", body: "Đã đóng ticket.", pinned: false },
      {
        kind: "comment",
        actorName: "TechLead_A",
        body: "**Nguyên nhân:** Trùng tài khoản.",
        pinned: true,
      },
      { kind: "activity", actorName: "TechUser_B", action: "status" },
    ];
    const ctx = similarContextOf(issue, timeline);
    expect(ctx.humanNotes.startsWith("**Nguyên nhân:** Trùng tài khoản.")).toBe(true);
    expect(ctx.humanNotes).toContain("Đã kiểm tra, chưa rõ nguyên nhân.");
    expect(ctx.humanNotes).not.toContain("Đã đóng ticket.");
  });

  it("humanNotes và description gỡ thẻ <mark>, <span>, <video> nhưng giữ nội dung chữ", () => {
    const timeline = [
      {
        kind: "comment",
        actorName: "TechLead_A",
        body: '<mark data-color="#fef08a" style="background-color: #fef08a">**Nguyên nhân:**</mark> <span style="color: #ef4444">Trùng tài khoản</span> <video src="https://x/a.mp4" controls></video>',
        pinned: true,
      },
    ];
    const ctx = similarContextOf(issue, timeline);
    expect(ctx.humanNotes).toBe("**Nguyên nhân:** Trùng tài khoản");
    expect(ctx.humanNotes).not.toContain("<mark");
    expect(ctx.humanNotes).not.toContain("<span");
    expect(ctx.humanNotes).not.toContain("<video");
  });

  it("không có timeline (null/undefined) -> humanNotes rỗng, không throw", () => {
    expect(similarContextOf(issue, null).humanNotes).toBe("");
    expect(similarContextOf(issue, undefined).humanNotes).toBe("");
  });
});
