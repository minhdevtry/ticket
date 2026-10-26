import { describe, expect, it } from "bun:test";
import { classifySplitReply } from "./replies";

describe("classifySplitReply — phân loại phản hồi tách/gộp (W29-SPLIT, TECH-1146)", () => {
  it("nhận diện đúng các biến thể đồng ý tách (split)", () => {
    const splitCases = [
      "tách",
      "Tách 2 ticket",
      "Tách 3 ticket",
      "tách giúp mình",
      "ừ",
      "ok",
      "oke",
      "okay",
      "đúng rồi",
      "vâng",
      "dạ",
      "chuẩn",
      "tạo đi",
      "yes",
      "đồng ý",
      "đúng",
    ];
    for (const reply of splitCases) {
      expect(classifySplitReply(reply)).toBe("split");
    }
  });

  it("nhận diện đúng các biến thể đồng ý gộp / từ chối tách (merge)", () => {
    const mergeCases = [
      "không tách",
      "ko tách",
      "k tách",
      "không cần tách ra đâu",
      "gộp",
      "gộp 1 ticket",
      "gộp vào 1 ticket nhé",
      "để chung",
      "để chung 1 ticket nhé",
      "chung 1 ticket",
      "một ticket",
      "1 ticket",
      "không",
      "ko",
      "k",
      "no",
      // P2 (Vòng 3): "thôi" / "khỏi" trần = gộp 1 ticket
      "thôi",
      "khỏi",
      "thôi ạ",
      "khỏi nhé",
      "thôi nha",
      "khỏi luôn",
      "thôi đi",
      "khỏi vậy",
    ];
    for (const reply of mergeCases) {
      expect(classifySplitReply(reply)).toBe("merge");
    }
  });

  it("xử lý phủ định: 'không tách', 'đừng tách' tuyệt đối không nhận thành split", () => {
    const negatedSplitCases = [
      "không tách",
      "ko tách",
      "k tách",
      "chẳng tách",
      "chưa tách",
      "đừng tách",
      "khỏi tách",
      "thôi tách",
    ];
    for (const reply of negatedSplitCases) {
      expect(classifySplitReply(reply)).toBe("merge");
    }
  });

  it("trả về 'unknown' với câu trả lời không rõ ý hoặc chuyển chủ đề", () => {
    const unknownCases = [
      "sao cũng được em",
      "App Duo bị lỗi đăng nhập, em không vào được lớp học",
      "noop",
      "",
      "   ",
      "chào em",
      "mai kiểm tra nhé",
      "tại sao lại thế nhỉ",
    ];
    for (const reply of unknownCases) {
      expect(classifySplitReply(reply)).toBe("unknown");
    }
  });
});
