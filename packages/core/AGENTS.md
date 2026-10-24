# @vuihoc/bot-core

This package lives in the `ticket` monorepo at `packages/core` and is consumed by
the apps through `workspace:*`. There is no separate repo, tag pinning or
`git+ssh` install any more.

## Working here

- Run tests: `bun test src` (or `bun run test`).
- Typecheck: `bun run check` (`tsc --noEmit -p .`).
- Architecture decisions are in `docs/adr/`. Read the ones that touch the area
  you are changing before editing.
- Fixtures must stay synthetic: no real phone numbers, chat IDs, staff names or
  handles, internal hosts or personal paths. Run `bun run scripts/scan-public.ts`
  from the monorepo root before committing.
