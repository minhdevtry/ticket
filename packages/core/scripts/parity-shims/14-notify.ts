/**
 * Parity shims for ticket 14 (notify / webhook) — contributed to
 * scripts/shadow-parity.ts via the `shims: Shim[]` export convention.
 *
 * WHAT CAN BE SHIMMED, AND WHAT CANNOT
 * ------------------------------------
 * intake `worker/webhook-server.ts` is a MIX of two things:
 *   (a) PURE, behaviour-identical helpers — `verifyItsaplanSignature`,
 *       `webhookDedupeKey`, `isLoopback` — and the `ItsaplanWebhookActor` /
 *       `ItsaplanWebhookEnvelope` types. These are ported verbatim into
 *       `@vuihoc/bot-core/itsaplan` (src/itsaplan/webhook/events.ts), so the
 *       shim re-exports them from the library.
 *   (b) the `ItsaplanWebhookServer` CLASS, which is bot-entangled: it wires the
 *       OpenClaw-only internal endpoints to intake's `ticket-closure` handler
 *       TYPES (`ReporterOkResult`/`ReporterReplyResult`), keeps the in-RAM
 *       dedupe Set, and registers the live Telegram-handler plumbing. The
 *       library server exists but takes INJECTED, channel-free handlers with a
 *       different shape, so it is NOT a drop-in for intake's class. It stays
 *       local, preserved as `webhook-server.local.ts`, and the shim re-exports
 *       the class + handler/options types + the server-level `start` plumbing
 *       from there unchanged.
 *
 * `worker/notification-dispatcher.ts` and `worker/ticket-closure.ts` are NOT
 * shimmed: both are stateful classes bound to intake's SQLite schema
 * (`ticket_states`, in-process `isCommentRecentlyForwarded`), the live
 * `Notifier`/`TicketBindingRepository` and the KG/Onyx/duplicate-merger side
 * effects. The library's `NotificationDispatcher`/`ReplyRouter` carry the SAME
 * RULES but through injected ports (ChannelPort, StateChangeCopyMap,
 * MessageRouteStore), so a byte-for-byte swap would change construction and
 * drift the intake suite. Shimming them is a behaviour change, not a parity
 * swap — left out deliberately.
 *
 * `project-lock.ts` (which the notify path depends on) is already shimmed by
 * the harness's built-in list.
 */
import type { Shim } from "./types";
import { LIB_PKG } from "./types";

const ITSAPLAN = `${LIB_PKG}/itsaplan`;

export const shims: Shim[] = [
  {
    file: "worker/webhook-server.ts",
    from: ITSAPLAN,
    preserveAs: "webhook-server.local.ts",
    note:
      "pure helpers (verifyItsaplanSignature, webhookDedupeKey, isLoopback) + envelope/actor types delegated to the library; the bot-coupled ItsaplanWebhookServer class + handler/options types kept in webhook-server.local.ts (OpenClaw endpoints + ticket-closure handler shapes + in-RAM dedupe are intake-only)",
    body: (imp) =>
      `// SHIM → ${imp} for the PURE webhook helpers; bot-coupled server kept local.\n` +
      `export {\n` +
      `  type ItsaplanWebhookActor,\n` +
      `  type ItsaplanWebhookEnvelope,\n` +
      `  verifyItsaplanSignature,\n` +
      `  webhookDedupeKey,\n` +
      `  isLoopback,\n` +
      `} from "${imp}";\n` +
      `// Bot-only: HTTP server class, its options and the OpenClaw internal-endpoint\n` +
      `// handler types stay in the original, preserved beside this shim.\n` +
      `export {\n` +
      `  type WebhookEventHandler,\n` +
      `  type TelegramUpdateHandler,\n` +
      `  type ItsaplanWebhookServerOptions,\n` +
      `  type ReporterOkHandler,\n` +
      `  type ReporterReplyHandler,\n` +
      `  type ForceNewHandler,\n` +
      `  ItsaplanWebhookServer,\n` +
      `} from "./webhook-server.local";\n`,
  },
];
