/** Migration runner; the production chain is `MIGRATIONS` in schema-migrations.ts. */
import type { DatabaseSync } from 'node:sqlite';
import { rmSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BackupManifest, StoreResult } from '@ssterm/domain';
import { createBackup, reconciled } from './backup.ts';
import { writable } from './files.ts';
import { APPLICATION_ID, IDENTITY } from './schema.ts';
import { failure, fail, success } from './errors.ts';
export interface MigrationStep {
  from: number;
  to: number;
  requiresProtection?: boolean;
  /** Leaves snippet ciphertext, secret refs and the vault key untouched, so protected vaults may run it. */
  preservesProtection?: boolean;
  /**
   * Never reads or writes `secret_operation`/`secret_ref`, so it may run while the journal awaits runtime
   * reconciliation (e.g. `needs-input` after a Keychain denial); the journal is carried over unchanged.
   */
  preservesJournal?: boolean;
  apply(db: DatabaseSync): void;
}
interface MigrationOutcome {
  schemaVersion: number;
  backup: BackupManifest;
}
export async function runMigrations(request: {
  db: DatabaseSync;
  path: string;
  targetVersion: number;
  steps: readonly MigrationStep[];
  backupDestination: string;
}): Promise<StoreResult<MigrationOutcome>> {
  const {
    db,
    path,
    targetVersion,
    steps,
    backupDestination
  } = request;
  let transaction = false;
  let backupPath: string | undefined;
  let committed = 0;
  try {
    const current = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof current !== 'number' || !Number.isSafeInteger(targetVersion) || targetVersion <= current) fail('unsupported-schema');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID || db.prepare('SELECT identity FROM identity_manifest WHERE singleton=1').get()?.identity !== IDENTITY) fail('foreign-database');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('corrupt');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) fail('unavailable');
    const pendingJournal = db.prepare("SELECT count(*) AS n FROM secret_operation WHERE state<>'complete'").get()?.n !== 0;
    const protectedVault = db.prepare('SELECT count(*) AS n FROM local_vault WHERE protectionFormat IS NOT NULL OR contentKeyRef IS NOT NULL').get()?.n !== 0 || db.prepare('SELECT count(*) AS n FROM snippet').get()?.n !== 0;
    const chain: MigrationStep[] = [];
    let version = current;
    while (version < targetVersion) {
      const candidates = steps.filter(s => s.from === version);
      if (candidates.length !== 1) fail('unsupported-schema');
      const step = candidates[0]!;
      if (step.to !== version + 1 || step.to > targetVersion) fail('unsupported-schema');
      if (step.requiresProtection) fail('unavailable');
      chain.push(step);
      version = step.to;
    }
    if (protectedVault && chain.some((step) => !step.preservesProtection)) fail('unsupported-protection');
    if (pendingJournal && chain.some((step) => !step.preservesJournal)) fail('recovery-required');
    writable(path);
    writable(backupDestination);
    const space = statfsSync(dirname(backupDestination));
    if (space.bavail * space.bsize < statSync(path).size * 2 + 1048576) fail('unwritable');
    const backup = await createBackup(db, path, backupDestination, { allowPendingJournal: pendingJournal });
    // Only a backup this run created (exclusively) is ever removed below.
    backupPath = backupDestination;
    for (const step of chain) {
      try {
        db.exec('BEGIN IMMEDIATE');
        transaction = true;
        if (db.prepare('PRAGMA user_version').get()?.user_version !== step.from) fail('conflict');
        if (!step.preservesJournal) reconciled(db);
        step.apply(db);
        if (db.prepare('PRAGMA foreign_key_check').all().length) fail('constraint');
        db.exec(`PRAGMA user_version=${step.to}; COMMIT`);
        transaction = false;
        committed += 1;
      } catch {
        if (transaction) {
          db.exec('ROLLBACK');
          transaction = false;
        }
        fail('migration-failed');
      }
    }
    return success({
      schemaVersion: targetVersion,
      backup
    });
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    // Nothing committed: the store is unchanged, so this attempt's backup is redundant (no pile-up across launches).
    if (backupPath && committed === 0) {
      for (const file of [backupPath, `${backupPath}.manifest.json`]) {
        try { rmSync(file, { force: true }); } catch { /* best effort; the store itself is intact */ }
      }
    }
    return failure(error);
  }
}
