/** `@vuihoc/bot-core/intake` — intake engine (gate, priority, confirmation, conversation). Filled by tickets 05, 08, 09. */
export * from "./gate";
export * from "./priority";
export * from "./extractor";

// ── ticket 08: draft store + confirmation protocol + safe ticket creation ────
export * from "./ports";
export * from "./copy-catalog";
export * from "./draft";
export * from "./confirm";
export * from "./create";
export * from "./adapter";

// ── ticket 09: conversation engine ───────────────────────────────────────────
export * from "./engine";
export * from "./split";

// ── ticket 14: notify (webhook → chat dispatcher + reply router) ─────────────
export * from "./notify";
