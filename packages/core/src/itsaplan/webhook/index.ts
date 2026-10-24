/**
 * `@vuihoc/bot-core/itsaplan/webhook` — Itsaplan webhook front door (ticket 14).
 * Signature + body cap + typed events + durable dedupe + HTTP server. Channel-
 * free: the notify layer (`@vuihoc/bot-core/intake` notify) maps events to chat
 * sends through ports.
 */
export * from "./events";
export * from "./dedupe-store";
export * from "./server";
