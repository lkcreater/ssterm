import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { BackupManifest, MetadataRepository, MetadataSnapshot, MetadataChange, StoreResult } from '@ssterm/domain';
import { APPLICATION_ID, IDENTITY, initialize, SCHEMA_VERSION } from './schema.ts';
import { failure, fail, success } from './errors.ts';
import { applyChanges, integer, keys, validateGraph } from './validation.ts';
import { readSnapshot, reserveNewIds, writeSnapshot } from './records.ts';
import { createBackup } from './backup.ts';
import { ENVELOPE_VERSION, PROTECTION_FORMAT } from './protection.ts';
import { privateStore, writable } from './files.ts';
import { runMigrations } from './migrations.ts';
import { MIGRATIONS } from './schema-migrations.ts';
export { seal, open, ProtectionFault, PROTECTION_FORMAT, ENVELOPE_VERSION, CONTENT_KEY_BYTES, MAX_BODY } from './protection.ts';
export type { MetadataRepository, MetadataSnapshot, MetadataChange, StoreResult, StorageErrorCode, BackupManifest } from '@ssterm/domain';
function foreignKeys(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON');
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) fail('unavailable');
}
/** Returns the stored schema version. An older (migratable) store gets only the identity and integrity checks. */
function preflight(db: DatabaseSync, allowOlder = false): number {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) fail('foreign-database');
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || version > SCHEMA_VERSION || version < 1) fail('unsupported-schema');
  if (version < SCHEMA_VERSION && !allowOlder) fail('unsupported-schema');
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('corrupt');
  let manifest;
  try {
    manifest = db.prepare('SELECT singleton,identity FROM identity_manifest').all();
  } catch {
    fail('foreign-database');
  }
  if (manifest.length !== 1 || manifest[0]?.singleton !== 1 || manifest[0]?.identity !== IDENTITY) fail('foreign-database');
  if (version < SCHEMA_VERSION) return version;
  let snapshot;
  try {
    snapshot = readSnapshot(db);
  } catch {
    fail('corrupt');
  }
  // Pending journal rows are opened for reconciliation; unknown protection formats still fail closed.
  if (![null, PROTECTION_FORMAT].includes(snapshot.vault.protectionFormat) || snapshot.snippets.some(row => row.protectionFormat !== PROTECTION_FORMAT || row.envelopeVersion !== ENVELOPE_VERSION)) fail('unsupported-protection');
  try {
    validateGraph(snapshot);
  } catch {
    fail('corrupt');
  }
  return version;
}
class Repository implements MetadataRepository {
  private closed = false;
  private closing = false;
  private backingUp = false;
  constructor(private readonly db: DatabaseSync, private readonly path: string) {}
  private available(): void {
    if (this.closed || this.closing) fail('closed');
    if (this.backingUp) fail('busy');
  }
  snapshot(): StoreResult<MetadataSnapshot> {
    let transaction = false;
    try {
      this.available();
      this.db.exec('BEGIN');
      transaction = true;
      const result = readSnapshot(this.db);
      this.db.exec('COMMIT');
      transaction = false;
      return success(result);
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK');
      return failure(error);
    }
  }
  commit(request: {
    expectedCatalogRevision: number;
    changes: MetadataChange[];
  }): StoreResult<MetadataSnapshot> {
    let transaction = false;
    try {
      this.available();
      keys(request, ['expectedCatalogRevision', 'changes'], ['expectedCatalogRevision', 'changes']);
      integer(request.expectedCatalogRevision, 0);
      if (!Array.isArray(request.changes) || request.changes.length < 1 || request.changes.length > 1000) fail('invalid-request');
      this.db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const before = readSnapshot(this.db);
      if (before.catalogRevision !== request.expectedCatalogRevision) fail('conflict');
      const after = applyChanges(before, request.changes);
      reserveNewIds(this.db, before, after);
      writeSnapshot(this.db, after);
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('constraint');
      const committed = readSnapshot(this.db);
      this.db.exec('COMMIT');
      transaction = false;
      return success(committed);
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK');
      return failure(error);
    }
  }
  async backup(request: {
    destination: string;
  }): Promise<StoreResult<BackupManifest>> {
    let acquired = false;
    try {
      this.available();
      keys(request, ['destination'], ['destination']);
      this.backingUp = true;
      acquired = true;
      return success(await createBackup(this.db, this.path, request.destination));
    } catch (error) {
      return failure(error);
    } finally {
      if (acquired) this.backingUp = false;
      if (acquired && this.closing && !this.closed) {
        this.closed = true;
        this.db.close();
      }
    }
  }
  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (!this.backingUp) {
      this.closed = true;
      this.db.close();
    }
  }
}
/** No writable connection is opened until existing storage has passed read-only inspection. */
export async function openMetadata(request: {
  path: string;
}): Promise<StoreResult<MetadataRepository>> {
  let db: DatabaseSync | undefined;
  try {
    keys(request, ['path'], ['path']);
    const path = request.path;
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('invalid-request');
    let fresh = false;
    let stored = SCHEMA_VERSION;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('foreign-database');
      if (stat.size === 0) fail('foreign-database');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fresh = true;else throw error;
    }
    if (!fresh) {
      const inspect = new DatabaseSync(path, {
        readOnly: true
      });
      try {
        foreignKeys(inspect);
        inspect.exec('BEGIN');
        try {
          stored = preflight(inspect, true);
        } finally {
          inspect.exec('ROLLBACK');
        }
      } finally {
        inspect.close();
      }
    }
    privateStore(path);
    writable(path);
    if (fresh) {
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
    }
    db = new DatabaseSync(path, {
      timeout: 200
    });
    foreignKeys(db);
    // Repeat inspection on the writable handle before any persistent PRAGMA, defending replacement races.
    if (!fresh && preflight(db, true) < SCHEMA_VERSION) {
      // Upgrade in place after a verified backup next to the store (kept for the user; never deleted automatically).
      const migrated = await runMigrations({
        db, path, targetVersion: SCHEMA_VERSION, steps: MIGRATIONS,
        backupDestination: `${path}.v${stored}-${new Date().toISOString().replace(/[:.]/gu, '-')}.backup`,
      });
      // fail() reaches the catch below, which closes the writable handle.
      if (!migrated.ok) fail(migrated.error.code);
      preflight(db);
    }
    if (fresh) initialize(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=200');
    return success(new Repository(db, path));
  } catch (error) {
    try {
      db?.close();
    } catch {/* Keep the original sanitized outcome. */}
    return failure(error);
  }
}

/** Main-only dry run. SQL commit remains authoritative for concurrency and ID reservations. */
export function previewMetadataChanges(snapshot: MetadataSnapshot, changes: MetadataChange[]): StoreResult<MetadataSnapshot> {
  try {
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 1000) fail('invalid-request');
    return success(applyChanges(snapshot, changes));
  } catch (error) {
    return failure(error);
  }
}

export { decodeHostPublicKey, validHostKeyIdentity, MAX_HOST_KEY_BYTES } from './host-key.ts';
