/**
 * Cấu hình chạy bóng Tiểu Linh 2: đọc từ biến môi trường, kiểm tra khi khởi động.
 *
 * Mọi giá trị đặc thù máy (IP server, IP dev) nằm ngoài repo: biến môi trường hoặc file
 * `~/.config/ticket/tl2-shadow.env` (không commit). Dữ liệu chat thật nằm ở `dataDir()` (0700),
 * ngoài repo; file bên trong luôn 0600.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

const DAY_MS = 24 * 60 * 60 * 1000;

export class ConfigError extends Error {}

export function configDir(env: Env = process.env): string {
  return env.TL2_CONFIG_DIR || join(env.HOME || homedir(), ".config", "ticket");
}

export function dataDir(env: Env = process.env): string {
  return env.TL2_SHADOW_DIR || join(env.HOME || homedir(), ".local", "share", "tl2-shadow");
}

/** Phân tích định dạng dotenv đơn giản: KEY=value, bỏ dòng trống, #, dấu nháy bao ngoài, `export `. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) throw new ConfigError(`Thiếu file cấu hình: ${path}`);
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** Nạp `tl2-shadow.env` (nếu có) vào env, không ghi đè biến đã đặt sẵn. */
export function loadLocalEnv(env: Env = process.env): void {
  const path = env.TL2_SHADOW_ENV || join(configDir(env), "tl2-shadow.env");
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (env[k] === undefined) env[k] = v;
  }
}

function int(env: Env, key: string, def: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${key} phải là số nguyên >= ${min}`);
  return n;
}

export interface RelayConfig {
  host: string;
  port: number;
  /** Địa chỉ được phép gọi /ingest, ngoài loopback (luôn được phép). */
  allowFrom: string[];
  token: string | null;
  dir: string;
  gatewayUrl: string;
  gatewayTokenPath: string;
  model: string;
  /** Tên model thật ghi vào cặp (gateway chỉ báo tên agent). */
  modelLabel: string;
  sessionPrefix: string;
  retentionMs: number;
  backlogMaxAgeMs: number;
  contextTurns: number;
  contextWindowMs: number;
  concurrency: number;
  requestTimeoutMs: number;
  /** Chờ im lặng bấy lâu sau tin ra cuối cùng của Tiểu Linh 1 rồi mới coi là xong. */
  tl1SettleMs: number;
  /** Tối đa chờ Tiểu Linh 1 trả lời (không trả lời thì vẫn ghi cặp). */
  tl1WaitMaxMs: number;
  tickMs: number;
}

export function relayConfig(env: Env = process.env): RelayConfig {
  if (env.SHADOW_ALLOW_FROM === undefined) {
    throw new ConfigError(
      "Thiếu SHADOW_ALLOW_FROM: danh sách IP server được gửi sự kiện, cách nhau dấu phẩy " +
        "(ví dụ 10.0.0.5; đặt rỗng để chỉ cho loopback). Đặt trong ~/.config/ticket/tl2-shadow.env.",
    );
  }
  const dir = dataDir(env);
  return {
    host: env.SHADOW_BIND || "0.0.0.0",
    port: int(env, "SHADOW_PORT", 3106),
    allowFrom: env.SHADOW_ALLOW_FROM.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    token: env.SHADOW_RELAY_TOKEN || null,
    dir,
    gatewayUrl: (env.TL2_GATEWAY_URL || "http://127.0.0.1:18796").replace(/\/+$/, ""),
    gatewayTokenPath: env.TL2_GATEWAY_TOKEN_FILE || join(dir, "gateway.token"),
    model: env.TL2_MODEL || "openclaw/ticket-intake-agent-2",
    modelLabel: env.TL2_MODEL_LABEL || "MiniMax-M3.1-Flash",
    sessionPrefix: env.TL2_SESSION_PREFIX || "agent:ticket-intake-agent-2:shadow:",
    retentionMs: int(env, "TL2_RETENTION_DAYS", 7) * DAY_MS,
    backlogMaxAgeMs: int(env, "TL2_BACKLOG_MAX_HOURS", 24) * 60 * 60 * 1000,
    contextTurns: int(env, "TL2_CONTEXT_TURNS", 4, 0),
    contextWindowMs: int(env, "TL2_CONTEXT_WINDOW_MIN", 360) * 60 * 1000,
    concurrency: int(env, "TL2_CONCURRENCY", 3),
    requestTimeoutMs: int(env, "TL2_REQUEST_TIMEOUT_MS", 180_000, 1000),
    tl1SettleMs: int(env, "TL2_TL1_SETTLE_MS", 4000, 0),
    tl1WaitMaxMs: int(env, "TL2_TL1_WAIT_MAX_MS", 90_000, 1000),
    tickMs: int(env, "TL2_TICK_MS", 1000, 50),
  };
}
