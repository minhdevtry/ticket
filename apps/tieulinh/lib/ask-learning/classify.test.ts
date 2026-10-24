import { describe, expect, it } from "bun:test";
import {
  buildReport,
  classifyComment,
  sanitize,
  userPrompt,
  SYSTEM_PROMPT,
  type ClassifyInput,
} from "./classify";

const cfg = { baseUrl: "http://x", apiKey: "", model: "m1", api: "openai" as const };
const input: ClassifyInput = {
  report: "Tiêu đề: t\nMô tả:\nkhông vào được app",
  prev: [{ actor: "A", createdAt: "2026-10-01T01:00:00Z", text: "chào bạn" }],
  comment: {
    actor: "TechLead_A",
    createdAt: "2026-10-01T02:00:00Z",
    text: "bạn gửi ảnh màn hình lỗi giúp em",
  },
};

describe("classifyComment", () => {
  it("JSON tốt → needs_info, mục chuẩn", async () => {
    const reply =
      '```json\n{"needs_info": true, "kind": "supplement_request", "items": ["SCREENSHOT", "DEVICE_APP"], "already_in_report": false, "evidence": "gửi ảnh màn hình lỗi"}\n```';
    const r = await classifyComment(cfg, input, async () => reply);
    expect(r.needsInfo).toBe(true);
    expect(r.kind).toBe("supplement_request");
    expect(r.items).toEqual(["SCREENSHOT", "DEVICE_APP"]);
    expect(r.alreadyInReport).toBe(false);
    expect(r.model).toBe("m1");
  });

  it("mục lạ bị bỏ, OTHER bị bỏ, kind không cần bổ sung → không có mục", async () => {
    const r = await classifyComment(
      cfg,
      input,
      async () =>
        '{"needs_info": true, "kind": "inform", "items": ["SCREENSHOT", "FOO", "OTHER"], "already_in_report": false, "evidence": ""}',
    );
    expect(r.needsInfo).toBe(false);
    expect(r.items).toEqual([]);
  });

  it("kind lạ → other, không tính là cần bổ sung dù needs_info=true", async () => {
    const r = await classifyComment(
      cfg,
      input,
      async () => '{"needs_info": true, "kind": "xyz", "items": ["TIME"]}',
    );
    expect(r.kind).toBe("other");
    expect(r.needsInfo).toBe(false);
  });

  it("các kind cần bổ sung đều tính là needs_info", () => {
    for (const kind of ["ask", "supplement_request", "clarify", "correction", "lesson_next_time"]) {
      expect(sanitize({ kind, items: ["TIME"] }, "m").needsInfo).toBe(true);
    }
    for (const kind of ["inform", "routing", "remote_access", "verify_after_fix", "other"]) {
      expect(sanitize({ kind, items: ["TIME"] }, "m").needsInfo).toBe(false);
    }
  });

  it("đầu ra không phải JSON → ném lỗi (không ghi, thử lại lần sau)", async () => {
    await expect(
      classifyComment(cfg, input, async () => "xin lỗi, tôi không biết"),
    ).rejects.toThrow();
  });

  it("LLM lỗi → ném lỗi", async () => {
    await expect(
      classifyComment(cfg, input, async () => {
        throw new Error("HTTP 503");
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("quá giờ → ném lỗi", async () => {
    await expect(
      classifyComment(cfg, input, () => new Promise<string>(() => {}), 20),
    ).rejects.toThrow("timeout");
  });

  it("prompt dùng bộ mục chuẩn, không có mã info_need cũ", () => {
    expect(SYSTEM_PROMPT).toContain("SCREENSHOT");
    expect(SYSTEM_PROMPT).toContain("EXTENT:");
    expect(SYSTEM_PROMPT).not.toMatch(/info_need/i);
    expect(userPrompt(input)).toContain(
      "BÌNH LUẬN CẦN PHÂN LOẠI (của TechLead_A, 2026-10-01T02:00)",
    );
  });
});

describe("buildReport", () => {
  it("bỏ khối chẩn đoán và Bổ sung trở đi, bỏ comment HTML", () => {
    const r = buildReport(
      "Tiêu đề",
      "<!-- x -->Mô tả lỗi\n\n### Chẩn đoán & Gợi ý\nbot đoán\n\n### ➕ Bổ sung\n- 10:00 abc",
    );
    expect(r).toContain("Mô tả lỗi");
    expect(r).not.toContain("bot đoán");
    expect(r).not.toContain("abc");
  });
});
