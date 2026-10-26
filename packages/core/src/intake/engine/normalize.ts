/**
 * Chuẩn hoá đầu vào — tiền xử lý TẤT ĐỊNH, KHÔNG LLM (RFC 0002 PR 4, mục 2.1).
 *
 * Mọi quyết định ở đây đều bằng luật, không nhờ model: tin vô nghĩa bị bỏ
 * (TECH-1148), câu trả lời từ chối được nhận ra (A13), và câu trả lời cho câu
 * hỏi dữ kiện luôn vào mô tả dù chỉ là một mã (ADR-0010).
 *
 * NGUỒN: legacy `lib/intake-step/pipeline.ts` (`isMeaninglessInput` — tin rỗng
 * hoặc token nội bộ "noop" mà không kèm media thì bỏ qua hoàn toàn) và
 * `lib/intake-step/extractor.ts` (`isDeclineAnswer` — "không biết", "em không
 * rõ ạ", "chưa có").
 */
import { isInternalCallbackToken } from "../../core";

/**
 * "Trường" giả cho câu hỏi dữ kiện kỹ thuật — dùng trong `lastAskedFields` và
 * `explicitlyMissing` để biết tin kế tiếp là câu trả lời cho câu hỏi đó.
 */
export const TECH_INFO_FIELD = "__tech";

/** Từ có thể nằm trong một câu trả lời từ chối ("em không biết ạ"). */
const DECLINE_WORDS: Record<string, true> = {
  không: true,
  ko: true,
  k: true,
  hông: true,
  chưa: true,
  biết: true,
  rõ: true,
  có: true,
  nhớ: true,
  dạ: true,
  em: true,
  chị: true,
  anh: true,
  mình: true,
  ạ: true,
  nhé: true,
  nha: true,
  luôn: true,
  thông: true,
  tin: true,
  cái: true,
  này: true,
  đâu: true,
  rồi: true,
  cũng: true,
  e: true,
  c: true,
  a: true,
  thì: true,
  chịu: true,
};

/** Từ phủ định đứng trước — "không biết", "chưa có". */
const DECLINE_NEGATION = /^(?:không|ko|k|hông|chưa)$/;
/** Từ đi sau phủ định — "biết", "rõ", "có", "nhớ". */
const DECLINE_AFTER = /^(?:biết|rõ|có|nhớ)$/;

/** Bỏ dấu câu, tách từ — cùng cách legacy tách ("em không biết ạ" → 4 từ). */
function tokenize(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tin vô nghĩa: rỗng, hoặc chỉ là token nội bộ của nút ("noop"), mà KHÔNG
 * kèm ảnh. Tin này không tạo tờ khai, không tạo ticket, không làm hỏng trạng
 * thái đang có (TECH-1148).
 */
export function isMeaninglessInput(text: string, mediaPaths: readonly string[]): boolean {
  const trimmed = text.trim();
  return (!trimmed || isInternalCallbackToken(trimmed)) && mediaPaths.length === 0;
}

/**
 * "không biết", "em không rõ ạ", "chưa có" — người báo nói rõ là không trả lời
 * được câu vừa hỏi. Khi đó trường vừa hỏi vào `explicitlyMissing` và bot thôi
 * hỏi trường đó (A13).
 */
export function isDeclineAnswer(text: string): boolean {
  if (!text || text.length > 40) return false;
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  if (!tokens.every((t) => DECLINE_WORDS[t] === true)) return false;
  if (tokens.includes("chịu")) return true;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (DECLINE_NEGATION.test(tokens[i]) && DECLINE_AFTER.test(tokens[i + 1])) return true;
  }
  return false;
}
