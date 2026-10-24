/**
 * Một bộ nạp env cho mọi bot — để hai client trong cùng một repo không phân
 * tích env theo hai kiểu khác nhau (Bot-Sales đang có `mcp/crm/env.ts` và
 * `plugins/.../crm-mini.mjs` chép lệch nhau).
 *
 * MERGED (0.1.0):
 *  - `parseEnvContent`/`loadEnvFile` + `LoadEnvResult`: NGUỒN Bot-Sales `mcp/crm/env.ts`
 *    (nguyên văn) — nạp từ file, không ghi đè biến đã có.
 *  - `parseEnvFile`/`loadEnvDefaults` + kiểu kết quả: NGUỒN CM `lib/env-defaults.ts`,
 *    phần CHUNG. `prefix` mặc định đổi từ `"CM_"` sang `""` (mọi key) để trung lập;
 *    bot muốn lọc theo tiền tố tự truyền `{ prefix: "CM_" }`. Hỗ trợ `export ` và
 *    kiểm tra tên key hợp lệ là phần CM thêm so với Bot-Sales.
 *
 * ĐỂ LẠI NGOÀI LÕI: `loadConfig`/`cmConfigSchema` của CM (schema `CM_*` riêng).
 */
import { existsSync, readFileSync } from "node:fs";

// ── Bot-Sales API (nạp từ file, bỏ nháy quanh value) ─────────────────────────

/**
 * Phân tích nội dung file .env dạng KEY=VALUE.
 * Bỏ dòng trống/chú thích, tách tại `=` đầu tiên, bỏ nháy đơn/kép bao quanh value.
 * NGUỒN: Bot-Sales `parseEnvContent`.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }

    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      if (value.length >= 2) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }

  return result;
}

export interface LoadEnvResult {
  ok: boolean;
  loadedCount: number;
  error?: string;
}

/**
 * Nạp biến môi trường từ file env (nếu có), KHÔNG ghi đè biến đã có trong
 * `targetEnv`. Trả về `{ ok, loadedCount, error }` thay vì ném lỗi làm crash.
 * NGUỒN: Bot-Sales `loadEnvFile`.
 */
export function loadEnvFile(
  filePath: string,
  targetEnv: Record<string, string | undefined> = process.env,
): LoadEnvResult {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseEnvContent(content);
    let loadedCount = 0;

    for (const [key, value] of Object.entries(parsed)) {
      if (targetEnv[key] === undefined) {
        targetEnv[key] = value;
        loadedCount++;
      }
    }

    return { ok: true, loadedCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, loadedCount: 0, error: message };
  }
}

// ── CM API (process.env luôn thắng; báo cáo tên key, không in giá trị) ────────

/** Bỏ cặp nháy bao quanh và escape `\n`/`\t` kiểu dotenv. NGUỒN: CM. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      return first === '"' ? inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : inner;
    }
  }
  const hash = trimmed.indexOf(" #");
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trimEnd();
}

/** Đọc `KEY=VALUE` từ nội dung file. Bỏ dòng trống, `#`, và `export `. NGUỒN: CM. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(withoutExport.slice(eq + 1));
  }
  return out;
}

export interface EnvDefaultsResult {
  /** File đã đọc, hoặc `""` nếu không tồn tại. */
  file: string;
  /** Key đã có trong `env` ngay khi nạp ⇒ tiến trình cha quyết. */
  fromProcess: string[];
  /** Key lấy từ file vì `env` chưa có. */
  applied: string[];
  /** Key đã có trong `env` ⇒ giữ nguyên giá trị tiến trình. */
  kept: string[];
}

export interface LoadEnvDefaultsOptions {
  /** Chỉ xét các key có tiền tố này. Mặc định `""` = mọi key (trung lập). */
  prefix?: string;
}

/**
 * Bổ sung các key còn thiếu trong `env` từ `envFilePath`. Idempotent. KHÔNG bao
 * giờ ghi đè key đã tồn tại, kể cả khi giá trị là chuỗi rỗng. NGUỒN: CM
 * `loadEnvDefaults` — `prefix` mặc định đổi sang `""` cho trung lập.
 */
export function loadEnvDefaults(
  envFilePath: string,
  env: Record<string, string | undefined> = process.env,
  options: LoadEnvDefaultsOptions = {},
): EnvDefaultsResult {
  const prefix = options.prefix ?? "";
  const result: EnvDefaultsResult = { file: "", fromProcess: [], applied: [], kept: [] };
  result.fromProcess = Object.keys(env)
    .filter((key) => (prefix ? key.startsWith(prefix) : true))
    .sort();
  if (!existsSync(envFilePath)) return result;
  result.file = envFilePath;

  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(envFilePath, "utf-8")))) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (Object.hasOwn(env, key)) {
      result.kept.push(key);
      continue;
    }
    env[key] = value;
    result.applied.push(key);
  }
  return result;
}
