import { stripChannelEnvelope as stripChannelEnvelopeWith } from "@vuihoc/bot-core/core";

export { isInternalCallbackToken } from "@vuihoc/bot-core/core";

/**
 * `stripChannelEnvelope` với đúng hành vi intake cũ của Tiểu Linh:
 * - tin chỉ gồm một khối JSON phong bì bị bỏ hẳn → rỗng → guard "tin vô nghĩa" xử
 *   lý (giữ khối thì chat_id/sender_id lọt vào mô tả ticket — TECH-922);
 * - chữ sau `}` cuối của khối bị bỏ cùng dòng;
 * - khối ``` ``` do người dùng dán được giữ nguyên.
 * Thư viện mặc định giữ lại lời người dùng nhiều hơn (bản CM).
 */
export function stripChannelEnvelope(text: string | null | undefined): string {
  return stripChannelEnvelopeWith(text, {
    keepSoleEnvelopeBlock: false,
    keepTextAfterEnvelopeBlock: false,
    stripPastedEnvelopeFences: false,
  });
}
