# @vuihoc/bot-core

Shared TypeScript/Bun core for VUIHOC bots (Tiểu Linh, Bot CM, Bot-Sales, …).
One package, subpath exports per layer.

Layers: `core`, `identity`, `itsaplan`, `intake`, `openclaw`, `telegram`, `worker`, `prose`. Adoption guides per bot:
[`docs/adoption/`](docs/adoption/README.md). Parity proof: [`docs/parity/REPORT.md`](docs/parity/REPORT.md).

## Install

This package lives in the `ticket` monorepo at `packages/core` and is consumed by
the apps through `workspace:*`:

```jsonc
// apps/<app>/package.json
{
  "dependencies": {
    "@vuihoc/bot-core": "workspace:*"
  }
}
```

Import from a layer entry point:

```ts
import { getLogger, Logger, describeToolFailure, setToolFailureAlert } from "@vuihoc/bot-core/core";
```

## "MCP imports pure code only"

Code reachable from an MCP server — and anything shipped in `core` — must be
**pure, dependency-light TypeScript**: no Telegram/OpenClaw runtime, no native
modules, no file reads for lookup tables (import them). This is what keeps
`bun build --compile` binaries small and self-contained.

Consequences visible in this slice:
- the logger's default is a dependency-free console shim; a host installs a
  structured logger via `setLogger`;
- `tool-error` imports no Telegram — the admin alert is an **injected hook**
  (`setToolFailureAlert(fn)`) the host wires at startup;
- runtime deps are limited to `@modelcontextprotocol/sdk` and `zod`.

## Develop

```bash
bun install         # from the monorepo root
bun run test        # unit tests (bun test src)
bun run check       # typecheck (tsc --noEmit -p .)
```

Ship TypeScript source (no build step published); Bun runs TS directly.
Versioning starts at 0.x — breaking changes allowed until 1.0 but must be in
[`CHANGELOG.md`](CHANGELOG.md).
