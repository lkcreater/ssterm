import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { MetadataSnapshot, Entity } from '@ssterm/domain';
import { fail } from './errors.ts';
const common = ['id', 'vaultId', 'revision', 'createdAt', 'updatedAt'];
const overrides = ['portMode', 'portValue', 'authMode', 'identityId'];
export const tables = {
  vault: ['local_vault', [...common, 'label', 'contentKeyRef', 'protectionFormat']],
  settings: ['app_settings', [...common, 'theme', 'uiFont', 'uiFontSize', 'terminalFont', 'terminalFontSize', 'terminalScrollback', 'terminalPalette', 'terminalCursor', 'terminalCursorBlink', 'reducedMotion']],
  hosts: ['host', [...common, 'label', 'address', 'groupId', 'environment', ...overrides]],
  groups: ['host_group', [...common, 'label', 'parentId', ...overrides]],
  identities: ['identity', [...common, 'label', 'username', 'method', 'passwordRef', 'keyId']],
  tags: ['tag', [...common, 'label', 'normalizedName']],
  hostTags: ['host_tag', ['vaultId', 'hostId', 'tagId']],
  snippetTags: ['snippet_tag', ['vaultId', 'snippetId', 'tagId']],
  keys: ['key_metadata', [...common, 'label', 'algorithm', 'publicKey', 'fingerprint', 'privateKeyRef', 'passphraseRef']],
  secretRefs: ['secret_ref', [...common, 'kind', 'operationId']],
  snippets: ['snippet', [...common, 'label', 'bodyEnvelope', 'envelopeVersion', 'keyRef', 'protectionFormat']],
  knownHosts: ['known_host', [...common, 'endpointHost', 'endpointPort', 'algorithm', 'publicKey', 'fingerprint', 'firstAcceptedAt', 'lastVerifiedAt']],
  tunnelRules: ['tunnel_rule', [...common, 'label', 'hostId', 'type', 'bindAddress', 'bindPort', 'destinationHost', 'destinationPort']],
  secretOperations: ['secret_operation', ['operationId', 'vaultId', 'action', 'state', 'intendedRef', 'kind', 'oldRef', 'ownerType', 'ownerId', 'expectedRevision', 'createdAt', 'updatedAt']]
} as const;
function decode(row: Record<string, unknown>): Record<string, unknown> {
  const result = {
    ...row
  };
  if ('portMode' in result) {
    result.port = result.portMode === 'value' ? {
      mode: 'value',
      port: result.portValue
    } : {
      mode: 'inherit'
    };
    result.auth = result.authMode === 'value' ? {
      mode: 'value',
      identityId: result.identityId
    } : {
      mode: result.authMode
    };
    delete result.portMode;
    delete result.portValue;
    delete result.authMode;
    delete result.identityId;
  }
  if ('terminalCursorBlink' in result) result.terminalCursorBlink = result.terminalCursorBlink === 1;
  return result;
}
export function readSnapshot(db: DatabaseSync): MetadataSnapshot {
  const result: Record<string, unknown> = {
    schemaVersion: db.prepare('PRAGMA user_version').get()?.user_version,
    catalogRevision: db.prepare('SELECT revision FROM catalog_state WHERE singleton=1').get()?.revision
  };
  for (const [key, [table, columns]] of Object.entries(tables)) {
    const rows = db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY ${key === 'secretOperations' ? 'operationId' : key === 'hostTags' ? 'hostId,tagId' : key === 'snippetTags' ? 'snippetId,tagId' : 'id'}`).all().map(decode);
    if (key === 'vault' || key === 'settings') {
      if (rows.length !== 1) fail('corrupt');
      result[key] = rows[0];
    } else result[key] = rows;
  }
  if (!Number.isSafeInteger(result.catalogRevision) || result.catalogRevision as number < 0) fail('corrupt');
  return result as unknown as MetadataSnapshot;
}
function encode(raw: unknown, columns: readonly string[]): SQLInputValue[] {
  const row = {
    ...(raw as Record<string, unknown>)
  };
  if ('port' in row) {
    const port = row.port as {
      mode: string;
      port?: number;
    };
    const auth = row.auth as {
      mode: string;
      identityId?: string;
    };
    row.portMode = port.mode;
    row.portValue = port.port ?? null;
    row.authMode = auth.mode;
    row.identityId = auth.identityId ?? null;
  }
  if ('terminalCursorBlink' in row) row.terminalCursorBlink = row.terminalCursorBlink ? 1 : 0;
  return columns.map(key => row[key] as SQLInputValue);
}
/** Replaces only writable metadata under deferred NO ACTION FKs, avoiding transient rename uniqueness collisions. */
export function writeSnapshot(db: DatabaseSync, s: MetadataSnapshot): void {
  const collections = ['hostTags', 'snippetTags', 'tunnelRules', 'hosts', 'groups', 'identities', 'tags', 'keys', 'snippets', 'knownHosts', 'secretRefs', 'secretOperations'] as const;
  for (const key of collections) db.exec(`DELETE FROM ${tables[key][0]}`);
  for (const key of collections) {
    const [table, columns] = tables[key];
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of s[key]) insert.run(...encode(row, columns));
  }
  for (const key of ['vault', 'settings'] as const) {
    const [table, columns] = tables[key];
    db.prepare(`UPDATE ${table} SET ${columns.map(c => `${c}=?`).join(',')} WHERE id=?`).run(...encode(s[key], columns), s[key].id);
  }
  db.prepare('UPDATE catalog_state SET revision=? WHERE singleton=1').run(s.catalogRevision);
}
/** Journal intended refs are reserved when staged, so a published descriptor reuses its own reservation. */
function registeredIds(s: MetadataSnapshot): Set<string> {
  const ids = new Set<string>([s.vault.id, s.settings.id, ...s.secretOperations.map(op => op.intendedRef)]);
  for (const key of ['hosts', 'groups', 'identities', 'tags', 'tunnelRules', 'keys', 'snippets', 'knownHosts', 'secretRefs'] as const) for (const row of s[key] as Entity[]) ids.add(row.id);
  return ids;
}
export function reserveNewIds(db: DatabaseSync, before: MetadataSnapshot, after: MetadataSnapshot): void {
  const previous = registeredIds(before);
  const insert = db.prepare('INSERT INTO entity_registry(id) VALUES(?)');
  for (const id of registeredIds(after)) if (!previous.has(id)) insert.run(id);
}
