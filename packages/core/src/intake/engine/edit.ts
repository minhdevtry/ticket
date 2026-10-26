/**
 * Sửa ticket đã có và trích xuất nội dung ticket (ADR-0008 quyết định 5).
 *
 * Mọi thao tác sửa đều qua bộ lập kế hoạch sửa (planEdit) -> áp thử tất định
 * (applyEditOps) -> xem trước thay đổi -> người báo xác nhận -> kiểm tra xung đột nền
 * (optimistic concurrency check) -> cập nhật tracker và ghi comment dấu vết ✏️.
 */
import { parseJsonLoose } from "../../llm/extract";
import type { LlmConfig, CompleteFn } from "../extractor/llm-extractor";
import { withTimeout } from "./timeout";
export type EditOp =
  | { type: "title"; value: string }
  /** Dòng "- <label>: <giá trị>" ở mục "Thông tin sự cố" — thêm dòng nếu chưa có. */
  | { type: "field"; label: string; value: string }
  /** Thay một đoạn nguyên văn trong mô tả. */
  | { type: "replace"; old: string; new: string };

export interface EditChange {
  what: string;
  before: string;
  after: string;
}

export interface EditAppliedResult {
  title: string;
  description: string;
  changes: EditChange[];
  rejected: EditOp[];
}

export interface EditLabels {
  title?: string;
  description?: string;
  notPresent?: string;
}

export interface PlanEditOptions {
  timeoutMs?: number;
  editPrompt?: string;
}
const EDIT_PROMPT = `Người báo lỗi đề nghị sửa ticket. Dựa vào tiêu đề + mô tả hiện tại và lời đề nghị, trả về các thao tác sửa TỐI THIỂU.
Thao tác:
- {"type":"title","value":"<tiêu đề mới>"}
- {"type":"field","label":"<nhãn dòng ở mục Thông tin sự cố, đúng như đang có, vd 'Tài khoản HS / SĐT', 'Mã khách hàng', 'Bộ phận'>","value":"<giá trị mới>"}
- {"type":"replace","old":"<đoạn NGUYÊN VĂN đang có trong mô tả>","new":"<đoạn thay thế>"}
Không bịa, không sửa gì ngoài lời đề nghị. Không hiểu được thì trả ops rỗng.
Trả về ĐÚNG một object JSON: {"ops": [...]}`;

export async function planEdit(
  llm: LlmConfig,
  input: { title: string; description: string; instruction: string },
  completeFn?: CompleteFn,
  timeoutMsOrOptions: number | PlanEditOptions = 45_000,
): Promise<EditOp[]> {
  if (!completeFn) return [];
  const timeoutMs =
    typeof timeoutMsOrOptions === "object"
      ? (timeoutMsOrOptions.timeoutMs ?? 45_000)
      : timeoutMsOrOptions;
  const prompt =
    typeof timeoutMsOrOptions === "object"
      ? (timeoutMsOrOptions.editPrompt ?? EDIT_PROMPT)
      : EDIT_PROMPT;
  const raw = await withTimeout(
    completeFn(
      llm,
      prompt,
      `Tiêu đề: ${input.title}\n\nMô tả hiện tại:\n${input.description.slice(0, 6000)}\n\nĐề nghị sửa:\n"${input.instruction}"`,
    ),
    timeoutMs,
    "ticket-edit",
  );
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object") return [];
  const ops = "ops" in parsed && Array.isArray(parsed.ops) ? parsed.ops : [];
  const out: EditOp[] = [];
  for (const o of ops) {
    if (!o || typeof o !== "object") continue;
    const op = o as Record<string, unknown>;
    if (op.type === "title" && typeof op.value === "string" && op.value.trim()) {
      out.push({ type: "title", value: op.value.trim() });
    } else if (
      op.type === "field" &&
      typeof op.label === "string" &&
      typeof op.value === "string" &&
      op.label.trim() &&
      op.value.trim()
    ) {
      out.push({ type: "field", label: op.label.trim(), value: op.value.trim() });
    } else if (
      op.type === "replace" &&
      typeof op.old === "string" &&
      typeof op.new === "string" &&
      op.old.trim()
    ) {
      out.push({ type: "replace", old: op.old, new: op.new });
    }
  }
  return out;
}

/**
 * Áp thao tác sửa một cách tất định. Thao tác không áp được (đoạn cũ không có /
 * có nhiều chỗ) bị bỏ và ghi vào `rejected` để không sửa mù.
 */
export function applyEditOps(
  title: string,
  description: string,
  ops: EditOp[],
  labels?: EditLabels,
): EditAppliedResult {
  let t = title;
  let d = description;
  const changes: EditChange[] = [];
  const rejected: EditOp[] = [];
  const titleLabel = labels?.title ?? "Title";
  const descLabel = labels?.description ?? "Description";
  const notPresentLabel = labels?.notPresent ?? "(none)";

  for (const op of ops) {
    if (op.type === "title") {
      if (op.value !== t) changes.push({ what: titleLabel, before: t, after: op.value });
      t = op.value;
    } else if (op.type === "field") {
      const esc = op.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^(- ${esc}:)[ \\t]*(.*)$`, "m");
      const m = d.match(re);
      if (m) {
        if (m[2].trim() !== op.value)
          changes.push({ what: op.label, before: m[2].trim(), after: op.value });
        d = d.replace(re, `$1 ${op.value}`);
      } else {
        const head = d.indexOf("## Thông tin sự cố");
        if (head < 0) {
          rejected.push(op);
          continue;
        }
        // Chèn cuối danh sách "- …" của mục Thông tin sự cố
        const lines = d.slice(head).split("\n");
        let i = 1;
        while (i < lines.length && lines[i].trim() === "") i++;
        while (i < lines.length && lines[i].startsWith("- ")) i++;
        lines.splice(i, 0, `- ${op.label}: ${op.value}`);
        d = d.slice(0, head) + lines.join("\n");
        changes.push({ what: op.label, before: notPresentLabel, after: op.value });
      }
    } else {
      const count = d.split(op.old).length - 1;
      if (count !== 1) {
        rejected.push(op);
        continue;
      }
      d = d.replace(op.old, op.new);
      changes.push({ what: descLabel, before: op.old, after: op.new });
    }
  }
  return { title: t, description: d, changes, rejected };
}

/** Phần "Mô tả" (giữa "### Mô tả" và mục kế tiếp) và các dòng ảnh của một mô tả ticket. */
export function descriptionBody(description: string): { body: string; images: string[] } {
  const start = description.indexOf("### Mô tả");
  let body = "";
  if (start >= 0) {
    const rest = description.slice(start + "### Mô tả".length);
    const end = rest.search(/\n(### |---)/);
    body = (end < 0 ? rest : rest.slice(0, end)).trim();
  }
  const images = description.match(/!\[[^\]]*\]\([^)]+\)/g) ?? [];
  return { body, images };
}
