/** `@vuihoc/bot-core/intake` — conversation engine (ticket 09). */
export * from "./types";
export * from "./identifiers";
export * from "./text";
export * from "./engine";
export * from "./edit";
export * from "./command-interpreter";
export * from "./timeout";
/** RFC 0002 PR 4: chuẩn hoá đầu vào và bảng ánh xạ `action` của hợp đồng cũ. */
export * from "./normalize";
export * from "./action-map";
/** RFC 0002 PR 6: replay oracle cho shadow replay và kiểm thử từng lượt. */
export * from "./oracle";
/** Test fixtures cho replay shadow và người dùng thư viện kiểm thử. */
export { engineTestCatalog } from "./catalog.fixture";
export { TEST_COPY } from "./test-copy.fixture";
