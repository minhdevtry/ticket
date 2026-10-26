/**
 * `@vuihoc/bot-core/intake` notify (ticket 14): webhook → chat dispatcher and
 * reply router. Channel-free (sends through `ChannelPort`), copy-free (strings
 * through injected maps). Pairs with `@vuihoc/bot-core/itsaplan/webhook`.
 */
export * from "./dispatcher";
export * from "./reply-router";
export * from "./stores";
export * from "./outbox";
export * from "./log-channel";
export * from "./supplement-notifier";
