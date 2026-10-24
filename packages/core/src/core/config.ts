/**
 * Cấu hình có kiểu từ biến môi trường: khai báo schema zod MỘT lần, nạp MỘT lần
 * lúc khởi động, thiếu/sai thì dừng ngay với một thông báo gom đủ mọi lỗi.
 *
 * Nguyên tắc:
 *  - `loadConfig` KHÔNG tự đọc `process.env`: caller truyền `env` tường minh
 *    (bot thật truyền `process.env`, test truyền object). Không có "phép màu".
 *  - File `.env` chỉ được nạp khi caller truyền `envFile`; biến đã có trong `env`
 *    luôn thắng file. Không bao giờ ghi ngược vào `process.env`.
 *  - Secret không bao giờ nằm trong thông báo lỗi hay log: `redacted` thay giá
 *    trị bằng `[REDACTED]`, thông báo lỗi chỉ nêu TÊN biến và lý do.
 *  - Chuỗi rỗng coi như chưa đặt (`FOO=` trong file .env là thói quen phổ biến).
 *
 * ```ts
 * const schema = defineEnv({
 *   ITSAPLAN_BASE_URL: z.url(),
 *   ITSAPLAN_AGENT_KEY: secret(z.string().min(1)),
 *   PORT: z.coerce.number().int().default(3000),
 * });
 * const cfg = loadConfig(schema, { env: process.env, envFile: ".env" });
 * cfg.values.PORT; // number
 * getLogger().info("config", cfg.redacted);
 * ```
 */
import type { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { parseEnvFile } from "./env";

/** Hình dạng schema env: tên biến → schema zod của giá trị (chuỗi vào, kiểu ra tuỳ ý). */
export type EnvShape = Record<string, z.ZodType>;

/** Kiểu giá trị sau khi parse của một `EnvShape`. */
export type InferEnv<S extends EnvShape> = { [K in keyof S]: z.output<S[K]> };

/** Giá trị thay thế secret trong `redacted` và log. */
export const REDACTED = "[REDACTED]";

/** Tên biến trông như secret thì tự ẩn, kể cả khi quên bọc `secret()`. */
const SECRET_NAME = /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|DSN)(?:$|_)/i;

const secretSchemas = new WeakSet<object>();

/**
 * Đánh dấu một schema là secret: giá trị bị ẩn khỏi `redacted`/log/thông báo
 * lỗi. Trả lại CHÍNH schema đó nên dùng được ở chỗ nào cần schema. Bọc schema CUỐI
 * CÙNG (sau `.optional()`/`.default()`): `secret(z.string().optional())`, vì các hàm
 * đó tạo schema mới và dấu không đi theo.
 */
export function secret<T extends z.ZodType>(schema: T): T {
  secretSchemas.add(schema);
  return schema;
}

/** Schema env đã khai báo (kết quả của {@link defineEnv}). */
export interface EnvSchema<S extends EnvShape = EnvShape> {
  readonly shape: S;
  /** Tên các biến secret (đánh dấu bằng `secret()` hoặc suy ra từ tên). */
  readonly secrets: ReadonlySet<string>;
}

/**
 * Khai báo schema env. Tên biến nào chứa `KEY`/`SECRET`/`TOKEN`/`PASSWORD`… tự
 * được coi là secret; `extraSecrets` thêm tên khác.
 */
export function defineEnv<S extends EnvShape>(
  shape: S,
  options: { extraSecrets?: string[] } = {},
): EnvSchema<S> {
  const secrets = new Set<string>(options.extraSecrets ?? []);
  for (const [name, schema] of Object.entries(shape)) {
    if (secretSchemas.has(schema) || SECRET_NAME.test(name)) secrets.add(name);
  }
  return { shape, secrets };
}

/** Gộp nhiều schema env thành một (khoá trùng: schema sau thắng). */
export function mergeEnv<A extends EnvShape, B extends EnvShape>(
  a: EnvSchema<A>,
  b: EnvSchema<B>,
): EnvSchema<A & B> {
  return {
    shape: { ...a.shape, ...b.shape },
    secrets: new Set([...a.secrets, ...b.secrets]),
  };
}

