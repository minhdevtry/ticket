/**
 * A map-backed `CopyCatalog` (ticket 08). The strings themselves are a bot's
 * concern — this just resolves a key and substitutes `{named}` placeholders.
 * Tiểu Linh's own copy ships as an EXAMPLE under `examples/tieulinh/`, not here.
 */
import type { CopyCatalog, CopyKey } from "./ports";

export function makeCopyCatalog(strings: Record<CopyKey, string>): CopyCatalog {
  return {
    text(key: CopyKey, vars: Record<string, string | number> = {}): string {
      const template = strings[key];
      if (template === undefined) throw new Error(`CopyCatalog: missing key "${key}"`);
      return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
        name in vars ? String(vars[name]) : `{${name}}`,
      );
    },
  };
}
