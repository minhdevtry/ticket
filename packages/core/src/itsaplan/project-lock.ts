/**
 * Khoá dự án cho worker (ADR-0001).
 *
 * Mỗi dự án một process worker, nhưng webhook Itsaplan không lọc theo dự án và
 * nhiều worker dùng chung file SQLite. Mọi đường xử lý phải tự hỏi "ticket này
 * có phải của mình không" — các hàm ở đây là câu trả lời DUY NHẤT.
 *
 * MERGED (0.1.0): ported from intake `worker/project-lock.ts` (CM has no
 * counterpart). Moved out of a `worker/` path into the itsaplan layer because
 * it is pure tracker-identifier logic with no worker/channel coupling.
 */

/** Chuẩn hoá mã dự án: bỏ khoảng trắng, viết hoa; rỗng → null (không khoá). */
export function normalizeProjectKey(projectKey?: string | null): string | null {
  const key = String(projectKey ?? "")
    .trim()
    .toUpperCase();
  return key.length > 0 ? key : null;
}

/** Tiền tố dự án của một identifier "TECH-12" → "TECH"; không đọc được → null. */
export function projectOfIdentifier(identifier?: string | null): string | null {
  const match = String(identifier ?? "")
    .trim()
    .match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Identifier có thuộc dự án worker không.
 *
 * - Worker không khai dự án → nhận tất (giữ hành vi cũ cho môi trường test).
 * - Không đọc được dự án từ identifier → KHÔNG nhận: không biết là của ai thì
 *   không được đụng vào.
 */
export function identifierInProject(
  identifier: string | null | undefined,
  projectKey?: string | null,
): boolean {
  const own = normalizeProjectKey(projectKey);
  if (!own) return true;
  return projectOfIdentifier(identifier) === own;
}
