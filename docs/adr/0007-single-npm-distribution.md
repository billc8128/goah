# ADR 0007: Publish one npm distribution

Status: accepted

## Context

Goah's source is separated into contract, SQLite, supervisor, runner, testkit, and CLI workspaces. Publishing every workspace independently produced six immutable package versions, six provenance records, six release operations, and six npm security-notification emails for one logical Goah release. All packages already evolve in lockstep and the normal installation entry is `@goah/cli`.

Physically merging the source modules would weaken dependency boundaries solely to accommodate registry mechanics. Continuing six public packages would make a small experimental framework carry a release surface intended for independently versioned libraries.

## Decision

Only `@goah/cli` is public from 0.3.0 onward. The other five workspaces are private source modules and are included in the `@goah/cli` tarball as bundled dependencies. Framework APIs remain public through subpath exports:

- `@goah/cli/kernel`
- `@goah/cli/session`
- `@goah/cli/execution`
- `@goah/cli/metrics`
- `@goah/cli/sqlite`
- `@goah/cli/supervisor`
- `@goah/cli/runner-pi`
- `@goah/cli/testkit`

The release workflow performs one `npm publish`. Pack smoke installs only that tarball, imports every public subpath, and runs the first goal-to-handoff path. External Pi dependencies remain ordinary registry dependencies rather than copied source.

## Consequences

- One Goah release produces one npm publish notification.
- Source workspaces and TypeScript project references remain intact.
- Existing standalone 0.1/0.2 package versions remain in the registry but receive no 0.3 updates.
- Consumers migrate imports from `goah-ledger-*`, `goah-supervisor`, `goah-runner-pi`, and `goah-testkit` to `@goah/cli/*` subpaths.
- The top-level provenance attestation covers the complete bundled Goah tarball.
