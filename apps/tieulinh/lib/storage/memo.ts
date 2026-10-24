/**
 * Dựng một lần rồi nhớ lấy, khoá theo đường dẫn DB.
 *
 * Bốn chỗ trong repo từng tự chép lại đúng sáu dòng này — `openLazyDb`,
 * `getSharedBindingRepo`, `getSharedDraftSessionRepo`, và bộ nhớ
 * `IdentityService`. Chép tay thì dễ lỡ tay bỏ quên bước cache, mà bỏ quên ở
 * đây nghĩa là mở thêm một connection SQLite nữa tới cùng một file — đúng thứ
 * `openLazyDb` sinh ra để dẹp (xem chú thích đầu `lazy-db.ts`).
 */

/** Nhớ theo một khoá tự rút ra từ tham số. Dùng khi tham số không phải chính khoá. */
export function memoByKey<A, T>(
  keyOf: (arg: A) => string,
  create: (arg: A) => T,
): (arg: A) => T {
  const instances = new Map<string, T>();
  return (arg: A): T => {
    const key = keyOf(arg);
    const cached = instances.get(key);
    if (cached) return cached;
    const created = create(arg);
    instances.set(key, created);
    return created;
  };
}

/** Trường hợp hay gặp: tham số chính là `dbPath`, và cũng là khoá. */
export function memoByPath<T>(create: (dbPath: string) => T): (dbPath: string) => T {
  return memoByKey<string, T>((dbPath) => dbPath, create);
}
