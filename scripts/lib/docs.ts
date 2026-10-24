/** Tiện ích chung cho các script kiểm tra docs. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const DOCS = join(ROOT, "docs");

/** Thư mục không phải nguồn viết tay: bỏ qua khi quét. */
const SKIP_DIRS = new Set(["node_modules", ".vitepress", ".snippets", "api"]);

/** Mọi file .md viết tay trong docs/ (không gồm docs/reference/api do TypeDoc sinh). */
export function listDocPages(dir = DOCS): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "api" && dir.endsWith("reference")) continue;
      if (SKIP_DIRS.has(name) && name !== "api") continue;
      out.push(...listDocPages(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export interface Fence {
  /** Đường dẫn tương đối từ thư mục gốc repo. */
  file: string;
  /** Số dòng (1-based) của dòng mở fence. */
  line: number;
  lang: string;
  /** Các từ sau tên ngôn ngữ, vd `check`. */
  flags: string[];
  code: string;
}

/**
 * Tách các khối code có rào (``` hoặc ~~~). Khối bọc ngoài thắng: fence lồng bên trong
 * một khối dài hơn chỉ là nội dung.
 */
export function extractFences(file: string): Fence[] {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  const fences: Fence[] = [];
  let open: { char: string; len: number; line: number; lang: string; flags: string[] } | null =
    null;
  let body: string[] = [];
  lines.forEach((text, i) => {
    const m = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(text);
    if (!open) {
      if (!m) return;
      const info = m[2].trim().split(/\s+/).filter(Boolean);
      open = {
        char: m[1][0],
        len: m[1].length,
        line: i + 1,
        lang: (info[0] ?? "").toLowerCase(),
        flags: info.slice(1),
      };
      body = [];
      return;
    }
    if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === "") {
      fences.push({
        file: rel,
        line: open.line,
        lang: open.lang,
        flags: open.flags,
        code: body.join("\n"),
      });
      open = null;
      return;
    }
    body.push(text);
  });
  return fences;
}

/** Xoá các khối code rào khỏi văn bản (để quét inline code mà không dính code mẫu). */
export function stripFences(text: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (!fence) {
      if (m) fence = { char: m[1][0], len: m[1].length };
      else out.push(line);
    } else if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === "") {
      fence = null;
    }
  }
  return out.join("\n");
}
