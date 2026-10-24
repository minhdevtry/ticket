/**
 * Shim contract for scripts/shadow-parity.ts. Each file in this directory (except this one)
 * exports `shims: Shim[]`; the harness appends them to its built-in list.
 *
 * A shim replaces one file of the SHADOW COPY of intake-agents (never the live repo) with a
 * thin module that re-exports from the library, keeping the original path and export names.
 */
export type Shim = {
  /** path relative to intake/ in the shadow copy, e.g. "lib/telegram/transport.ts" */
  file: string;
  /** library subpath export, e.g. "@vuihoc/bot-core/telegram" */
  from: string;
  /** shim body generator; `imp` is the resolved import specifier */
  body: (imp: string) => string;
  note?: string;
  /**
   * If set, the ORIGINAL file is copied next to the shim under this name before it is
   * overwritten (e.g. "transport.local.ts"), so the shim can re-export bot-only parts from it.
   */
  preserveAs?: string;
};

export const LIB_PKG = "@vuihoc/bot-core";
