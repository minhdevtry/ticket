/**
 * Khoá dự án cho worker.
 *
 * Mỗi dự án một process worker (ITSAPLAN_PROJECT_KEY), nhưng webhook Itsaplan
 * không lọc theo dự án và hai worker dùng chung file SQLite. Mọi đường xử lý
 * phải tự hỏi "ticket này có phải của mình không" — hàm ở đây là câu trả lời
 * duy nhất, để các nơi không tự so chuỗi mỗi chỗ một kiểu.
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
 *   không được đụng vào (trước đây tiền tố rỗng lại lọt qua).
 */
export function identifierInProject(
  identifier: string | null | undefined,
  projectKey?: string | null,
): boolean {
  const own = normalizeProjectKey(projectKey);
  if (!own) return true;
  return projectOfIdentifier(identifier) === own;
}

/**
 * Dự án có thuộc phạm vi của Tiểu Linh (mặc định "TECH", hoặc dự án worker khi không phải "PO").
 * Các quy tắc W29 (chặn ticket đã đóng, cc @assignee) chỉ áp dụng cho Tiểu Linh/TECH,
 * tuyệt đối không áp dụng cho Iris/PO.
 */
export function isTieuLinhProject(
  projectKeyOrIdentifier?: string | null,
  configuredProject?: string | null,
): boolean {
  const raw = normalizeProjectKey(projectKeyOrIdentifier);
  const target = raw ? (projectOfIdentifier(raw) ?? raw) : null;
  const configured = normalizeProjectKey(configuredProject);
  if (target === "PO" || configured === "PO") return false;
  if (target === "TECH" || (!target && configured === "TECH")) return true;
  if (configured && target === configured) return true;
  return target === "TECH";
}
