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
 *
 * Chủ sở hữu: mô-đun heuristic tiếng Việt (PR 5). Ở đây chỉ re-export để
 * chỗ gọi cũ của PR 4 không đổi.
 */
export { isDeclineAnswer } from "../extractor/heuristics";
