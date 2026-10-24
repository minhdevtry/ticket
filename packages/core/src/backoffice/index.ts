/**
 * `@vuihoc/bot-core/backoffice` — tầng hậu cần ("back office") của một bot:
 *  - handler theo trigger của run itsaplan (`mention`, `delegation`, `field`,
 *    `schedule`, `manual`, `status`, `event`), nhận `RunContext` có kiểu;
 *  - luật "sự kiện → điều kiện → hành động" trên webhook;
 *  - tracker bị khoá vào một dự án.
 *
 * Dùng qua `defineBot({ backoffice })` + `createBot` (`@vuihoc/bot-core/bot`).
 * Thiết kế: `docs/rfc/0001-bot-kit.md`; giải thích: `docs/explanation/bot-kit.md`.
 */
export * from "./types";
export * from "./mention";
export * from "./tracker";
export * from "./dispatch";
export * from "./rules";
