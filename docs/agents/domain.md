# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`GLOSSARY.md`** at the repo root, if it exists.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. This repo is multi-context, so also read the context-scoped ADRs:
  - `packages/core/docs/adr/`
  - `apps/tieulinh-legacy/docs/adr/`
  - `apps/tieulinh/docs/adr/` (nếu có)

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
├── packages/core/
│   ├── GLOSSARY.md
│   └── docs/adr/                     ← context-specific decisions
├── apps/
│   ├── tieulinh/
│   │   ├── GLOSSARY.md
│   │   └── docs/adr/
│   └── tieulinh-legacy/
│       ├── GLOSSARY.md
│       └── docs/adr/
└── tools/tl2-shadow/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the glossary. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
