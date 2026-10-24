/**
 * Admin alert channel.
 *
 * NGUỒN: intake `lib/telegram/alert.ts` (`alertAdmin`, 14/09/2026 incident) +
 * `feat(telegram)` e2b4891. Born from the 14/09 incident: `sendMessage` returned
 * `400 BUTTON_DATA_INVALID`, the bot went silent, and the only trace was one line
 * in `journalctl` nobody read — a silent failure for three days. A log is for
 * investigating AFTER you know something broke; it is no substitute for telling
 * a human.
 *
 * KEPT from intake, two deliberate properties:
 *  - fire-and-forget: an alert that fails must NEVER break the running flow;
 *  - dedupe by `key`: these calls sit on the path of EVERY chat turn, so without
 *    coalescing one persistent fault becomes hundreds of messages — spam ignored
 *    is as good as no alert.
 *
 * CHANGED from intake: the transport, the admin chat ids, and the clock are all
 * INJECTED (no `process.env`, no hardcoded `TelegramTransport` built from env),
 * so the library stays config-free and testable. The bot wires env → `Alerter`.
 */
import { getLogger } from "../core/logger";
import type { TelegramTransport } from "./transport";

/** Same message is not re-sent until this long has passed. Default 30 min (intake). */
export const DEFAULT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

export interface AlerterOptions {
  /** The transport the alert goes out on. Omit to log only. */
  transport?: TelegramTransport;
  /** Chat ids that receive alerts (admin ids). Empty ⇒ log only. */
  adminChatIds?: Array<string | number>;
  /** Dedupe window in ms. Default 30 min. */
  dedupeWindowMs?: number;
  /** Injected clock. Default `Date.now`. */
  now?: () => number;
  /** Prefix prepended to every alert text. Default "⚠️ ". */
  prefix?: string;
}

/**
 * Tell the admin something is wrong. Does not `await` the send — a failed alert
 * is accepted; the main flow must keep running.
 *
 * `key` is the dedupe key: set it by FAULT TYPE, never by a per-turn-changing
 * value, or coalescing becomes meaningless.
 */
export class Alerter {
  private readonly transport?: TelegramTransport;
  private readonly adminChatIds: Array<string | number>;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly lastSentAt = new Map<string, number>();

  constructor(options: AlerterOptions = {}) {
    this.transport = options.transport;
    this.adminChatIds = options.adminChatIds ?? [];
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.prefix = options.prefix ?? "⚠️ ";
  }

  /** Fire-and-forget alert. Returns true if an alert was dispatched (not deduped). */
  alert(key: string, text: string): boolean {
    const now = this.now();
    const previous = this.lastSentAt.get(key);
    if (previous !== undefined && now - previous < this.dedupeWindowMs) return false;
    this.lastSentAt.set(key, now);

    getLogger().error(`[alert] ${text}`);

    if (!this.transport || this.adminChatIds.length === 0) {
      getLogger().warn("[alert] Chưa cấu hình transport/adminChatIds — báo động chỉ nằm trong log.");
      return false;
    }

    for (const chatId of this.adminChatIds) {
      // tryCall swallows failures; if even that throws synchronously, catch here —
      // an alert that fails has no further channel to report on.
      void this.transport
        .tryCall("sendMessage", { chat_id: chatId, text: `${this.prefix}${text}` })
        .catch(() => {
          /* already logged by tryCall */
        });
    }
    return true;
  }

  /** Reset the dedupe memory (e.g. at startup / between tests). */
  reset(): void {
    this.lastSentAt.clear();
  }
}

/** A plain `(reason) => void` button-drop sink backed by an `Alerter`. */
export function buttonDropAlert(alerter: Alerter, key = "callback-data-qua-dai") {
  return (reason: string): void => {
    alerter.alert(key, reason);
  };
}
