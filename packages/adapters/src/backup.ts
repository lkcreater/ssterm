import { backup as sqliteBackup, type DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, fstatSync, chmodSync, readFileSync, writeFileSync, fsyncSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync as Sqlite } from 'node:sqlite';
import type { BackupManifest } from '@ssterm/domain';
import { readSnapshot } from './records.ts';
import { canonicalDestination, removeOwned, writable } from './files.ts';
import { fail } from './errors.ts';
export function reconciled(db: DatabaseSync): void {
  if (db.prepare("SELECT count(*) AS n FROM secret_operation WHERE state<>'complete'").get()?.n !== 0) fail('recovery-required');
}
/** Reserves both artifacts exclusively. The SQLite online backup includes committed WAL pages. */
export async function createBackup(db: DatabaseSync, source: string, destination: string): Promise<BackupManifest> {
  if (typeof destination !== 'string' || !isAbsolute(destination) || destination.includes('\0')) fail('invalid-request');
  if (canonicalDestination(destination) === canonicalDestination(source)) fail('invalid-request');
  writable(destination);
  reconciled(db);
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
    let snapshot;
    try {
      if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || check.prepare('PRAGMA foreign_key_check').all().length) fail('corrupt');
      reconciled(check);
      snapshot = readSnapshot(check);
    } finally {
      check.close();
    }
    const manifest: BackupManifest = {
      format: 'ssterm-metadata-backup-v1',
      schemaVersion: snapshot.schemaVersion,
      catalogRevision: snapshot.catalogRevision,
      vaultId: snapshot.vault.id,
      protectionFormats: [...new Set([snapshot.vault.protectionFormat, ...snapshot.snippets.map(s => s.protectionFormat)].filter((f): f is string => f !== null))].sort(),
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
