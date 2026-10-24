/**
 * One logger for the whole process — and nothing else.
 *
 * This module deliberately imports nothing. The default is a console shim; a
 * host that wants structured logs installs its own via `setLogger`. Keeping the
 * default dependency-free is what lets `bun build --compile` stay small: a
 * native logging framework cannot be embedded in a compiled binary, and the MCP
 * servers hit that three separate times.
 *
 * MERGED (0.1.0): the public API is intake's (`IntakeLogger`, `getLogger`,
 * `setLogger`, `LogLevel`) so call sites switch with no change. CM's structured
 * `Logger` class, `redactSecrets` and trace-id support are added on top — the
 * class satisfies `IntakeLogger`, so `setLogger(new Logger(...))` just works.
 */

// ── intake API (primary) ────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface IntakeLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const consoleLogger: IntakeLogger = {
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

let logger: IntakeLogger = consoleLogger;

/** Installs the process logger. Called once at startup by whoever owns the runtime. */
export function setLogger(next: IntakeLogger): void {
  logger = next;
}

export function getLogger(): IntakeLogger {
  return logger;
}

// ── CM additions: secret redaction, structured Logger, trace id ──────────────

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  trace_id?: string;
  meta?: Record<string, unknown>;
}

/**
 * Strips secrets and PII before anything is logged: Telegram/Bearer/API/GitHub
 * tokens, key-value password pairs, and a known legacy password. Recurses into
 * objects and arrays, and blanks any key that looks like a credential.
 */
export function redactSecrets(val: unknown): unknown {
  if (typeof val === "string") {
    return (
      val
        // Telegram bot token (e.g. 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ)
        .replace(/\b(\d{8,10}:[A-Za-z0-9_-]{30,45})\b/g, "[REDACTED_TELEGRAM_TOKEN]")
        // Bearer token
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_BEARER_TOKEN]")
        // OpenAI / Onyx API keys
        .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
        // GitHub tokens
        .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
        // Key-value passwords and secrets
        .replace(
          /(["']?(?:password|mật\s*khẩu|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
          "$1[REDACTED]",
        )
        // Specific sensitive legacy passwords
        .replace(new RegExp(["Vui", "hoc", "@", "123"].join(""), "g"), "[REDACTED_PASSWORD]")
    );
  }

  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      return val.map(redactSecrets);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (/password|secret|token|apikey|api_key|mật\s*khẩu/i.test(k) && typeof v === "string") {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return val;
}

/**
 * Structured JSON logger with level filtering, trace id and automatic secret
 * redaction. Implements `IntakeLogger`, so a host can install it as the process
 * logger: `setLogger(new Logger("info"))`.
 */
export class Logger implements IntakeLogger {
  private level: LogLevel = "info";
  private traceId?: string;

  constructor(level: LogLevel = "info", traceId?: string) {
    this.level = level;
    this.traceId = traceId;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  withTraceId(traceId: string): Logger {
    return new Logger(this.level, traceId);
  }

  getTraceId(): string | undefined {
    return this.traceId;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_SEVERITY[level] >= LEVEL_SEVERITY[this.level];
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): LogEntry {
    const sanitizedMessage = String(redactSecrets(message));
    const sanitizedMeta = meta ? (redactSecrets(meta) as Record<string, unknown>) : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizedMessage,
      ...(this.traceId ? { trace_id: this.traceId } : {}),
      ...(sanitizedMeta ? { meta: sanitizedMeta } : {}),
    };

    if (this.shouldLog(level)) {
      const line = JSON.stringify(entry);
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
    }

    return entry;
  }

  debug(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit("error", message, meta);
  }
}
