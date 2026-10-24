/**
 * One logger for the whole process — and nothing else.
 *
 * This module deliberately imports nothing. It used to construct a `PinoLogger`
 * at import time, which meant every file that merely wanted to log a warning
 * dragged a full logging framework behind it, and from there a native module
 * that cannot be embedded in a compiled binary. The MCP servers hit that three
 * separate times.
 *
 * So the default is a console shim. A host that wants structured logs installs
 * its own via `setLogger`.
 */
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
