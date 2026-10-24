/**
 * Deploy helpers (A2) — ba thao tác CHUNG mọi bot OpenClaw cần khi triển khai,
 * trừu tượng từ ba cách khác nhau (intake `bootstrap.ts`/`sync-workspace.ts`;
 * Bot-Sales `deploy_openclaw_sales.sh` + codex-home splice; CM scripts).
 *
 * Nguyên tắc: lib KHÔNG chạy lệnh host, KHÔNG đọc/ghi đĩa trực tiếp ở phần lõi —
 * mỗi host khác nhau (đường dẫn, provider, user). Thay vào đó lib cung cấp các
 * hàm THUẦN tính ra "nên ghi nội dung gì" / "lệnh build là gì" / "đã đủ điều kiện
 * build chưa", rồi BOT (script deploy của nó) thực hiện I/O. Nhờ vậy phần dễ sai
 * và lặp lại (ghép file idempotent, chèn khối config không nhân đôi, kiểm tiền đề
 * compile) nằm một chỗ, test được; phần host-specific ở lại script của bot.
 *
 * Vì sao ba bot cần cùng: cả ba đều (1) đồng bộ một bộ file workspace
 * (IDENTITY/SOUL/AGENTS/bot.json…) từ nguồn sang nơi gateway đọc; (2) ghép một
 * khối config (codex-home TOML của Sales, openclaw.json của intake) vào file đích
 * mà KHÔNG nhân đôi khi chạy lại; (3) đóng gói `bun build --compile` theo đúng
 * hai luật chống phình nhị phân (MCP import pure, lookup qua import).
 */

// ── 1. Sync workspace: tính kế hoạch ghi file idempotent ─────────────────────

export interface WorkspaceFile {
  /** Đường dẫn tương đối trong workspace đích, vd "IDENTITY.md", "bot.json". */
  path: string;
  /** Nội dung MONG MUỐN. */
  content: string;
}

export type SyncAction = "create" | "update" | "unchanged";

export interface SyncPlanEntry {
  path: string;
  action: SyncAction;
  /** Nội dung cần ghi (chỉ với create/update). */
  content?: string;
}

/**
 * Tính KẾ HOẠCH đồng bộ: so nội dung mong muốn với nội dung hiện có (bot đọc đĩa
 * rồi đưa vào `current`), trả danh sách create/update/unchanged. Idempotent:
 * chạy lại khi mọi thứ đã khớp cho ra toàn `unchanged` (không ghi gì). Lib không
 * tự ghi — bot lấy kế hoạch rồi ghi các entry create/update.
 *
 * `current`: map path → nội dung hiện tại trên đĩa (thiếu key = file chưa có).
 */
export function planWorkspaceSync(
  desired: WorkspaceFile[],
  current: Record<string, string | undefined>,
): SyncPlanEntry[] {
  return desired.map((f) => {
    const existing = current[f.path];
    if (existing === undefined) return { path: f.path, action: "create", content: f.content };
    if (existing === f.content) return { path: f.path, action: "unchanged" };
    return { path: f.path, action: "update", content: f.content };
  });
}

/** Tóm tắt kế hoạch cho log/báo cáo. */
export function summarizeSyncPlan(plan: SyncPlanEntry[]): { create: number; update: number; unchanged: number } {
  return {
    create: plan.filter((e) => e.action === "create").length,
    update: plan.filter((e) => e.action === "update").length,
    unchanged: plan.filter((e) => e.action === "unchanged").length,
  };
}

// ── 2. Splice config: chèn/thay một khối giữa marker, idempotent ──────────────

export interface SpliceOptions {
  /** Tên khối (hiện trong marker). Mặc định "bot-core". */
  blockName?: string;
  /** Ký tự mở đầu dòng comment của định dạng đích. TOML/sh = "#", JSON không hỗ trợ comment. */
  commentPrefix?: string;
}

const DEFAULT_BLOCK = "bot-core";

/**
 * Chèn `block` vào `original` giữa cặp marker `BEGIN/END <blockName>`. Nếu marker
 * đã có, THAY phần giữa (không nhân đôi — đây là chỗ codex-home splice của Sales
 * hay nhân bản khi chạy deploy nhiều lần). Nếu chưa có, nối vào cuối. Idempotent:
 * splice cùng block hai lần cho ra cùng kết quả.
 *
 * Dùng cho định dạng có comment theo dòng (TOML, sh, ini). KHÔNG dùng cho JSON
 * (JSON không có comment) — với JSON dùng `mergeJsonConfig`.
 */
export function spliceConfigBlock(original: string, block: string, opts: SpliceOptions = {}): string {
  const name = opts.blockName ?? DEFAULT_BLOCK;
  const cp = opts.commentPrefix ?? "#";
  const begin = `${cp} >>> ${name} BEGIN (quản lý tự động — đừng sửa tay trong khối)`;
  const end = `${cp} <<< ${name} END`;
  const body = `${begin}\n${block.trim()}\n${end}`;

  const beginIdx = original.indexOf(begin);
  if (beginIdx >= 0) {
    const endIdx = original.indexOf(end, beginIdx);
    if (endIdx >= 0) {
      const before = original.slice(0, beginIdx);
      const after = original.slice(endIdx + end.length);
      return `${before}${body}${after}`;
    }
  }
  // chưa có khối: nối vào cuối, chừa một dòng trống
  const base = original.replace(/\s*$/, "");
  return base.length > 0 ? `${base}\n\n${body}\n` : `${body}\n`;
}

