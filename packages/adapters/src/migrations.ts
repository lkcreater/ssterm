/** Internal migration runner. Production currently ships schema v1 only. */
import type { DatabaseSync } from 'node:sqlite';
import { statfsSync, statSync } from 'node:fs';
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
  try {
    const current = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof current !== 'number' || !Number.isSafeInteger(targetVersion) || targetVersion <= current) fail('unsupported-schema');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID || db.prepare('SELECT identity FROM identity_manifest WHERE singleton=1').get()?.identity !== IDENTITY) fail('foreign-database');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('corrupt');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) fail('unavailable');
    reconciled(db);
    if (db.prepare('SELECT count(*) AS n FROM local_vault WHERE protectionFormat IS NOT NULL OR contentKeyRef IS NOT NULL').get()?.n !== 0 || db.prepare('SELECT count(*) AS n FROM snippet').get()?.n !== 0) fail('unsupported-protection');
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
    writable(path);
    writable(backupDestination);
    const space = statfsSync(dirname(backupDestination));
    if (space.bavail * space.bsize < statSync(path).size * 2 + 1048576) fail('unwritable');
    const backup = await createBackup(db, path, backupDestination);
    for (const step of chain) {
      try {
        db.exec('BEGIN IMMEDIATE');
        transaction = true;
        if (db.prepare('PRAGMA user_version').get()?.user_version !== step.from) fail('conflict');
        reconciled(db);
        step.apply(db);
        if (db.prepare('PRAGMA foreign_key_check').all().length) fail('constraint');
        db.exec(`PRAGMA user_version=${step.to}; COMMIT`);
        transaction = false;
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
    return failure(error);
  }
}
