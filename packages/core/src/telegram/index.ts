/**
 * `@vuihoc/bot-core/telegram` — Telegram channel layer: Bot API transport, safe buttons,
 * admin alert, inbound media, message splitting, and rendering tracker text for Telegram.
 * Filled by tickets 12 (transport/media) and 13 (render).
 */

// ── transport ────────────────────────────────────────────────────────────────
export {
  type FetchLike,
  type TelegramTransportOptions,
  TelegramTransport,
  TelegramApiError,
  isEntityParseError,
  plainText,
  DEFAULT_TELEGRAM_BASE_URL,
} from "./transport";

// ── safe send / ack ──────────────────────────────────────────────────────────
export {
  type ParseMode,
  type SendMessageInput,
  type SentMessage,
  type TelegramButton,
  type AckReactionInput,
  sendMessage,
  ackReaction,
  DEFAULT_ACK_EMOJI,
} from "./send";

// ── message splitting ──────────────────────────────────────────────────────────
export { TELEGRAM_TEXT_LIMIT, splitForTelegram } from "./split";

// ── admin alert ────────────────────────────────────────────────────────────────
export {
  type AlerterOptions,
  Alerter,
  DEFAULT_DEDUPE_WINDOW_MS,
  buttonDropAlert,
} from "./alert";

// ── inbound media ──────────────────────────────────────────────────────────────
export {
  type MediaFinderOptions,
  type LocalMediaFile,
  type InboundAttachment,
  type ItsaplanMediaResolver,
  MAX_MEDIA_BYTES,
  sniffImageContentType,
  isAllowedPath,
  resolveInboundRef,
  readLocalMedia,
  findRecentInboundMedia,
  findLatestInboundMedia,
  createInboundMediaResolver,
} from "./media";

// ── intake-engine adapters ───────────────────────────────────────────────────
export {
  type InboundMediaResolverOptions,
  type TelegramChannelSenderOptions,
  toTelegramButtons,
  inboundMediaResolver,
  TelegramChannelSender,
} from "./adapter";

// ── pending buttons (re-exported from the shared openclaw contract) ──────────
export {
  type PendingButtonsFile,
  type PendingButtonsOptions,
  type ButtonDropAlert,
  MAX_CALLBACK_DATA_BYTES,
  dropUnsendableButtons,
  savePendingButtons,
  readPendingButtons,
  clearPendingButtons,
  normalizeTelegramId,
} from "../openclaw/pending-buttons";

// ── notify ChannelPort (platform-hardening) ─────────────────────────────────
export {
  type ReporterOkButtonSpec,
  type TelegramNotifyChannelOptions,
  TelegramNotifyChannel,
} from "./notify-channel";

// ── render (ticket 13) ───────────────────────────────────────────────────────
export * from "./render";
