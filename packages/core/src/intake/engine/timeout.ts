/**
 * Promise timeout helper with descriptive error label.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
