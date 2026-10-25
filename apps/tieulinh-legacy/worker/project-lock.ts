import { normalizeProjectKey, projectOfIdentifier } from "@vuihoc/bot-core/itsaplan";

/**
 * Khoá dự án chung (`normalizeProjectKey`, `projectOfIdentifier`,
 * `identifierInProject`) nằm ở `@vuihoc/bot-core/itsaplan`. File này chỉ giữ luật
 * RIÊNG của Tiểu Linh: mã dự án nào thuộc phạm vi bot này.
 */

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
