import { describe, expect, it } from "bun:test";
import { DEFAULT_TECH_ACCOUNTS, isCandidateComment } from "./candidate";

describe("isCandidateComment", () => {
  it("kỹ thuật viên nhắc Tiểu Linh → ứng viên", () => {
    expect(isCandidateComment("@Tiểu Linh bạn gửi lại ảnh giúp em", "TechLead_A")).toBe(true);
    expect(isCandidateComment("nhờ tieulinh kiểm tra", "TechUser_B")).toBe(true);
  });

  it("@ một tài khoản người báo (SA_/CS_/SC_/TE_) → ứng viên", () => {
    expect(isCandidateComment("@SA_UserE bạn cho em xin mã KH", "TechUser_C")).toBe(true);
  });
  it("nhắc người báo hoặc Tiểu Linh qua thẻ HTML (@<span...>, <p>, entities) → ứng viên", () => {
    expect(isCandidateComment('<p>@<span class="mention">SA_UserE</span> bạn cho em xin mã KH</p>', "TechUser_C")).toBe(true);
    expect(isCandidateComment('<div>Nhờ @<span>tieulinh</span> kiểm tra giúp</div>', "TechUser_B")).toBe(true);
    expect(isCandidateComment('@<span data-type="mention">@SA_UserE</span> gửi ảnh', "TechLead_A")).toBe(true);
    expect(isCandidateComment("&lt;p&gt;@CS_UserF kiểm tra lại&lt;/p&gt;", "TechUser_C")).toBe(true);
  });


  it("không phải kỹ thuật viên → không", () => {
    expect(isCandidateComment("@Tiểu Linh gửi ảnh giúp em", "SA_UserE")).toBe(false);
    expect(isCandidateComment("@Tiểu Linh gửi ảnh giúp em", "")).toBe(false);
  });

  it("kỹ thuật viên nhưng không nhắc ai → không", () => {
    expect(isCandidateComment("Đã xử lý xong, cảm ơn anh chị", "TechUser_B")).toBe(false);
  });

  it("danh sách mặc định có 19 tài khoản TECH", () => {
    expect(DEFAULT_TECH_ACCOUNTS.size).toBe(19);
    expect(DEFAULT_TECH_ACCOUNTS.has("TechLead_A")).toBe(true);
  });
});
