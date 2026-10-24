/**
 * Logger bọc: gắn tiền tố bot và lọc secret/PII (`redactSecrets`) trên MỌI thông điệp và đối số.
 */
import { type IntakeLogger, redactSecrets } from "../core/logger";

/** Bọc `base` để mọi dòng log mang `[bot:<id>]` và đã qua `redactSecrets`. */
export function botLogger(botId: string, base: IntakeLogger): IntakeLogger {
  const wrap =
    (level: keyof IntakeLogger) =>
    (message: string, ...args: unknown[]) =>
      base[level](`[bot:${botId}] ${redactSecrets(String(message))}`, ...args.map(redactSecrets));
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}
