/**
 * Adapters wiring this Telegram layer to the intake engine's PORTS, so a bot can
 * drive the channel-free engine (`src/intake/engine`) over Telegram without the
 * engine importing anything channel-specific.
 *
 * Two seams, both injected INTO the engine (never the other way round — the
 * ticket forbids editing `src/intake/**`):
 *   1. `inboundMediaResolver` — satisfies the engine's `MediaResolver`
 *      (`resolve(explicitPaths, texts) → string[]`): explicit paths pass
 *      through, and when the reporter only HINTED at media ("em gửi ảnh rồi ạ")
 *      the recent inbound scan supplies the files.
 *   2. `TelegramChannelSender` — takes the engine's `ChannelMessage`
 *      (`{ text, buttons: InlineButton[][] }`), converts the channel-agnostic
 *      `InlineButton`s to Telegram's string form, and sends via `sendMessage`
 *      (safe buttons + plain-text fallback + splitting all come for free).
 */
import type { InlineButton } from "../intake/gate/types";
import type { ChannelMessage } from "../intake/engine/types";
import type { MediaResolver } from "../intake/ports";
import { findRecentInboundMedia, type MediaFinderOptions } from "./media";
import { sendMessage, type SendMessageInput, type SentMessage, type TelegramButton } from "./send";
import type { TelegramTransport } from "./transport";

/** Convert the engine's channel-agnostic rows to Telegram's string buttons. */
export function toTelegramButtons(rows: InlineButton[][]): TelegramButton[][] {
  return rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData })));
}

export interface InboundMediaResolverOptions extends MediaFinderOptions {
  /** How recent an inbound file counts as "the one the reporter just sent". Default 10 min. */
  maxAgeMinutes?: number;
  /** Max files to pull from a text-only hint. Default 5. */
  limit?: number;
  /** Injected clock. Default `Date.now`. */
  now?: () => number;
}

/**
 * The engine's `MediaResolver`: explicit paths pass through de-duplicated; if
 * none were given but the message carried a media hint (`texts` non-empty), fall
 * back to the recent inbound scan so a "gửi ảnh giúp em" still attaches the file.
 */
export function inboundMediaResolver(opts: InboundMediaResolverOptions): MediaResolver {
  return {
    resolve(explicitPaths: string[], texts: string[]): string[] {
      const explicit = Array.from(new Set(explicitPaths.filter(Boolean)));
      if (explicit.length > 0) return explicit;
      // No explicit path, but the reporter referenced media ⇒ scan recent inbound.
      const hinted = texts.some((t) => typeof t === "string" && t.trim().length > 0);
      if (!hinted) return [];
      return findRecentInboundMedia(opts, opts.maxAgeMinutes ?? 10, opts.limit ?? 5, opts.now).map(
        (a) => a.path,
      );
    },
  };
}

export interface TelegramChannelSenderOptions {
  transport: TelegramTransport;
  /** Default parse mode for sent messages (engine text is plain unless set). */
  parseMode?: SendMessageInput["parseMode"];
  /** Forum/topic thread id, if the chat uses topics. */
  messageThreadId?: number;
  /** Called once per send if any button was dropped (route to an Alerter). */
  onButtonDrop?: (reason: string) => void;
}

/**
 * A `ChannelPort`-style sender: hand it the engine's `ChannelMessage` for a chat
 * and it renders + sends it over Telegram. Returns the sent messages so a caller
 * can bind a reporter's chat to a ticket, ack, etc.
 */
export class TelegramChannelSender {
  constructor(private readonly opts: TelegramChannelSenderOptions) {}

  async send(chatId: string | number, message: ChannelMessage): Promise<SentMessage[]> {
    return sendMessage(this.opts.transport, {
      chatId,
      text: message.text,
      buttons: message.buttons ? toTelegramButtons(message.buttons) : undefined,
      parseMode: this.opts.parseMode,
      messageThreadId: this.opts.messageThreadId,
      onButtonDrop: this.opts.onButtonDrop,
    });
  }
}
