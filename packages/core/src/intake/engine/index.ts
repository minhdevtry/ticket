/** `@vuihoc/bot-core/intake` — conversation engine (ticket 09). */
export * from "./types";
export * from "./identifiers";
export * from "./text";
export * from "./engine";
/** RFC 0002 PR 4: chuẩn hoá đầu vào và bảng ánh xạ `action` của hợp đồng cũ. */
export * from "./normalize";
export * from "./action-map";
/** RFC 0002 PR 6: replay oracle cho shadow replay và kiểm thử từng lượt. */
export * from "./oracle";
