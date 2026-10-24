/**
 * Per-chat in-process lock (ticket 08).
 *
 * Serializes work for one chat so two confirm-clicks arriving nearly together
 * cannot both create a ticket: the second waits for the first, then sees the
 * ticket already made. The cross-PROCESS guard is `tryInsertRevision`; this
 * handles the common in-process race.
 *
 * NGUỒN: intake `mcp/shared/tools/create-issue.ts` — `withChatLock` /
 * `chatLockKey`.
 */

const chatLocks = new Map<string, Promise<void>>();

/** Collapse "telegram:123" and "123" to one lock key. */
export function chatLockKey(chatId: string | number): string {
  const raw = String(chatId).trim();
  const m = /^(?:telegram:|tg:)?(-?\d+)$/i.exec(raw);
  return m ? m[1] : raw;
}

/** Run `fn` serially per chat. */
export async function withChatLock<T>(chatId: string | number, fn: () => Promise<T>): Promise<T> {
  const key = chatLockKey(chatId);
  const prev = chatLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const chained = prev.then(() => current);
  chatLocks.set(key, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (chatLocks.get(key) === chained) chatLocks.delete(key);
  }
}
