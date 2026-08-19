# Changelog

## 0.4.0

- New Session streams declare format version 1 in `session.started`.

## 0.3.1

- Request snapshots use an explicit behavior allowlist and exclude API keys, authorization data, signals, and transport-private objects.

## 0.3.0

- Normalizes Pi lifecycle, message, delta, and tool events into the Goah Session vocabulary.
- Captures the exact prepared request and replayable compaction replacement metadata.

## 0.2.0

- Process runners accept a local `cwd`; Pi file, bash, and Git work execute directly under that root.
- Removed core token/handoff limits; optional timeout and Pi compaction remain runner-owned policy.

## 0.1.0

- Process protocol, official Pi 0.84.2 worker, structured handoff, local runner tools, limits, and compaction.
