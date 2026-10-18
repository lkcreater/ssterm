import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export const APPLICATION_ID = 0x5353544d;
/** v4 (SST-033): metadata-only workspace templates. */
export const SCHEMA_VERSION = 4;
export const IDENTITY = 'ssterm-metadata-v1';
const uuidCheck = (name: string) => `CHECK(length(${name})=36 AND ${name} NOT GLOB '*[^0-9a-f-]*')`;
const common = `id TEXT PRIMARY KEY ${uuidCheck('id')}, vaultId TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL`;
const label = `label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200)`;
const portAuth = `portMode TEXT NOT NULL CHECK(portMode IN ('inherit','value')), portValue INTEGER, authMode TEXT NOT NULL CHECK(authMode IN ('inherit','value','clear')), identityId TEXT,
 CHECK((portMode='inherit' AND portValue IS NULL) OR (portMode='value' AND portValue IS NOT NULL AND portValue BETWEEN 1 AND 65535)),
 CHECK((authMode IN ('inherit','clear') AND identityId IS NULL) OR (authMode='value' AND identityId IS NOT NULL)),
 FOREIGN KEY(vaultId,identityId) REFERENCES identity(vaultId,id) DEFERRABLE INITIALLY DEFERRED`;
const secretKind = `CHECK(kind IN ('password','private-key','passphrase','content-key'))`;
/**
 * SST-030 (schema 3) host chain columns, shared by the fresh schema and the 2→3 `ALTER TABLE ADD COLUMN` step (host is
 * referenced by other tables, so it is extended rather than rebuilt). Proxy and jump host are exclusive.
 */
export const hostChainColumns = [
  "jumpHostId TEXT CHECK(jumpHostId IS NULL OR (jumpHostId<>id AND length(jumpHostId)=36)) REFERENCES host(id) DEFERRABLE INITIALLY DEFERRED",
  "proxyType TEXT CHECK(proxyType IS NULL OR (proxyType IN ('http','socks5') AND jumpHostId IS NULL))",
  "proxyHost TEXT CHECK((proxyType IS NULL AND proxyHost IS NULL) OR (proxyType IS NOT NULL AND proxyHost IS NOT NULL AND length(proxyHost)>0))",
  "proxyPort INTEGER CHECK((proxyType IS NULL AND proxyPort IS NULL) OR (proxyType IS NOT NULL AND proxyPort IS NOT NULL AND proxyPort BETWEEN 1 AND 65535))",
] as const;
/** Per-type shape, mirrored by `tunnelRuleProblem` in the domain. */
export const tunnelColumns = `${common}, ${label}, hostId TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('local','remote','dynamic')),
 bindAddress TEXT NOT NULL CHECK(bindAddress IN ('127.0.0.1','::1','0.0.0.0','::')), bindPort INTEGER NOT NULL CHECK(bindPort BETWEEN 0 AND 65535),
 destinationHost TEXT CHECK(destinationHost IS NULL OR length(destinationHost)>0), destinationPort INTEGER CHECK(destinationPort IS NULL OR destinationPort BETWEEN 1 AND 65535),
 CHECK(type='remote' OR bindAddress IN ('127.0.0.1','::1')), CHECK(type='remote' OR bindPort>=1),
 CHECK((type='dynamic' AND destinationHost IS NULL AND destinationPort IS NULL) OR (type<>'dynamic' AND destinationHost IS NOT NULL AND destinationPort IS NOT NULL)),
 FOREIGN KEY(vaultId,hostId) REFERENCES host(vaultId,id) DEFERRABLE INITIALLY DEFERRED`;
