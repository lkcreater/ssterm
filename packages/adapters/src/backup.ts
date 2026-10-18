import { backup as sqliteBackup, type DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, fstatSync, chmodSync, readFileSync, writeFileSync, fsyncSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync as Sqlite } from 'node:sqlite';
import type { BackupManifest } from '@ssterm/domain';
import { canonicalDestination, removeOwned, writable } from './files.ts';
import { fail } from './errors.ts';
function manifestFacts(db: DatabaseSync): { schemaVersion: number; catalogRevision: number; vaultId: string; protectionFormats: string[] } {
  const schemaVersion = db.prepare('PRAGMA user_version').get()?.user_version;
  const catalogRevision = db.prepare('SELECT revision FROM catalog_state WHERE singleton=1').get()?.revision;
  const vaults = db.prepare('SELECT id, protectionFormat FROM local_vault').all();
  if (!Number.isSafeInteger(schemaVersion) || !Number.isSafeInteger(catalogRevision) || vaults.length !== 1 || typeof vaults[0]?.id !== 'string') fail('corrupt');
  const formats = [vaults[0]!.protectionFormat, ...db.prepare('SELECT DISTINCT protectionFormat FROM snippet').all().map((row) => row.protectionFormat)];
  return {
    schemaVersion: schemaVersion as number,
    catalogRevision: catalogRevision as number,
    vaultId: vaults[0]!.id as string,
    protectionFormats: [...new Set(formats.filter((f): f is string => typeof f === 'string'))].sort(),
  };
}
export function reconciled(db: DatabaseSync): void {
  if (db.prepare("SELECT count(*) AS n FROM secret_operation WHERE state<>'complete'").get()?.n !== 0) fail('recovery-required');
}
/** Reserves both artifacts exclusively. The SQLite online backup includes committed WAL pages. */
/**
 * `allowPendingJournal` is only for the pre-migration copy: a byte-for-byte snapshot taken before a step that never
 * touches the secret journal, so an unreconciled journal is carried over unchanged for runtime reconciliation.
 */
export async function createBackup(db: DatabaseSync, source: string, destination: string, options: { allowPendingJournal?: boolean } = {}): Promise<BackupManifest> {
  if (typeof destination !== 'string' || !isAbsolute(destination) || destination.includes('\0')) fail('invalid-request');
  if (canonicalDestination(destination) === canonicalDestination(source)) fail('invalid-request');
  writable(destination);
  if (!options.allowPendingJournal) reconciled(db);
  const sidecar = `${destination}.manifest.json`;
  const owned: {
    path: string;
    dev: number;
    ino: number;
  }[] = [];
  try {
    for (const path of [destination, sidecar]) {
      const fd = openSync(path, 'wx', 0o600);
      try {
        const st = fstatSync(fd);
        owned.push({
          path,
          dev: st.dev,
          ino: st.ino
        });
      } finally {
        closeSync(fd);
      }
    }
    await sqliteBackup(db, destination);
    for (const file of owned) {
      const st = statSync(file.path);
      if (st.dev !== file.dev || st.ino !== file.ino) fail('io');
      chmodSync(file.path, 0o600);
    }
    const check = new Sqlite(destination, {
      readOnly: true
    });
    let facts;
    try {
      if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || check.prepare('PRAGMA foreign_key_check').all().length) fail('corrupt');
      if (!options.allowPendingJournal) reconciled(check);
      // Read only tables and columns every schema version has: a pre-migration copy keeps the older layout.
      facts = manifestFacts(check);
    } finally {
      check.close();
    }
    const manifest: BackupManifest = {
      format: 'ssterm-metadata-backup-v1',
      schemaVersion: facts.schemaVersion,
      catalogRevision: facts.catalogRevision,
      vaultId: facts.vaultId,
      protectionFormats: facts.protectionFormats,
      sha256: createHash('sha256').update(readFileSync(destination)).digest('hex'),
      createdAt: new Date().toISOString(),
      includesOsSecrets: false
    };
    writeFileSync(sidecar, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600
    });
    for (const file of owned) {
      const fd = openSync(file.path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return manifest;
  } catch (error) {
    for (const file of owned) removeOwned(file.path, file);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('constraint');
    throw error;
  }
}
