/**
 * Bộ tách báo cáo chứa nhiều học sinh / sự cố độc lập trong một tin nhắn (W29-SPLIT, TECH-1146).
 *
 * Port từ legacy `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts` (PR 9 của RFC 0002).
 * Giữ nguyên các luật tất định:
 *  - Tin ngắn hơn 30 ký tự → không tách.
 *  - Dấu hiệu "ví dụ" (Vdu:, ví dụ, dưới đây là 2 HS...) → một sự cố hệ thống kèm ví dụ, không tách.
 *  - Không có từ chỉ lỗi (EXPANDED_PROBLEM_WORDS) → không tách.
 *  - Tách theo 2 dòng trống hoặc mẫu mở đầu khối mới (1./2., **Tên**, Code:, CRM trần).
 *  - Mỗi khối phải có định danh CÓ NHÃN (khách hàng hoặc học sinh) và câu chữ riêng (không chỉ là tên người).
 *  - Khối không có câu chữ chỉ được tính khi có mã khách hàng hoặc mã đơn.
 *  - Chỉ tách khi có ≥ 2 giá trị CÙNG LỚP khác nhau.
 */
import type { SplitBlock } from "../draft/types";
import {
  EXPANDED_PROBLEM_WORDS,
  deriveFallbackTitle,
  extractBlockInfo,
  isPersonNameOnly,
  residualProse,
} from "../extractor/heuristics";

/** Dấu hiệu "danh sách ví dụ" — một sự cố hệ thống kèm vài HS làm chứng cứ, KHÔNG được tách. */
export const EXAMPLE_LIST_MARKER =
  /(?:\bvdu\b|\bví\s*dụ\b|\bvd\b|dưới\s*đây|các\s+hs\b|các\s+học\s*sinh\b|một\s*số\s+hs\b|một\s*số\s+học\s*sinh\b|kèm\s+(?:các\s+)?hs)/iu;

export function splitMultiIncidentReport(text: string): SplitBlock[] | null {
  if (!text || text.length < 30) return null;
  // "Vdu:", "ví dụ", "dưới đây là 2 HS", "các HS" → một sự cố hệ thống kèm ví dụ
  if (EXAMPLE_LIST_MARKER.test(text)) return null;
  // Không có mô tả lỗi nào thì không có chuyện tách nhiều sự cố
  if (!EXPANDED_PROBLEM_WORDS.test(text)) return null;

  // Tách theo 2 dấu xuống dòng trở lên
  let rawBlocks = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  // Nếu không có 2 dòng trống, thử tách theo mẫu mở đầu khối mới (số thứ tự 1./2., **Tên**, Code:, mã CRM trần)
  if (rawBlocks.length < 2) {
    const headerSplit = text.split(
      /(?=\n(?:\d+[.)]|\*\*[^*]+\*\*|[Bb]ạn\s+\d+|[Hh][Ss]\s+\d+|[Hh]ọc\s+sinh\s+\d+|Code:\s*\d+|\b\d{7,10}\b))/,
    );
    if (headerSplit.length >= 2) {
      rawBlocks = headerSplit.map((b) => b.trim()).filter(Boolean);
    }
  }

  if (rawBlocks.length < 2) return null;

  const validBlocks: SplitBlock[] = [];
  for (const block of rawBlocks) {
    const info = extractBlockInfo(block);
    // Chỉ tách theo định danh KHÁCH HÀNG / HỌC SINH có nhãn — SĐT không tạo việc tách
    if ((!info.customerId && !info.studentAccount) || block.length < 15) continue;

    // Khối phải có câu chữ riêng KHÔNG phải chỉ là dòng tên người ("Phạm Thị E (SID: 900012)").
    // Khối KHÔNG có câu chữ nào chỉ được tính khi nó là "đầu ca" thật: có mã khách
    // hàng hoặc mã đơn (DH…, TNX…) — dòng chỉ ghi mỗi mã học sinh (TECH-391: hai anh
    // em cùng một mã khách hàng, cùng một lỗi hệ thống) không đủ để tách.
    const prose = residualProse(block);
    if (prose.length > 0) {
      if (isPersonNameOnly(prose)) continue;
    } else if (!info.customerId && !/[A-Z]{2,5}[-_]?\d{4,}/.test(block)) {
      continue;
    }
    const title = deriveFallbackTitle(
      block,
      undefined,
      info.studentName ? [info.studentName] : undefined,
    );
    validBlocks.push({
      text: block,
      studentName: info.studentName,
      customerId: info.customerId,
      studentAccount: info.studentAccount,
      reportingDept: info.reportingDept,
      title,
    });
  }

  if (validBlocks.length < 2) return null;

  // Chỉ tách khi có ≥ 2 giá trị CÙNG LỚP khác nhau (Bug 9: không so `!== undefined`)
  const customers = new Set(validBlocks.map((b) => b.customerId).filter(Boolean) as string[]);
  const students = new Set(validBlocks.map((b) => b.studentAccount).filter(Boolean) as string[]);
  if (customers.size >= 2 || students.size >= 2) {
    return validBlocks;
  }

  return null;
}
