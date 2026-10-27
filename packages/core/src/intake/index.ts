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

// ── ticket 13: technical review & ask-learning (RFC 0002 §1.4 F1-F4) ────────
export * from "./review";

// ── PR 15: receptionist MCP pack & skill (RFC 0002 §5 issue #29) ──────────────
export * from "./mcp";
