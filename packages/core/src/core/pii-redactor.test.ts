import { describe, expect, it } from "bun:test";
import { redactIncidentPII } from "./pii-redactor";

/**
 * intake không có file test riêng cho `redactIncidentPII` (nó được dùng gián
 * tiếp qua tool `redact_pii`). Vì lõi tách nó thành module công khai nên nó phải
 * có test riêng — các case dưới bám sát từng nhánh regex trong chú thích nguồn.
 */
describe("redactIncidentPII", () => {
  it("rỗng → chuỗi rỗng", () => {
    expect(redactIncidentPII("")).toBe("");
  });

  it("bóc Bearer/sk-/itp_ token", () => {
    const out = redactIncidentPII(
      "key sk-ABCDEFGHIJKLMNOPQRSTUV, itp_ABCDEFGHIJKLMNOPQRST, Bearer abcdef0123456789abcd",
    );
    expect(out).toContain("[REDACTED_TOKEN]");
    expect(out).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    expect(out).not.toContain("itp_ABCDEFGHIJKLMNOPQRST");
  });

  it("bóc mật khẩu khai bằng 'mật khẩu là ...' / 'pass=...'", () => {
    expect(redactIncidentPII("mật khẩu là Vuihoc@2026")).toContain("[REDACTED_PASSWORD]");
    expect(redactIncidentPII("pass=abc123xyz")).toContain("[REDACTED_PASSWORD]");
  });

  it("bóc email, CCCD (12 số)", () => {
    expect(redactIncidentPII("liên hệ a.b@example.com")).toContain("[REDACTED_EMAIL]");
    expect(redactIncidentPII("CCCD 012345678901")).toContain("[REDACTED_CCCD]");
  });

  it("bóc SĐT VN (0… hoặc +84…)", () => {
    expect(redactIncidentPII("gọi 0900000002 nhé")).toContain("[REDACTED_PHONE]");
    expect(redactIncidentPII("số +84 912 345 678")).toContain("[REDACTED_PHONE]");
  });

  it("giữ nguyên văn bản kỹ thuật không chứa PII", () => {
    const clean = "Phòng 502 lỗi 500 timeout ở API /issue, IP 10.0.0.1";
    expect(redactIncidentPII(clean)).toBe(clean);
  });
});
