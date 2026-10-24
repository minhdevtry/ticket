/**
 * Sending to Telegram SAFELY: safe inline buttons, a plain-text fallback when
 * Telegram rejects the markup, long-message splitting, and a receipt reaction.
 *
 * NGUỒN: intake `worker/notifier.ts` `api()` (parse-entities fallback, 40f7062),
 * intake `lib/telegram/buttons.ts` `dropUnsendable` (reused from
 * `../openclaw/pending-buttons`), intake `mcp/iris/domain/icons.json` "Quan sát":
 * "👀" (4595d00 — acknowledge receipt without noise), CM `lib/formatting.ts`
 * `catKyTu`/`TELEGRAM_TEXT_LIMIT` for splitting without breaking formatting.
 *
 * No Vietnamese literal lives in logic here — all strings are injected or come
 * from `../core`. No OpenClaw runtime import.
 */
import { dropUnsendableButtons, type TelegramButton } from "../openclaw/pending-buttons";
import { splitForTelegram } from "./split";
import {
  isEntityParseError,
  plainText,
  TelegramApiError,
  type TelegramTransport,
} from "./transport";

export type { TelegramButton } from "../openclaw/pending-buttons";

/** Telegram parse modes the sender knows how to downgrade on a parse error. */
export type ParseMode = "Markdown" | "MarkdownV2" | "HTML";

export interface SendMessageInput {
  chatId: string | number;
  text: string;
  /** Inline keyboard rows. Unsendable buttons are dropped, the message still goes. */
  buttons?: TelegramButton[][];
  parseMode?: ParseMode;
  /** Reply inside a forum topic / thread. */
  messageThreadId?: number;
  /** Called once if any button was dropped (e.g. route to admin alert). */
  onButtonDrop?: (reason: string) => void;
  /** Extra raw Bot API fields merged into every chunk's payload. */
  extra?: Record<string, unknown>;
}

export interface SentMessage {
  message_id: number;
  [k: string]: unknown;
}

/**
 * Send a message, keeping the user's words no matter what:
 *  1. drop any button Telegram would reject (a bad button makes Telegram refuse
 *     the WHOLE message — a dropped button beats a silent bot);
 *  2. split past the 4096 limit on a safe boundary;
 *  3. buttons ride only the LAST chunk (Telegram shows them under the last msg);
 *  4. if Telegram still rejects the markup, resend that chunk as plain text
 *     rather than lose it (commit 40f7062).
 *
 * Returns every message sent (one per chunk). Throws only if even the plain-text
 * resend fails — losing the message IS the failure the caller must know about.
 */
export async function sendMessage(
  transport: TelegramTransport,
  input: SendMessageInput,
): Promise<SentMessage[]> {
  const safeButtons = input.buttons
    ? dropUnsendableButtons(input.buttons, input.onButtonDrop)
    : undefined;
  const replyMarkup =
    safeButtons && safeButtons.length > 0 ? { inline_keyboard: safeButtons } : undefined;

  const chunks = splitForTelegram(input.text);
  const sent: SentMessage[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload: Record<string, unknown> = {
      chat_id: input.chatId,
      text: chunks[i],
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...(input.messageThreadId != null ? { message_thread_id: input.messageThreadId } : {}),
      ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(input.extra ?? {}),
    };
    sent.push(await sendOneWithFallback(transport, payload));
  }
  return sent;
}

/**
 * `call` one sendMessage payload; on a parse-entities rejection, drop
 * `parse_mode`, flatten `**` in text, and resend once. Any other failure throws.
 */
async function sendOneWithFallback(
  transport: TelegramTransport,
  payload: Record<string, unknown>,
): Promise<SentMessage> {
  try {
    return await transport.call<SentMessage>("sendMessage", payload);
  } catch (err) {
    if (!payload.parse_mode || !isEntityParseError(err)) throw err;
    const { parse_mode: _drop, ...rest } = payload;
    if (typeof rest.text === "string") rest.text = plainText(rest.text);
    return transport.call<SentMessage>("sendMessage", rest);
  }
}

/** The default "received" reaction emoji — intake `icons.json` "Quan sát". */
export const DEFAULT_ACK_EMOJI = "👀";

export interface AckReactionInput {
  chatId: string | number;
  messageId: number;
  /** Reaction emoji. Default 👀. */
  emoji?: string;
}

/**
 * Drop a receipt reaction on the user's message so they SEE the bot got it,
 * without a chat-cluttering "đã nhận" line (4595d00 kept emoji use minimal).
 *
 * A side job: uses `tryCall`, so a failure (old Bot API, reaction not allowed in
 * the chat) is logged and swallowed — it must never break the reply flow.
 * Returns true iff Telegram accepted the reaction.
 */
export async function ackReaction(
  transport: TelegramTransport,
  input: AckReactionInput,
): Promise<boolean> {
  const r = await transport.tryCall("setMessageReaction", {
    chat_id: input.chatId,
    message_id: input.messageId,
    reaction: [{ type: "emoji", emoji: input.emoji ?? DEFAULT_ACK_EMOJI }],
  });
  return r !== null;
}

export { TelegramApiError };
