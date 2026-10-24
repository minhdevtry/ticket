/**
 * `@vuihoc/bot-core/itsaplan` — Itsaplan tracker client. Filled by ticket 04.
 *
 * One client that is the union of intake `lib/itsaplan/*` (field/column metadata,
 * stateType, archived markers, 5bf501e: HTML highlight support, teamRef URL,
 * move-ticket, number lock via identifier-match, webhook actor) and CM
 * `cm/lib/itsaplan/*` (typed `ItsaplanApiError` / `ItsaplanMalformedResponseError`,
 * `isRetryableItsaplanError`, retry/429 via `./http`).
 *
 * Left out (per ticket): PO `state-messages.ts`, CM `sync.ts` (CMSUPPORT adapter),
 * `ownership.ts` (Telegram-coupled), CM `fields.ts` / `names.ts` (CM domain).
 */
export * from "./http";
export * from "./client";
export * from "./project";
export * from "./project-lock";
export * from "./status";
export * from "./ticket-state";
export * from "./attachments";
export * from "./sync-labels";
export * from "./ensure-webhook";

// ── ticket 14: webhook front door (signature, dedupe, server) ────────────────
export * from "./webhook";
