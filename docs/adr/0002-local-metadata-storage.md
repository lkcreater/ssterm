# ADR 0002 — Local metadata SQLite Adapter

**2026-10-15 · SST-005/T008 · implemented; independent TEST/REVIEW/DELIVERY passed**

## Decision

Use the pinned runtime's **`node:sqlite` (`DatabaseSync` and `backup`)** behind the MetadataRepository Interface in `packages/domain`, implemented in `packages/adapters`. Electron main owns the repository; preload only returns sanitized storage health. Schema and driver details stay outside React. [Node 24 SQLite](https://github.com/nodejs/node/blob/v24.11.1/doc/api/sqlite.md)

The `better-sqlite3` entry in ADR 0001 was a candidate, not a selected dependency. Built-in SQLite avoids an additional native addon/rebuild and packaged node_modules staging while retaining the approved SQLite storage model. No failure of better-sqlite3 is claimed; it was not installed or tested in this ticket. The UI stack and Electron version stay unchanged.

Actual throwaway pre-implementation probes passed:

| Runtime | SQLite | Checked |
|---|---|---|
| Host Node 24.11.1 | 3.50.4 | DatabaseSync, bound Thai-text CRUD, foreign_keys=1; backup function available |
| Electron 44.7.2 / embedded Node 24.21.0 | 3.53.4 | Same CRUD/FK checks and completed online backup in main |

Host Node reports an experimental SQLite API warning. Pinning and testing both runtimes is required; newer Node documentation is not assumed to match Node 24. Packaged CRUD/reopen/backup is a delivery gate, separate from these preliminary probes.

## Storage and lifecycle

- Own `userData/metadata/catalog.sqlite`; initialize only a newly reserved file. Existing version-zero/unrelated/corrupt/newer/protection-incompatible stores block access without reset or replacement. Valid source files require mode 0600 and a private parent directory; permissive modes block access without automatic chmod.
- Schema v1 implements the [logical dictionary](../termius/domain-storage-spec.md) with identity, FK, scalar and uniqueness constraints. `PRAGMA user_version` is the sole schema version; catalog revisions are optimistic edit tokens, not schema versions. [SQLite version pragma](https://www.sqlite.org/pragma.html#pragma_user_version)
- Validate requests and the resulting graph inside atomic metadata commits. No SQL/table names or generic CRUD passes through IPC. Protected record publication remains unavailable until SST-006 supplies the verified SecretStore/protection Module.
- Use SQLite's backup facility for committed WAL-aware snapshots, with a checksum/schema/protection manifest and no overwrite of existing backup destinations. Database backups contain no OS secrets or key export. [SQLite backup](https://www.sqlite.org/backup.html)
- Migrations preflight the supported chain and preserve an original backup. Each step and version bump share a transaction; a failed step rolls back without promising rollback of earlier successful steps. Production initially supports v1; synthetic later steps test the internal runner.
- Main acquires instance ownership, initializes before opening windows, and closes the repository on quit. The bootstrap health discriminant carries no database path, row, credential or raw SQLite error.

## Consequences and limits

SQLite is synchronous on main for bounded local metadata operations. This decision does not establish large-catalog performance or authorize long-running queries in interaction handlers. Tests use owned temporary profiles/databases. No whole-database encryption, Keychain access, host resolver, live SSH or catalog editing UI is implemented by SST-005. Release platform/performance/protection gates remain separate.

See [execution record](../agent-runs/implementation-plan.md#sst-005-execution-plan--2026-10-15) for final checks and delivery status.