/** Một lỗi cấu hình của một biến. Không bao giờ chứa giá trị secret. */
export interface ConfigIssue {
  name: string;
  /** `missing` = chưa đặt/rỗng, `invalid` = có nhưng sai. */
  kind: "missing" | "invalid";
  message: string;
}

/**
 * Lỗi cấu hình gom mọi biến sai trong MỘT lần ném: người vận hành sửa hết rồi
 * chạy lại một lần, không phải sửa từng biến một.
 */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[], context?: string) {
    const head = `${context ? `${context}: ` : ""}cấu hình không hợp lệ (${issues.length} lỗi)`;
    super([head, ...issues.map((i) => `  - ${i.name}: ${i.message}`)].join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  /** Nguồn biến môi trường. BẮT BUỘC truyền tường minh (thường là `process.env`). */
  env: Record<string, string | undefined>;
  /**
   * Đường dẫn file `.env` để bổ sung biến còn thiếu. Bỏ trống thì KHÔNG đọc file
   * nào. File không tồn tại thì bỏ qua. Biến đã có trong `env` thắng file.
   */
  envFile?: string;
  /** Tiền tố thông báo lỗi, vd tên bot. */
  context?: string;
}

/** Kết quả của {@link loadConfig}. */
export interface LoadedConfig<S extends EnvShape> {
  /** Giá trị đã parse, đóng băng. Chứa secret thật — đừng log trực tiếp. */
  readonly values: Readonly<InferEnv<S>>;
  /** Bản an toàn để log: secret thay bằng `[REDACTED]`, giá trị `undefined` giữ nguyên. */
  readonly redacted: Readonly<Record<string, unknown>>;
  /** File `.env` đã đọc (hoặc `null`) và các biến lấy từ file. Không có giá trị. */
  readonly envFile: { path: string | null; applied: string[] };
}

/**
 * Nạp và kiểm tra cấu hình. Ném {@link ConfigError} (gom MỌI lỗi) nếu thiếu hoặc
 * sai bất kỳ biến nào — bot nên để lỗi này làm process dừng lúc khởi động.
 */
export function loadConfig<S extends EnvShape>(
  schema: EnvSchema<S>,
  options: LoadConfigOptions,
): LoadedConfig<S> {
  // Làm việc trên bản sao: không bao giờ ghi vào object của caller.
  const source: Record<string, string | undefined> = { ...options.env };
  const applied: string[] = [];
  let filePath: string | null = null;

  if (options.envFile && existsSync(options.envFile)) {
    filePath = options.envFile;
    for (const [key, value] of Object.entries(
      parseEnvFile(readFileSync(options.envFile, "utf8")),
    )) {
      if (source[key] === undefined) {
        source[key] = value;
        applied.push(key);
      }
    }
  }

  const issues: ConfigIssue[] = [];
  const values: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(schema.shape)) {
    const raw = source[name];
    const input = raw === undefined || raw.trim() === "" ? undefined : raw;
    const parsed = field.safeParse(input);
    if (parsed.success) {
      values[name] = parsed.data;
      continue;
    }
    if (input === undefined) {
      issues.push({ name, kind: "missing", message: "chưa đặt (bắt buộc)" });
    } else {
      // Chỉ lấy `message` của zod: không in `input`, vì có thể là secret.
      const reasons = parsed.error.issues.map((i) => i.message);
      issues.push({
        name,
        kind: "invalid",
        message: `giá trị không hợp lệ (${reasons.join("; ")})`,
      });
    }
  }

  if (issues.length > 0) throw new ConfigError(issues, options.context);

  const redacted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    redacted[name] = schema.secrets.has(name) && value !== undefined ? REDACTED : value;
  }

  return Object.freeze({
    values: Object.freeze(values) as Readonly<InferEnv<S>>,
    redacted: Object.freeze(redacted),
    envFile: { path: filePath, applied },
  });
}