/**
 * Gỡ khối đã splice (ví dụ gỡ cài). Trả nguyên văn nếu không có khối.
 */
export function removeConfigBlock(original: string, opts: SpliceOptions = {}): string {
  const name = opts.blockName ?? DEFAULT_BLOCK;
  const cp = opts.commentPrefix ?? "#";
  const begin = `${cp} >>> ${name} BEGIN (quản lý tự động — đừng sửa tay trong khối)`;
  const end = `${cp} <<< ${name} END`;
  const b = original.indexOf(begin);
  if (b < 0) return original;
  const e = original.indexOf(end, b);
  if (e < 0) return original;
  const before = original.slice(0, b).replace(/\n*$/, "");
  const after = original.slice(e + end.length).replace(/^\n*/, "");
  return [before, after].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Ghép (shallow-merge) config JSON idempotent: trả object đã trộn `patch` lên
 * `base`. Dùng cho openclaw.json (không có comment để splice). Mảng và giá trị
 * nguyên thủy ở `patch` GHI ĐÈ; object lồng nhau trộn nông một cấp. Chạy lại cùng
 * patch cho ra cùng kết quả.
 */
export function mergeJsonConfig<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ── 3. Build binary: dựng lệnh + kiểm tiền đề (không chạy) ────────────────────

export interface BuildBinaryOptions {
  /** File vào, vd "mcp/op/index.ts". */
  entrypoint: string;
  /** File nhị phân ra, vd "dist/op-mcp". */
  outfile: string;
  /** Target compile, vd "bun-linux-x64". Bỏ trống = target máy đang build. */
  target?: string;
  /** Bật minify. Mặc định false (giữ stack trace đọc được). */
  minify?: boolean;
  /** Tên lệnh bun. Mặc định "bun". */
  bunBin?: string;
}

/**
 * Dựng ĐÚNG lệnh `bun build --compile` dưới dạng mảng argv (không chạy — bot tự
 * spawn). Trả argv để tránh lỗi quote khi nối chuỗi.
 */
export function buildBinaryCommand(opts: BuildBinaryOptions): string[] {
  const argv = [opts.bunBin ?? "bun", "build", opts.entrypoint, "--compile", "--outfile", opts.outfile];
  if (opts.target) argv.push("--target", opts.target);
  if (opts.minify) argv.push("--minify");
  return argv;
}

export interface CompileReadinessInput {
  /** Nội dung file entrypoint (bot đọc đưa vào) — để quét vi phạm luật nhị phân. */
  entrypointSource: string;
  /** Nội dung các file MCP-server/tool liên quan (tùy chọn) — quét sâu hơn. */
  extraSources?: string[];
}

export interface CompileReadinessIssue {
  severity: "block" | "warn";
  code: string;
  message: string;
}

/**
 * Kiểm hai LUẬT chống phình nhị phân mà intake README chốt (nếu vi phạm thì
 * `bun build --compile` kéo cả runtime vào hoặc nhị phân không tìm thấy lookup
 * table):
 *   1. MCP import pure — không kéo agent runtime vào qua một import nặng (vd
 *      `getLogger()` từng kéo cả runtime + native module). Cảnh báo khi thấy
 *      import từ gói runtime nặng trong file MCP entrypoint.
 *   2. Lookup table nạp bằng `import`, KHÔNG `readFileSync` (readFileSync không
 *      sống sót qua `--compile`). Block khi thấy `readFileSync`/`readFile(` một
 *      file dữ liệu trong nguồn compile.
 *
 * Thuần: nhận nội dung nguồn, trả danh sách vấn đề. Bot gọi trước khi build.
 */
export function checkCompileReadiness(input: CompileReadinessInput): CompileReadinessIssue[] {
  const issues: CompileReadinessIssue[] = [];
  const sources = [input.entrypointSource, ...(input.extraSources ?? [])];
  const joined = sources.join("\n");

  // Luật 2: readFileSync/readFile cho lookup — không sống sót --compile.
  if (/\breadFileSync\s*\(/.test(joined) || /\breadFile\s*\(/.test(joined)) {
    issues.push({
      severity: "block",
      code: "readfile-in-compile",
      message:
        "Nguồn compile dùng readFileSync/readFile — không sống sót `bun build --compile` (nhị phân sẽ không tìm thấy file). Nạp lookup table bằng `import` thay vì đọc đĩa.",
    });
  }

  // Luật 1: import gói runtime nặng trong entrypoint MCP → kéo cả runtime vào.
  const HEAVY_RUNTIME = /(from|require\()\s*["']@openclaw\/|openclaw-runtime|["']telegraf["']|["']node-telegram-bot-api["']/;
  if (HEAVY_RUNTIME.test(input.entrypointSource)) {
    issues.push({
      severity: "warn",
      code: "heavy-runtime-import",
      message:
        "Entrypoint MCP import một gói runtime nặng (OpenClaw/Telegram client) — có thể kéo cả runtime + native module vào nhị phân. MCP chỉ nên import code thuần.",
    });
  }

  return issues;
}

/** Build có an toàn để chạy không (không có vấn đề `block`)? */
export function isCompileReady(input: CompileReadinessInput): boolean {
  return !checkCompileReadiness(input).some((i) => i.severity === "block");
}
