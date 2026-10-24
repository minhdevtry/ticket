import { afterEach, describe, expect, test } from "bun:test";
import {
  describeToolFailure,
  newErrorCode,
  errorCodeFor,
  setToolFailureAlert,
  setToolFailureOptions,
} from "./tool-error";

afterEach(() => {
  setToolFailureAlert(null);
  setToolFailureOptions({ hideDetailFromUser: false, useDeclaredErrorCode: true });
});

// ── ported from both intake and CM suites ────────────────────────────────────

describe("tool-error: error codes", () => {
  test("mã lỗi ngắn, viết hoa, và hai thời điểm khác nhau ra hai mã khác nhau", () => {
    const a = newErrorCode(1_757_000_000_000);
    const b = newErrorCode(1_757_000_000_001);
    expect(a).toMatch(/^[0-9A-Z]{6}$/);
    expect(a).not.toBe(b);
  });

  test("generates 6-character uppercase error codes (CM)", () => {
    expect(newErrorCode()).toMatch(/^[0-9A-Z]{6}$/);
  });
});

describe("tool-error: describeToolFailure", () => {
  test("thông báo mang đủ mã lỗi, chi tiết và lời dặn chụp màn hình (intake)", () => {
    const failure = describeToolFailure(
      "create_issue",
      new Error("Itsaplan 503 Service Unavailable"),
    );
    expect(failure.loi).toBe(true);
    expect(failure.thong_bao_cho_nguoi_dung).toContain(failure.ma_loi);
    expect(failure.thong_bao_cho_nguoi_dung).toContain("Itsaplan 503 Service Unavailable");
    expect(failure.thong_bao_cho_nguoi_dung).toContain("chụp màn hình");
  });

  test("converts exceptions into structured ToolFailure without throwing (CM)", () => {
    const failure = describeToolFailure("test_tool", new Error("Database connection lost"));
    expect(failure.loi).toBe(true);
    expect(failure.ma_loi).toMatch(/^[0-9A-Z]{6}$/);
    expect(failure.chi_tiet).toContain("Database connection lost");
    expect(failure.thong_bao_cho_nguoi_dung).toContain("⚠️ Dạ em gặp lỗi");
    expect(failure.thong_bao_cho_nguoi_dung).toContain(failure.ma_loi);
  });

  /** Stack dài thì người ta không đọc, và tin nhắn Telegram cũng có trần. */
  test("chi tiết dài bị cắt, không nhồi cả stack vào tin nhắn", () => {
    const failure = describeToolFailure("get_issue", new Error("x".repeat(2000)));
    expect(failure.chi_tiet.length).toBeLessThanOrEqual(301);
    expect(failure.chi_tiet.endsWith("…")).toBe(true);
  });
});

// ── merged behaviour: CM stable codes + injected alert hook ──────────────────

describe("tool-error: stable coded errors (CM, merged)", () => {
  test("errorCodeFor keeps a declared stable code", () => {
    const err = Object.assign(new Error("rate limited"), { code: "E_TICKET_RATE_LIMITED" });
    expect(errorCodeFor(err)).toBe("E_TICKET_RATE_LIMITED");
  });

  test("errorCodeFor falls back to a random code for a plain error", () => {
    expect(errorCodeFor(new Error("boom"), 1_757_000_000_000)).toMatch(/^[0-9A-Z]{6}$/);
  });

  test("describeToolFailure surfaces the stable code as ma_loi", () => {
    const err = Object.assign(new Error("over quota"), { code: "E_TICKET_RATE_LIMITED" });
    const failure = describeToolFailure("create_issue", err);
    expect(failure.ma_loi).toBe("E_TICKET_RATE_LIMITED");
    expect(failure.thong_bao_cho_nguoi_dung).toContain("E_TICKET_RATE_LIMITED");
  });
});

describe("tool-error: injected admin alert hook", () => {
  test("fires the injected hook with key + message, no Telegram import", () => {
    const seen: Array<[string, string]> = [];
    setToolFailureAlert((key, msg) => seen.push([key, msg]));
    const failure = describeToolFailure("send_ticket", new Error("kaboom"));
    expect(seen.length).toBe(1);
    expect(seen[0]![0]).toBe("tool-loi-send_ticket");
    expect(seen[0]![1]).toContain(failure.ma_loi);
  });

  test("no hook installed = no alert, result still returned", () => {
    setToolFailureAlert(null);
    const failure = describeToolFailure("send_ticket", new Error("kaboom"));
    expect(failure.loi).toBe(true);
  });
});

// ── B3: ẩn chi tiết kỹ thuật khỏi người dùng (opt-in, bản vá CM) ─────────────

describe("tool-error: hideDetailFromUser (B3)", () => {
  test("mặc định: tin nhắn người dùng VẪN có chi tiết (giữ hành vi intake)", () => {
    const f = describeToolFailure("create_issue", new Error("Itsaplan 503 Service Unavailable"));
    expect(f.thong_bao_cho_nguoi_dung).toContain("Itsaplan 503 Service Unavailable");
    expect(f.thong_bao_cho_nguoi_dung).toContain("Chi tiết:");
  });

  test("bật hideDetailFromUser: tin nhắn người dùng KHÔNG lộ chuỗi kỹ thuật, nhưng chi_tiet + log vẫn giữ", () => {
    setToolFailureOptions({ hideDetailFromUser: true });
    const f = describeToolFailure("create_issue", new Error("Itsaplan 503 Service Unavailable"));
    expect(f.thong_bao_cho_nguoi_dung).not.toContain("Itsaplan 503 Service Unavailable");
    expect(f.thong_bao_cho_nguoi_dung).not.toContain("Chi tiết:");
    // mã lỗi và lời dặn vẫn còn
    expect(f.thong_bao_cho_nguoi_dung).toContain(f.ma_loi);
    expect(f.thong_bao_cho_nguoi_dung).toContain("chụp màn hình");
    // chi tiết kỹ thuật không mất — chỉ không hiện cho người dùng
    expect(f.chi_tiet).toContain("Itsaplan 503 Service Unavailable");
  });

  test("hook báo admin vẫn nhận chi tiết dù đã ẩn khỏi người dùng", () => {
    setToolFailureOptions({ hideDetailFromUser: true });
    const seen: string[] = [];
    setToolFailureAlert((_k, m) => seen.push(m));
    describeToolFailure("create_issue", new Error("Itsaplan 503 Service Unavailable"));
    expect(seen[0]).toContain("Itsaplan 503 Service Unavailable");
  });
});

describe("tool-error: useDeclaredErrorCode (cho bot cần mã lỗi intake cũ)", () => {
  test("mặc định: lỗi tự khai code dạng E_XXX giữ nguyên làm ma_loi", () => {
    const err = Object.assign(new Error("rate"), { code: "E_TICKET_RATE_LIMITED" });
    expect(describeToolFailure("t", err).ma_loi).toBe("E_TICKET_RATE_LIMITED");
  });

  test("useDeclaredErrorCode:false → luôn mã ngắn theo thời điểm, hai lỗi cùng code vẫn khác mã", () => {
    setToolFailureOptions({ useDeclaredErrorCode: false });
    try {
      const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      const a = describeToolFailure("t", err, 1_757_000_000_000);
      const b = describeToolFailure("t", err, 1_757_000_000_001);
      expect(a.ma_loi).toMatch(/^[0-9A-Z]{6}$/);
      expect(a.ma_loi).not.toBe("ECONNRESET");
      expect(a.ma_loi).not.toBe(b.ma_loi);
    } finally {
      setToolFailureOptions({ useDeclaredErrorCode: true });
    }
  });
});