export const workspaceTemplateSql = `CREATE TABLE workspace_template (${common}, ${label}, configuration TEXT NOT NULL CHECK(json_valid(configuration)), UNIQUE(vaultId,id), FOREIGN KEY(vaultId) REFERENCES local_vault(id) DEFERRABLE INITIALLY DEFERRED) STRICT;`;
const rawSchemaSql = `
${workspaceTemplateSql}
CREATE TABLE identity_manifest (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL CHECK(identity='${IDENTITY}')) STRICT;
CREATE TABLE entity_registry (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE catalog_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
CREATE TABLE local_vault (id TEXT PRIMARY KEY ${uuidCheck('id')}, vaultId TEXT NOT NULL UNIQUE CHECK(vaultId=id), revision INTEGER NOT NULL CHECK(revision>=1), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, ${label}, contentKeyRef TEXT, protectionFormat TEXT, UNIQUE(vaultId,id), CHECK((contentKeyRef IS NULL AND protectionFormat IS NULL) OR (contentKeyRef IS NOT NULL AND length(protectionFormat)>0)), FOREIGN KEY(vaultId,contentKeyRef) REFERENCES secret_ref(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE secret_ref (${common}, kind TEXT NOT NULL ${secretKind}, operationId TEXT NOT NULL UNIQUE ${uuidCheck('operationId')}) STRICT;
CREATE TABLE key_metadata (${common}, ${label}, algorithm TEXT NOT NULL CHECK(length(algorithm)>0), publicKey TEXT NOT NULL CHECK(length(publicKey)>0), fingerprint TEXT NOT NULL CHECK(length(fingerprint)>0), privateKeyRef TEXT NOT NULL UNIQUE, passphraseRef TEXT UNIQUE, FOREIGN KEY(vaultId,privateKeyRef) REFERENCES secret_ref(vaultId,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(vaultId,passphraseRef) REFERENCES secret_ref(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE identity (${common}, ${label}, username TEXT NOT NULL CHECK(length(username)>0), method TEXT NOT NULL CHECK(method IN ('password','key','keyboard-interactive')), passwordRef TEXT UNIQUE, keyId TEXT, CHECK((method='password' AND keyId IS NULL) OR (method='key' AND keyId IS NOT NULL AND passwordRef IS NULL) OR (method='keyboard-interactive' AND keyId IS NULL AND passwordRef IS NULL)), FOREIGN KEY(vaultId,passwordRef) REFERENCES secret_ref(vaultId,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(vaultId,keyId) REFERENCES key_metadata(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE host_group (${common}, ${label}, parentId TEXT CHECK(parentId IS NULL OR parentId<>id), ${portAuth}, FOREIGN KEY(vaultId,parentId) REFERENCES host_group(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE host (${common}, ${label}, address TEXT NOT NULL CHECK(length(address)>0), groupId TEXT, environment TEXT CHECK(environment IN ('DEV','STAGING','PROD')), ${hostChainColumns.join(', ')}, ${portAuth}, FOREIGN KEY(vaultId,groupId) REFERENCES host_group(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE tag (${common}, ${label}, normalizedName TEXT NOT NULL CHECK(length(normalizedName)>0), UNIQUE(vaultId,normalizedName)) STRICT;
CREATE TABLE host_tag (vaultId TEXT NOT NULL, hostId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY(vaultId,hostId,tagId), FOREIGN KEY(vaultId,hostId) REFERENCES host(vaultId,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(vaultId,tagId) REFERENCES tag(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE snippet (${common}, ${label}, bodyEnvelope BLOB NOT NULL CHECK(length(bodyEnvelope)>0), envelopeVersion INTEGER NOT NULL CHECK(envelopeVersion>=1), keyRef TEXT NOT NULL, protectionFormat TEXT NOT NULL CHECK(length(protectionFormat)>0), FOREIGN KEY(vaultId,keyRef) REFERENCES secret_ref(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE snippet_tag (vaultId TEXT NOT NULL, snippetId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY(vaultId,snippetId,tagId), FOREIGN KEY(vaultId,snippetId) REFERENCES snippet(vaultId,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(vaultId,tagId) REFERENCES tag(vaultId,id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE known_host (${common}, endpointHost TEXT NOT NULL CHECK(length(endpointHost)>0), endpointPort INTEGER NOT NULL CHECK(endpointPort BETWEEN 1 AND 65535), algorithm TEXT NOT NULL CHECK(length(algorithm)>0), publicKey TEXT NOT NULL CHECK(length(publicKey)>0), fingerprint TEXT NOT NULL CHECK(length(fingerprint)>0), firstAcceptedAt TEXT NOT NULL, lastVerifiedAt TEXT NOT NULL, UNIQUE(vaultId,endpointHost,endpointPort)) STRICT;
CREATE TABLE tunnel_rule (${tunnelColumns}) STRICT;
CREATE TABLE app_settings (${common}, theme TEXT NOT NULL CHECK(theme='dark'), uiFont TEXT NOT NULL CHECK(uiFont='Inter'), uiFontSize INTEGER NOT NULL CHECK(uiFontSize BETWEEN 11 AND 20), terminalFont TEXT NOT NULL CHECK(terminalFont='JetBrains Mono'), terminalFontSize INTEGER NOT NULL CHECK(terminalFontSize BETWEEN 10 AND 32), terminalScrollback INTEGER NOT NULL CHECK(terminalScrollback BETWEEN 100 AND 100000), terminalPalette TEXT NOT NULL CHECK(terminalPalette='signal-blue-dark'), terminalCursor TEXT NOT NULL CHECK(terminalCursor IN ('block','bar','underline')), terminalCursorBlink INTEGER NOT NULL CHECK(terminalCursorBlink IN (0,1)), reducedMotion TEXT NOT NULL CHECK(reducedMotion IN ('system','on','off')), UNIQUE(vaultId)) STRICT;
CREATE TABLE secret_operation (operationId TEXT PRIMARY KEY ${uuidCheck('operationId')}, vaultId TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','replace','delete')), state TEXT NOT NULL CHECK(state IN ('staged','reconcile','cleanup','complete','needs-input')), intendedRef TEXT NOT NULL ${uuidCheck('intendedRef')}, kind TEXT NOT NULL ${secretKind}, oldRef TEXT, ownerType TEXT NOT NULL CHECK(ownerType IN ('vault','identity','key','snippet')), ownerId TEXT NOT NULL ${uuidCheck('ownerId')}, expectedRevision INTEGER CHECK(expectedRevision IS NULL OR expectedRevision>=1), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, CHECK((action='replace' AND oldRef IS NOT NULL) OR action IN ('create','delete')), FOREIGN KEY(vaultId) REFERENCES local_vault(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE UNIQUE INDEX single_vault ON local_vault((1));
CREATE INDEX host_group_idx ON host(vaultId,groupId);
CREATE INDEX group_parent_idx ON host_group(vaultId,parentId);
CREATE INDEX host_identity_idx ON host(vaultId,identityId);
CREATE INDEX group_identity_idx ON host_group(vaultId,identityId);
CREATE INDEX host_tag_tag_idx ON host_tag(vaultId,tagId);
CREATE INDEX snippet_tag_tag_idx ON snippet_tag(vaultId,tagId);
CREATE INDEX tunnel_host_idx ON tunnel_rule(vaultId,hostId);
CREATE INDEX host_jump_idx ON host(jumpHostId);
`;
export const schemaSql = rawSchemaSql.replace(/CREATE TABLE (secret_ref|key_metadata|identity|host_group|host|tag|snippet|known_host|tunnel_rule|app_settings) \(([\s\S]*?)\) STRICT;/g, (_all, name, fields) => `CREATE TABLE ${name} (${fields}, UNIQUE(vaultId,id), FOREIGN KEY(vaultId) REFERENCES local_vault(id) DEFERRABLE INITIALLY DEFERRED) STRICT;`);
export function initialize(db: DatabaseSync): void {
  const id = randomUUID();
  const time = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schemaSql);
    db.prepare('INSERT INTO identity_manifest VALUES(1,?)').run(IDENTITY);
    db.exec('INSERT INTO catalog_state VALUES(1,0)');
    db.prepare('INSERT INTO local_vault VALUES(?,?,?,?,?,?,?,?)').run(id, id, 1, time, time, 'Local vault', null, null);
    const settingsId = randomUUID();
    db.prepare('INSERT INTO entity_registry VALUES(?)').run(id);
    db.prepare('INSERT INTO entity_registry VALUES(?)').run(settingsId);
    db.prepare('INSERT INTO app_settings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(settingsId, id, 1, time, time, 'dark', 'Inter', 13, 'JetBrains Mono', 13, 10000, 'signal-blue-dark', 'block', 0, 'system');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
