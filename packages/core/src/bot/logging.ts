/**
 * Logger bọc: gắn tiền tố bot và lọc secret/PII trên MỌI thông điệp và đối số, theo hai lớp:
 * `scrub` (che theo GIÁ TRỊ các secret đã khai, vd key agent) rồi `redactSecrets` (theo mẫu).
 */
import { type IntakeLogger, redactSecrets } from "../core/logger";

/** Bọc `base` để mọi dòng log mang `[bot:<id>]` và đã qua lọc. `scrub` mặc định là hàm đồng nhất. */
export function botLogger(
  botId: string,
  base: IntakeLogger,
  scrub: <T>(input: T) => T = (x) => x,
): IntakeLogger {
  const wrap =
    (level: keyof IntakeLogger) =>
    (message: string, ...args: unknown[]) =>
      base[level](
        `[bot:${botId}] ${redactSecrets(scrub(String(message)))}`,
        ...args.map((a) => redactSecrets(scrub(a))),
      );
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}
