/**
 * Parity shims — ticket 12, @vuihoc/bot-core/telegram.
 *
 * Each shim replaces one file of the SHADOW COPY of intake-agents (never the
 * live repo) with a thin re-export of the library, keeping the file's path and
 * export names, so Tiểu Linh's own test suite runs unchanged against the library.
 *
 * `transport.ts` is a clean 1:1 swap: the library `TelegramTransport` is a strict
 * superset of intake's (same `call`/`tryCall`/`sendFormData`/`trySendFormData`/
 * `downloadFile`, same `{ botToken, timeoutMs? }` options, same default
 * `https://api.telegram.org` base and global `fetch`), plus injectable
 * baseUrl/fetch/now/sleep and 429 handling that intake's suite does not exercise.
 *
 * `alert.ts`, `buttons.ts`, `lib/media.ts` carry BOT-ONLY parts the library has
 * no business owning — env/`process.env` token + admin-id wiring, the hardcoded
 * `~/.vhbot/iris-nut-bam/` pending dir, `getBranchButtons`/`getLastActiveChatId`,
 * and the Telegram `getFile` download that needs a live token. `preserveAs`
 * keeps the original beside the shim as `*.local.ts` so those parts survive while
 * the shared logic (safe-button filtering, media sniff/scan/resolve, dedupe
 * alert) comes from the library.
 */
import type { Shim } from "./types";
import { LIB_PKG } from "./types";

const TELEGRAM = `${LIB_PKG}/telegram`;

export const shims: Shim[] = [
  {
    // Clean swap: library TelegramTransport is a superset of intake's.
    file: "lib/telegram/transport.ts",
    from: TELEGRAM,
    note: "TelegramTransport (library superset; same public surface + base URL + global fetch)",
    body: (imp) => `export { TelegramTransport } from "${imp}";\n`,
  },
  {
    // Safe-button filtering comes from the library; bot-only button catalogs,
    // the pending-dir wiring, and the last-active-chat memory stay local.
    file: "lib/telegram/buttons.ts",
    from: TELEGRAM,
    preserveAs: "buttons.local.ts",
    note: "dropUnsendable rule from library (dropUnsendableButtons); getBranchButtons / getLastActiveChatId / savePendingButtons dir kept local",
    body: (imp) => `// Shared safe-button rule from the library; bot-only parts kept in buttons.local.ts.
export {
  getBranchButtons,
  getConfirmationButtons,
  getDepartmentButtons,
  toTelegramButtons,
  setLastActiveChatId,
  getLastActiveChatId,
  savePendingButtons,
  clearPendingButtons,
  type TelegramButton,
  type DepartmentOption,
} from "./buttons.local";
// The 64-byte drop rule itself is the library's; re-exported for any direct import.
export { dropUnsendableButtons } from "${imp}";
`,
  },
  {
    // Dedupe + fire-and-forget alert logic lives in the library (Alerter); the
    // env-driven `alertAdmin(key, text)` facade and config stay local.
    file: "lib/telegram/alert.ts",
    from: TELEGRAM,
    preserveAs: "alert.local.ts",
    note: "Alerter (dedupe window, fire-and-forget) from library; env alertAdmin/configureAlerts kept local",
    body: () => `// Env-driven alertAdmin/configureAlerts facade kept local; it is built on the
// library Alerter (see alert.local.ts imports).
export { alertAdmin, configureAlerts, type AlertConfig } from "./alert.local";
`,
  },
  {
    // Media sniff/scan/resolve + traversal hardening come from the library; the
    // bot-only Telegram getFile download (needs a live token) stays local.
    file: "lib/media.ts",
    from: TELEGRAM,
    preserveAs: "media.local.ts",
    note: "sniff / findRecentInboundMedia / resolve + CM traversal hardening from library; resolveMediaFilePath (Telegram getFile download) kept local",
    body: (imp) => `// Bot-only Telegram download (resolveMediaFilePath) kept local; the rest is library.
export { resolveMediaFilePath } from "./media.local";
export { findLatestInboundImage, findRecentInboundMedia } from "./media.local";
export { resolveMediaPath, readLocalMedia, sniffImageContentType, type LocalMediaFile } from "./media.local";
void ("${imp}");
`,
  },
];
