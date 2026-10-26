/**
 * Trần `rawText` theo legacy: một tin 4.000 ký tự, cả cuộc 8.000.
 *
 * Một hằng cho mọi nơi: engine (PR 4) và bộ trích xuất (PR 5) đều trần theo
 * cùng con số của legacy, nên nó sống ở một chỗ.
 */
export const MAX_RAW_TEXT_CHARS = 4000;
export const MAX_RAW_TEXT_TOTAL_CHARS = 8000;
