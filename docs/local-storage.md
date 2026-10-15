# SST-005 — Versioned local repository

**2026-10-15 · T008 · independent TEST/REVIEW/DELIVERY passed.** SST-004 committed `d6e1822`; latest authorization starts this ticket only. T009 belongs to SST-006.

## Implementation

[Domain types](../packages/domain/src/index.ts) define a finite metadata change union. The [SQLite Adapter](../packages/adapters/src/index.ts) exposes `openMetadata`, then `snapshot`, `commit`, `backup`, and idempotent `close`. No SQL/table names, arbitrary paths or repository operations cross preload. [ADR 0002](adr/0002-local-metadata-storage.md) records the built-in `node:sqlite` decision and runtime probes.

Main owns `userData/metadata/catalog.sqlite` after acquiring instance ownership. Startup opens storage before creating windows; bootstrap reports only `{status:'ready',schemaVersion}` or `{status:'blocked',code}`. Fixed UI messages cover corrupt/foreign/newer/protected/recovery-required/unwritable/busy/unavailable stores without revealing paths or suggesting reset. Existing IPC sender/frame/window-generation validation remains intact.

Schema v1 contains the [domain dictionary](termius/domain-storage-spec.md), internal identity/catalog state and an ID registry. `application_id=0x5353544d`, the identity manifest and `user_version=1` distinguish this database. The latter is the only schema version. Same-vault composite FKs, STRICT tables, checks and uniqueness work alongside transactional graph validation. Deferred NO ACTION FKs permit complete atomic batches; remaining references restrict deletion, and no hidden cascade removes unrelated data.

Commits compare catalog and per-record revisions, validate finite changes and the resulting graph, and increment each touched owner once, including tag membership edits. IDs survive restart and cannot be reused after deletion. Endpoint normalization handles IDNA, DNS case/trailing dot and canonical IPv4/IPv6 without DNS lookup. Tag names normalize NFC/lowercase. Settings use an explicit allowlist and bounds.

Protected table definitions exist, but this Adapter refuses Snippet/SecretRef/KeyMetadata/SecretOperation publication, saved credential/key identities and known-host trust mutations. No plaintext password/key/body write or invented protection format is available. Existing unsupported protected content blocks opening while preserving its original bytes; SST-006/009 supply their later capabilities.

## Open, backup and migration

- A new database file is exclusively reserved with mode 0600. Existing zero-length/version-zero/unrelated/corrupt/FK-invalid/newer/unsupported-protection files are inspected before writes and never silently initialized, reset or downgraded. Valid source stores additionally require a private parent directory and a 0600 database; permissive existing files/directories fail with unwritable without chmod or replacement. The gate checks POSIX mode bits, not additional ACL grants. Connections enforce foreign keys, bounded busy waits, WAL and full synchronization.
- SQLite online backup includes committed WAL pages. Backup and checksum/version/protection sidecar destinations are exclusively reserved, refuse overwrite/source alias, use mode 0600 and are cleaned up only when owned by the failed operation. Mutations/overlapping backups are blocked while backup runs; close defers releasing the source until it settles.
- Pending secret journal operations block commit/backup/open; storage never replays OS-secret actions. Backups contain plaintext metadata and any protected ciphertext, with no OS-secret export or promise of portable secret recovery.
- The [internal migration runner](../packages/adapters/src/migrations.ts) preflights the entire chain, file identity/integrity/FKs/journal/provider requirements/writability/space and preserves an original online backup. Each step and its version increment commit together. A failed step rolls back; earlier successful steps remain committed and the original backup remains intact.
- Production currently creates/supports v1 only. Tests use synthetic v1→v2→v3 steps to exercise the runner; they do not claim a released legacy upgrade or Termius database compatibility. Recovery inspection uses owned copies and preserves originals; no automatic salvage/restore UI is introduced.

## Verification record

Final verification: typecheck PASS and unit tests **33/33**, including **18** storage tests. Coverage includes cross-process restart, stale/two-writer edits, graph cycles, auth/empty semantics, Unicode collisions, SQL constraints, explicit dependent deletion, retained trust/shared metadata, protected-write rejection, backup checksums/WAL/permissions/no-overwrite/close lifetime, invalid-store byte preservation, contention and migration failure/rollback.

[Electron E2E](../tests/e2e/storage.spec.ts) uses the shipped main-only `storage.js` entry to execute the same production Adapter on a separate temporary database. It checks Thai CRUD, atomic rollback, update/delete, backup/hash/restore-copy/reopen and newer-schema preservation and rejection of permissive file/directory modes with unchanged originals. Separate startup tests cover fresh and corrupt userData databases and sanitized bootstrap health. No renderer test bridge or CRUD command is exposed.

Final commands/results belong in the [execution record](agent-runs/implementation-plan.md#sst-005-execution-plan--2026-10-15). Reports and screenshots remain ignored under `artifacts/test-results/`; packaging copies the bundled storage entry and shared chunks inside the ASAR. All tests use owned temporary files/profiles, with no user/Termius database, Keychain or real SSH access.

## Remaining scope

Local metadata operations are synchronous and intended for bounded batches. Large-catalog performance, verified secret/protection providers, inheritance resolution, catalog editing UI, real SSH/session work and release acceptance remain later tickets. The shell still disables server setup. SST-005 has no automatic commit/push/deployment authorization.

Final runtime gates PASS: development Electron E2E **10/10**, unsigned packaged E2E **7/7**, both with `privatePermissions: true`. Independent TEST and focused REVIEW passed after fixing the existing-store permission finding. [Delivery](agent-runs/sst-005-delivery.md). Root visually inspected the packaged corrupt-store alert; `artifacts/storage-blocked.png` records that fixture.
