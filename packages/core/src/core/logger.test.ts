import { afterEach, describe, expect, test } from "bun:test";
import { getLogger, setLogger, redactSecrets, Logger, type IntakeLogger } from "./logger";

afterEach(() => {
  // restore the default console shim between tests
  setLogger({
    debug: (m, ...a) => console.debug(m, ...a),
    info: (m, ...a) => console.info(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
  });
});

// ── intake API: default shim + setLogger (ported, adapted) ───────────────────

describe("logger: intake API", () => {
  test("default logger is the console shim and is callable", () => {
    const log = getLogger();
    expect(typeof log.info).toBe("function");
    expect(() => log.info("hello")).not.toThrow();
  });

  test("setLogger swaps the process logger; getLogger returns it", () => {
    const calls: string[] = [];
    const fake: IntakeLogger = {
      debug: (m) => calls.push(`debug:${m}`),
      info: (m) => calls.push(`info:${m}`),
      warn: (m) => calls.push(`warn:${m}`),
      error: (m) => calls.push(`error:${m}`),
    };
    setLogger(fake);
    expect(getLogger()).toBe(fake);
    getLogger().warn("x");
    expect(calls).toEqual(["warn:x"]);
  });
});

// ── CM additions: redactSecrets (ported) ─────────────────────────────────────

describe("logger: redactSecrets (CM)", () => {
  test("redacts a Telegram bot token in a string", () => {
    const out = redactSecrets("token=123456789:ABCdefGHIjklMNOpqrSTUvwxyz0123456789AB");
    expect(out).not.toContain("ABCdefGHIjklMNOpqrSTUvwxyz");
    expect(String(out)).toContain("REDACTED");
  });

  test("redacts a Bearer token", () => {
    const out = String(redactSecrets("Authorization: Bearer abc.def.ghi123=="));
    expect(out).toContain("Bearer [REDACTED_BEARER_TOKEN]");
    expect(out).not.toContain("abc.def.ghi123");
  });

  test("redacts an sk- API key and a GitHub token", () => {
    const out = String(
      redactSecrets("key sk-ABCDEFGHIJKLMNOPQRSTUV and ghp_ABCDEFGHIJKLMNOPQRSTUV12345"),
    );
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  test("blanks credential-looking object keys and recurses", () => {
    const out = redactSecrets({
      password: "hunter2",
      nested: { token: "deadbeef", safe: "keep" },
      list: ["Bearer zzz.yyy.xxx"],
    }) as Record<string, any>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.nested.safe).toBe("keep");
    expect(out.list[0]).toContain("[REDACTED_BEARER_TOKEN]");
  });

  test("leaves non-secret primitives untouched", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets("plain text")).toBe("plain text");
  });
});

// ── CM additions: structured Logger (ported) ─────────────────────────────────

describe("logger: Logger class (CM)", () => {
  test("builds a redacted LogEntry with timestamp and level", () => {
    const log = new Logger("debug");
    const entry = log.info("db password=hunter2 connected");
    expect(entry.level).toBe("info");
    expect(entry.message).not.toContain("hunter2");
    expect(entry.message).toContain("[REDACTED]");
    expect(typeof entry.timestamp).toBe("string");
  });

  test("withTraceId stamps trace_id and keeps the level", () => {
    const log = new Logger("info").withTraceId("trace-123");
    expect(log.getTraceId()).toBe("trace-123");
    const entry = log.error("boom");
    expect(entry.trace_id).toBe("trace-123");
  });

  test("meta is redacted too", () => {
    const log = new Logger("debug");
    const entry = log.info("ok", { token: "secretvalue", userId: 7 });
    expect(entry.meta?.token).toBe("[REDACTED]");
    expect(entry.meta?.userId).toBe(7);
  });

  test("the Logger class satisfies IntakeLogger and installs via setLogger", () => {
    const log = new Logger("info");
    setLogger(log);
    expect(getLogger()).toBe(log);
  });
});
