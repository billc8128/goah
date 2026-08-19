# Changelog

## 0.5.0

- Added the interactive `goah` CEO shell and resident Supervisor local control socket for live goal revisions and observation confirmation.

## 0.4.0

- Added `goal-show`, `goal-update`, `goal-pause`, `goal-resume`, and `goal-complete`.
- Session listings expose their stored format version.

## 0.3.1

- Added `session list/show/replay/export`, `context show`, and stream-scoped `events` commands.
- Session export defaults to structural redaction and read-only inspection no longer requires provider credentials.

## 0.3.0

- Goal creation no longer invents a mandatory metric contract.
- Status reads wake streams and optional metric evaluations from the v0.3 ledger.
- Bundles the five internal source modules and exposes their APIs through `@goah/cli/*`; releases now use one npm publish.

## 0.2.0

- Removed the workspace field and Git requirement; the config directory is now the runner's implicit local root.

## 0.1.0

- Versioned configuration, daemon singleton, status, doctor, goals, approvals, dashboard, and recovery commands.
