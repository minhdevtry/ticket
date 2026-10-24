# ADR 0001: Consumers depend on bot-core over git+ssh by tag

Status: superseded — the package now lives in the `ticket` monorepo at
`packages/core` and apps consume it with `workspace:*`.

## Context

While `@vuihoc/bot-core` was a standalone private repository, consumer bots pinned
it by git tag. Bun 1.4.0 rewrites `github:` and `git+https` specs to the GitHub
tarball API and forwards no credentials to it, so on a private repo both forms
returned 404. Only `git+ssh` made Bun run a real `git clone`.

## Decision (historical)

Consumers used `git+ssh://git@github.com/<owner>/<repo>.git#<tag>`, which needed
an SSH key with read access on every deploy host.

## Consequences

Superseded by the monorepo layout: apps declare `"@vuihoc/bot-core": "workspace:*"`
and there is no tag to pin and no per-host SSH key requirement. Versioning of the
package is tracked in `CHANGELOG.md`.
