import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openMetadata, decodeHostPublicKey } from '../../packages/adapters/src/index.ts';
import { runMigrations } from '../../packages/adapters/src/migrations.ts';
import { downgradeToSchemaV1 } from '../fixtures/storage/schema-v1.ts';
import { CatalogModule } from '../../packages/services/src/index.ts';
import { normalizeEndpoint, normalizeTag, type StoreResult, type MetadataRepository, type MetadataSnapshot, type MetadataChange } from '../../packages/domain/src/index.ts';
function value<T>(result: StoreResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
function code(result: StoreResult<unknown>, expected: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, expected);
    assert.ok(!/\/private|SELECT|SQLITE|fixture-sensitive/u.test(result.error.message));
  }
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync('/private/tmp/ssterm-storage-test-');
  const path = join(dir, 'metadata.db');
  const repo = value(await openMetadata({
    path
  }));
  t.after(() => {
    repo.close();
    rmSync(dir, {
      recursive: true,
      force: true
    });
  });
  const snapshot = () => value(repo.snapshot());
  const commit = (changes: MetadataChange[]) => value(repo.commit({
    expectedCatalogRevision: snapshot().catalogRevision,
    changes
  }));
  return {
    dir,
    path,
    repo,
    snapshot,
    commit
  };
}
const host = (id = randomUUID(), address = 'EXAMPLE.COM.') => ({
  type: 'create-host' as const,
  id,
  data: {
    label: 'เครื่องทดสอบ',
    address
  }
});
const update = (id: string, revision: number, data: {
  label?: string;
  address?: string;
}) => ({
  type: 'update-host' as const,
  id,
  expectedRevision: revision,
  data
});
function raw(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
test('metadata CRUD, Thai, independent settings and restart durability cross the production interface', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const before = f.snapshot();
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.catalogRevision, 0);
  assert.equal(before.settings.terminalScrollback, 10000);
  let next = f.commit([host(id)]);
  assert.equal(next.hosts[0]?.address, 'example.com');
  assert.equal(next.hosts[0]?.revision, 1);
  next = f.commit([update(id, 1, {
    label: 'ระบบไทย',
    address: '[2001:0db8::1]'
  }), {
    type: 'update-settings',
    expectedRevision: 1,
    data: {
      terminalFontSize: 18,
      terminalCursorBlink: true
    }
  }, {
    type: 'update-vault',
    expectedRevision: 1,
    data: {
      label: 'ท้องถิ่น'
    }
  }]);
  assert.equal(next.hosts[0]?.address, '2001:db8::1');
  assert.equal(next.hosts[0]?.revision, 2);
  assert.equal(next.settings.uiFontSize, 13);
  assert.equal(next.settings.terminalCursorBlink, true);
  f.repo.close();
  f.repo.close();
  code(f.repo.snapshot(), 'closed');
  code(f.repo.commit({
    expectedCatalogRevision: 2,
    changes: [host()]
  }), 'closed');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {openMetadata} from ${JSON.stringify(resolve('packages/adapters/src/index.ts'))};const r=await openMetadata({path:process.env.SSTERM_TEST_DB});if(!r.ok)throw Error(r.error.code);console.log(JSON.stringify(r.value.snapshot()));r.value.close();`], {
    cwd: process.cwd(),
    timeout: 10000,
    env: {
      ...process.env,
      SSTERM_TEST_DB: f.path,
      NODE_NO_WARNINGS: '1'
    },
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  const reopened = JSON.parse(child.stdout) as StoreResult<MetadataSnapshot>;
  assert.deepEqual(value(reopened), next);
  const repo = value(await openMetadata({
    path: f.path
  }));
  t.after(() => repo.close());
  value(repo.commit({
    expectedCatalogRevision: 2,
    changes: [{
      type: 'delete-host',
      id,
      expectedRevision: 2
    }]
  }));
  assert.equal(value(repo.snapshot()).hosts.length, 0);
});
test('stale global and row revisions, multirow failure and two writers never publish partial edits', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  f.commit([host(id)]);
  const other = value(await openMetadata({
    path: f.path
  }));
  t.after(() => other.close());
  value(other.commit({
    expectedCatalogRevision: 1,
    changes: [update(id, 1, {
      label: 'winner'
    })]
  }));
  code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [update(id, 1, {
      label: 'stale'
    })]
  }), 'conflict');
  const before = f.snapshot();
  code(f.repo.commit({
    expectedCatalogRevision: 2,
    changes: [host(), update(id, 1, {
      label: 'stale'
    })]
  }), 'conflict');
  assert.deepEqual(f.snapshot(), before);
  code(f.repo.commit({
    expectedCatalogRevision: 2,
    changes: [update(id, 2, {
      label: 'must roll back'
    }), host(randomUUID(), 'https://bad.example/')]
  }), 'invalid-request');
  assert.deepEqual(f.snapshot(), before);
});
test('atomic graph edits preserve inheritance and clear; cycles and restricted deletions roll back', async t => {
  const f = await fixture(t);
  const g = randomUUID(),
    child = randomUUID(),
    i = randomUUID(),
    h = randomUUID();
  const s = f.commit([{
    type: 'create-group',
    id: g,
    data: {
      label: 'parent',
      port: {
        mode: 'value',
        port: 2222
      },
      auth: {
        mode: 'value',
        identityId: i
      }
    }
  }, {
    type: 'create-group',
    id: child,
    data: {
      label: 'child',
      parentId: g
    }
  }, {
    type: 'create-identity',
    id: i,
    data: {
      label: 'prompt',
      username: 'alice',
      method: 'password'
    }
  }, {
    ...host(h),
    data: {
      ...host(h).data,
      groupId: child
    }
  }]);
  assert.deepEqual(s.groups.find(r => r.id === g)?.auth, {
    mode: 'value',
    identityId: i
  });
  code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [{
      type: 'update-group',
      id: g,
      expectedRevision: 1,
      data: {
        parentId: child
      }
    }]
  }), 'constraint');
  assert.deepEqual(f.snapshot(), s);
  code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [{
      type: 'delete-identity',
      id: i,
      expectedRevision: 1
    }]
  }), 'constraint');
  const next = f.commit([{
    type: 'delete-identity',
    id: i,
    expectedRevision: 1
  }, {
    type: 'update-group',
    id: g,
    expectedRevision: 1,
    data: {
      auth: {
        mode: 'clear'
      }
    }
  }]);
  assert.equal(next.identities.length, 0);
  assert.deepEqual(next.groups.find(r => r.id === g)?.auth, {
    mode: 'clear'
  });
  assert.deepEqual(next.groups.find(r => r.id === child)?.auth, {
    mode: 'inherit'
  });
  code(f.repo.commit({
    expectedCatalogRevision: 2,
    changes: [{
      type: 'delete-group',
      id: g,
      expectedRevision: 2
    }]
  }), 'constraint');
  f.commit([{
    type: 'delete-group',
    id: g,
    expectedRevision: 2
  }, {
    type: 'update-group',
    id: child,
    expectedRevision: 1,
    data: {
      parentId: null
    }
  }]);
  assert.equal(f.snapshot().hosts[0]?.groupId, child);
});
test('memberships and ordinary edits increment owner once; explicit dependents permit deletion without cascades', async t => {
  const f = await fixture(t);
  const h = randomUUID(),
    tag = randomUUID(),
    tunnel = randomUUID();
  let s = f.commit([host(h), {
    type: 'create-tag',
    id: tag,
    data: {
      label: ' Production '
    }
  }, {
    type: 'set-host-tag',
    hostId: h,
    tagId: tag,
    present: true,
    expectedHostRevision: 1
  }, {
    type: 'create-tunnel-rule',
    id: tunnel,
    data: {
      label: 'local',
      hostId: h,
      bindPort: 8080,
      destinationHost: 'LOCALHOST.',
      destinationPort: 80
    }
  }]);
  assert.equal(s.hosts[0]?.revision, 1);
  assert.equal(s.hostTags.length, 1);
  assert.equal(s.tags[0]?.normalizedName, 'production');
  assert.equal(s.tunnelRules[0]?.destinationHost, 'localhost');
  s = f.commit([update(h, 1, {
    label: 'edited'
  }), {
    type: 'set-host-tag',
    hostId: h,
    tagId: tag,
    present: true,
    expectedHostRevision: 1
  }, {
    type: 'set-host-tag',
    hostId: h,
    tagId: tag,
    present: true,
    expectedHostRevision: 1
  }]);
  assert.equal(s.hostTags.length, 1);
  assert.equal(s.hosts[0]?.revision, 2);
  code(f.repo.commit({
    expectedCatalogRevision: 2,
    changes: [{
      type: 'delete-host',
      id: h,
      expectedRevision: 2
    }]
  }), 'constraint');
  assert.deepEqual(f.snapshot(), s);
  code(f.repo.commit({
    expectedCatalogRevision: 2,
    changes: [{
      type: 'delete-tag',
      id: tag,
      expectedRevision: 1
    }]
  }), 'constraint');
  s = f.commit([{
    type: 'delete-host',
    id: h,
    expectedRevision: 2
  }, {
    type: 'delete-tag',
    id: tag,
    expectedRevision: 1
  }, {
    type: 'delete-tunnel-rule',
    id: tunnel,
    expectedRevision: 1
  }, {
    type: 'set-host-tag',
    hostId: h,
    tagId: tag,
    present: false,
    expectedHostRevision: 2
  }]);
  assert.equal(s.hosts.length, 0);
  assert.equal(s.hostTags.length, 0);
  assert.equal(s.tunnelRules.length, 0);
  assert.equal(s.tags.length, 0);
  code(f.repo.commit({
    expectedCatalogRevision: 3,
    changes: [host(h)]
  }), 'constraint');
});
test('Unicode tag collision and settings/auth discriminants reject whole batches and unknown/raw-secret keys', async t => {
  const f = await fixture(t);
  const tag = randomUUID();
  f.commit([{
    type: 'create-tag',
    id: tag,
    data: {
      label: 'É'
    }
  }]);
  const before = f.snapshot();
  for (const changes of [[{
    type: 'create-tag',
    id: randomUUID(),
    data: {
      label: 'e\u0301'
    }
  }], [{
    type: 'update-settings',
    expectedRevision: 1,
    data: {
      terminalScrollback: 99
    }
  }], [{
    type: 'update-settings',
    expectedRevision: 1,
    data: {
      uiFont: 'file:///private/font.ttf'
    }
  }], [{
    type: 'update-settings',
    expectedRevision: 1,
    data: {
      css: 'fixture-sensitive'
    }
  }], [{
    ...host(),
    data: {
      label: 'x',
      address: 'example.com',
      password: 'fixture-sensitive'
    }
  }], [{
    ...host(),
    data: {
      label: 'x',
      address: 'example.com',
      port: {
        mode: 'inherit',
        port: 22
      }
    }
  }], [{
    ...host(),
    data: {
      label: 'x',
      address: 'example.com',
      auth: {
        mode: 'clear',
        identityId: randomUUID()
      }
    }
  }], [{
    ...host(),
    data: {
      label: 'x',
      address: 'example.com',
      environment: 'UNKNOWN'
    }
  }], [{
    type: 'create-identity',
    id: randomUUID(),
    data: {
      label: 'x',
      username: 'a\nb',
      method: 'password'
    }
  }]]) {
    const result = f.repo.commit({
      expectedCatalogRevision: 1,
      changes: changes as MetadataChange[]
    });
    assert.equal(result.ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
  // Trust accepts finite decisions only; protected writes accept only typed envelopes/refs, never plaintext fields.
  for (const [type, expected] of [['create-known-host', 'invalid-request'], ['create-snippet', 'invalid-request'], ['update-secret-ref', 'invalid-request'], ['create-key', 'invalid-request']]) code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [{
      type,
      id: randomUUID(),
      data: {
        body: 'fixture-sensitive'
      }
    }] as unknown as MetadataChange[]
  }), expected!);
  code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [{
      type: 'create-identity',
      id: randomUUID(),
      data: {
        label: 'saved',
        username: 'a',
        method: 'password',
        passwordRef: randomUUID()
      }
    }] as unknown as MetadataChange[]
  }), 'constraint');
  code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [{
      type: 'create-identity',
      id: randomUUID(),
      data: {
        label: 'key',
        username: 'a',
        method: 'key',
        keyId: randomUUID()
      }
    }] as unknown as MetadataChange[]
  }), 'constraint');
  assert.deepEqual(f.snapshot(), before);
});
test('shared endpoint normalization has deterministic IDNA, IP and invalid fixtures', () => {
  for (const [input, expected] of [['EXAMPLE.COM.', 'example.com'], ['bücher.example', 'xn--bcher-kva.example'], ['192.0.2.1', '192.0.2.1'], ['[2001:0DB8:0:0::1]', '2001:db8::1'], ['::1', '::1']]) assert.equal(normalizeEndpoint(input!), expected);
  for (const input of ['', ' example.com', 'https://example.com', 'example.com:22', 'a/b', 'user@host', 'host?x', '[fe80::1%en0]', '127.1', '0127.0.0.1', '0x7f000001', '[192.0.2.1]', '999.1.1.1', 'host..name', '-x.example', 'x'.repeat(64) + '.com', '\u0000example.com']) assert.throws(() => normalizeEndpoint(input));
  assert.equal(normalizeTag(' E\u0301 '), 'é');
});
test('SQL schema independently enforces types, same-vault FKs, union payloads, unique credentials and ciphertext-only storage', async t => {
  const f = await fixture(t);
  f.repo.close();
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const v = String(db.prepare('SELECT id FROM local_vault').get()?.id),
    now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO host VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  assert.throws(() => insert.run(randomUUID(), randomUUID(), 1, now, now, 'x', 'example.com', null, null, 'inherit', null, 'inherit', null));
  assert.throws(() => insert.run(randomUUID(), v, 1, now, now, 'x', 'example.com', null, null, 'value', null, 'inherit', null));
  assert.throws(() => insert.run(randomUUID(), v, 1, now, now, 'x', 'example.com', null, null, 'inherit', 22, 'inherit', null));
  assert.throws(() => insert.run(randomUUID(), v, 1, now, now, 'x', 'example.com', null, 'OTHER', 'inherit', null, 'inherit', null));
  const ref = randomUUID();
  db.prepare('INSERT INTO secret_ref VALUES(?,?,?,?,?,?,?)').run(ref, v, 1, now, now, 'password', randomUUID());
  const identity = db.prepare('INSERT INTO identity VALUES(?,?,?,?,?,?,?,?,?,?)');
  identity.run(randomUUID(), v, 1, now, now, 'first', 'alice', 'password', ref, null);
  assert.throws(() => identity.run(randomUUID(), v, 1, now, now, 'second', 'bob', 'password', ref, null));
  assert.throws(() => identity.run(randomUUID(), v, 1, now, now, 'invalid', 'alice', 'keyboard-interactive', ref, null));
  const columns = db.prepare('PRAGMA table_info(snippet)').all();
  assert.ok(columns.some(r => r.name === 'bodyEnvelope' && r.type === 'BLOB'));
  assert.ok(!columns.some(r => ['body', 'plaintext', 'preview'].includes(String(r.name))));
});
test('WAL-aware backup carries committed rows, checksum, 0600 sidecar, no overwrite and can reopen', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  f.commit([host(id)]);
  assert.ok(existsSync(f.path + '-wal'));
  const destination = join(f.dir, 'backup.db');
  const manifest = value(await f.repo.backup({
    destination
  }));
  assert.equal(manifest.catalogRevision, 1);
  assert.equal(manifest.includesOsSecrets, false);
  assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(destination)).digest('hex'));
  assert.deepEqual(JSON.parse(readFileSync(destination + '.manifest.json', 'utf8')), manifest);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(statSync(destination + '.manifest.json').mode & 0o777, 0o600);
  const backup = value(await openMetadata({
    path: destination
  }));
  t.after(() => backup.close());
  assert.equal(value(backup.snapshot()).hosts[0]?.id, id);
  const bytes = readFileSync(destination);
  code(await f.repo.backup({
    destination
  }), 'constraint');
  assert.deepEqual(readFileSync(destination), bytes);
  code(await f.repo.backup({
    destination: f.path
  }), 'invalid-request');
  const failed = join(f.dir, 'occupied.db');
  writeFileSync(failed + '.manifest.json', 'user-owned');
  code(await f.repo.backup({
    destination: failed
  }), 'constraint');
  assert.equal(existsSync(failed), false);
  assert.equal(readFileSync(failed + '.manifest.json', 'utf8'), 'user-owned');
});
test('backup quiesces mutation and overlapping backups; close waits for active native backup', async t => {
  const f = await fixture(t);
  f.commit(Array.from({
    length: 100
  }, () => host()));
  const destination = join(f.dir, 'backup.db');
  const pending = f.repo.backup({
    destination
  });
  code(f.repo.commit({
    expectedCatalogRevision: 1,
    changes: [host()]
  }), 'busy');
  code(await f.repo.backup({
    destination: join(f.dir, 'other.db')
  }), 'busy');
  code(f.repo.snapshot(), 'busy');
  f.repo.close();
  f.repo.close();
  code(f.repo.snapshot(), 'closed');
  value(await pending);
  code(f.repo.snapshot(), 'closed');
  const repo = value(await openMetadata({
    path: destination
  }));
  t.after(() => repo.close());
  assert.equal(value(repo.snapshot()).hosts.length, 100);
});
test('safe open blocks zero/foreign/newer/corrupt/FK-invalid/unwritable storage without replacing bytes', async t => {
  for (const [kind, expected] of [['zero', 'foreign-database'], ['foreign', 'foreign-database'], ['newer', 'unsupported-schema'], ['version-zero', 'unsupported-schema'], ['manifest', 'foreign-database'], ['corrupt', 'corrupt'], ['fk', 'corrupt'], ['unwritable', 'unwritable']] as const) {
    const dir = mkdtempSync('/private/tmp/ssterm-storage-invalid-');
    t.after(() => rmSync(dir, {
      recursive: true,
      force: true
    }));
    const path = join(dir, 'metadata.db');
    if (kind === 'zero') writeFileSync(path, '');else if (kind === 'foreign') raw(path, 'CREATE TABLE other(value TEXT)');else if (kind === 'corrupt') writeFileSync(path, 'fixture-sensitive broken SQLite file');else {
      const repo = value(await openMetadata({
        path
      }));
      const s = value(repo.snapshot());
      repo.close();
      if (kind === 'newer') raw(path, 'PRAGMA user_version=3');
      if (kind === 'version-zero') raw(path, 'PRAGMA user_version=0');
      if (kind === 'manifest') raw(path, "PRAGMA ignore_check_constraints=ON; UPDATE identity_manifest SET identity='foreign'");
      if (kind === 'fk') raw(path, `PRAGMA foreign_keys=OFF; INSERT INTO host VALUES('${randomUUID()}','${s.vault.id}',1,'${s.vault.createdAt}','${s.vault.createdAt}','x','example.com','${randomUUID()}',NULL,'inherit',NULL,'inherit',NULL)`);
      if (kind === 'unwritable') chmodSync(path, 0o400);
    }
    const before = readFileSync(path);
    code(await openMetadata({
      path
    }), expected);
    assert.deepEqual(readFileSync(path), before, kind);
  }
});
test('pending secret journal opens for reconciliation but blocks backup; unsupported protection fails closed', async t => {
  const f = await fixture(t);
  const s = f.snapshot();
  const writer = new DatabaseSync(f.path);
  t.after(() => {
    if (writer.isOpen) writer.close();
  });
  writer.prepare('INSERT INTO secret_operation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), s.vault.id, 'create', 'staged', randomUUID(), 'password', null, 'identity', randomUUID(), null, s.vault.createdAt, s.vault.createdAt);
  code(await f.repo.backup({
    destination: join(f.dir, 'blocked.db')
  }), 'recovery-required');
  assert.equal(f.commit([host()]).secretOperations[0]?.state, 'staged');
  f.repo.close();
  writer.close();
  const reopened = value(await openMetadata({
    path: f.path
  }));
  code(await reopened.backup({
    destination: join(f.dir, 'still-blocked.db')
  }), 'recovery-required');
  reopened.close();
  raw(f.path, "DELETE FROM secret_operation");
  const db = new DatabaseSync(f.path);
  const ref = randomUUID();
  db.prepare('INSERT INTO secret_ref VALUES(?,?,?,?,?,?,?)').run(ref, s.vault.id, 1, s.vault.createdAt, s.vault.createdAt, 'content-key', randomUUID());
  db.prepare('UPDATE local_vault SET contentKeyRef=?,protectionFormat=?').run(ref, 'future-provider-v99');
  db.close();
  const protectedBytes = readFileSync(f.path);
  code(await openMetadata({
    path: f.path
  }), 'unsupported-protection');
  assert.deepEqual(readFileSync(f.path), protectedBytes);
});
test('bounded lock contention returns busy without leaking SQLite or losing rows', async t => {
  const f = await fixture(t);
  const writer = new DatabaseSync(f.path);
  t.after(() => {
    if (writer.isOpen) writer.close();
  });
  writer.exec('BEGIN IMMEDIATE');
  const start = Date.now();
  code(f.repo.commit({
    expectedCatalogRevision: 0,
    changes: [host()]
  }), 'busy');
  assert.ok(Date.now() - start < 1500);
  writer.exec('ROLLBACK');
  assert.equal(f.snapshot().catalogRevision, 0);
  f.commit([host()]);
});
test('future internal migration chain preflights all steps, backs up v1, preserves committed prior steps and rolls back failure', async t => {
  const f = await fixture(t);
  f.commit([host()]);
  f.repo.close();
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const destination = join(f.dir, 'before-migration.db');
  const missing = await runMigrations({
    db,
    path: f.path,
    targetVersion: 4,
    backupDestination: destination,
    steps: [{
      from: 2,
      to: 3,
      apply: () => assert.fail('must not run')
    }]
  });
  code(missing, 'unsupported-schema');
  assert.equal(existsSync(destination), false);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
  code(await runMigrations({
    db,
    path: f.path,
    targetVersion: 3,
    backupDestination: destination,
    steps: [{
      from: 2,
      to: 3,
      requiresProtection: true,
      apply: () => assert.fail('must not run')
    }]
  }), 'unavailable');
  assert.equal(existsSync(destination), false);
  const result = await runMigrations({
    db,
    path: f.path,
    targetVersion: 4,
    backupDestination: destination,
    steps: [{
      from: 2,
      to: 3,
      apply: handle => handle.exec('CREATE TABLE migration_3_fixture(id INTEGER) STRICT')
    }, {
      from: 3,
      to: 4,
      apply: handle => {
        handle.exec('CREATE TABLE migration_4_fixture(id INTEGER) STRICT');
        throw Error('fixture-sensitive');
      }
    }]
  });
  code(result, 'migration-failed');
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='migration_3_fixture'").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='migration_4_fixture'").get()?.n, 0);
  const backup = new DatabaseSync(destination, {
    readOnly: true
  });
  t.after(() => backup.close());
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(backup.prepare('SELECT count(*) AS n FROM host').get()?.n, 1);
  assert.equal(JSON.parse(readFileSync(destination + '.manifest.json', 'utf8')).schemaVersion, 2);
  const original = readFileSync(destination);
  code(await runMigrations({
    db,
    path: f.path,
    targetVersion: 4,
    backupDestination: destination,
    steps: [{
      from: 3,
      to: 4,
      apply: handle => handle.exec('CREATE TABLE migration_4_fixture(id INTEGER) STRICT')
    }]
  }), 'constraint');
  assert.deepEqual(readFileSync(destination), original);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
});
test('migration failed first step remains v1 and successful chain activates each version atomically', async t => {
  const f = await fixture(t);
  f.repo.close();
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  code(await runMigrations({
    db,
    path: f.path,
    targetVersion: 3,
    backupDestination: join(f.dir, 'first-backup.db'),
    steps: [{
      from: 2,
      to: 3,
      apply: handle => handle.exec('CREATE TABLE transient_fixture(id INTEGER); INSERT INTO nonexistent VALUES(1)')
    }]
  }), 'migration-failed');
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='transient_fixture'").get()?.n, 0);
  // Nothing committed, so the store is unchanged and this attempt's backup is removed (no pile-up per launch).
  assert.equal(existsSync(join(f.dir, 'first-backup.db')), false);
  assert.equal(existsSync(join(f.dir, 'first-backup.db.manifest.json')), false);
  const result = value(await runMigrations({
    db,
    path: f.path,
    targetVersion: 4,
    backupDestination: join(f.dir, 'success-backup.db'),
    steps: [{
      from: 2,
      to: 3,
      apply: handle => handle.exec('CREATE TABLE v2_fixture(id INTEGER) STRICT')
    }, {
      from: 3,
      to: 4,
      apply: handle => handle.exec('CREATE TABLE v3_fixture(id INTEGER) STRICT')
    }]
  }));
  assert.equal(result.schemaVersion, 4);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
});

test('deleting a host preserves normalized shared trust, identity and tags; SQL rejects duplicate endpoint trust', async t => {
  const f = await fixture(t);
  const h=randomUUID(),i=randomUUID(),tag=randomUUID();
  f.commit([host(h),{type:'create-identity',id:i,data:{label:'shared',username:'alice',method:'keyboard-interactive'}},{type:'create-tag',id:tag,data:{label:'keep'}},{type:'set-host-tag',hostId:h,tagId:tag,present:true,expectedHostRevision:1}]);
  const s=f.snapshot();const trust=randomUUID();const writer=new DatabaseSync(f.path);
  try {
    const insert=writer.prepare('INSERT INTO known_host VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const publicBytes=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32);
    const wire=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),publicBytes]);
    const identity=decodeHostPublicKey(wire)!;
    const fields=[s.vault.id,1,s.vault.createdAt,s.vault.createdAt,'example.com',22,identity.algorithm,identity.publicKey,identity.fingerprint,s.vault.createdAt,s.vault.createdAt] as const;
    insert.run(trust,...fields);
    assert.throws(()=>insert.run(randomUUID(),...fields));
  }finally{writer.close();}
  const after=f.commit([{type:'delete-host',id:h,expectedRevision:1},{type:'set-host-tag',hostId:h,tagId:tag,present:false,expectedHostRevision:1}]);
  assert.equal(after.hosts.length,0);assert.equal(after.knownHosts[0]?.id,trust);assert.equal(after.identities[0]?.id,i);assert.equal(after.tags[0]?.id,tag);
  f.repo.close();const reopened=value(await openMetadata({path:f.path}));reopened.close();
  raw(f.path,"UPDATE known_host SET endpointHost='EXAMPLE.COM.'");const bytes=readFileSync(f.path);code(await openMetadata({path:f.path}),'corrupt');assert.deepEqual(readFileSync(f.path),bytes);
});

test('explicit tag removal keeps owner and increments its revision once',async t=>{
  const f=await fixture(t);const h=randomUUID(),tag=randomUUID();
  f.commit([host(h),{type:'create-tag',id:tag,data:{label:'remove'}},{type:'set-host-tag',hostId:h,tagId:tag,present:true,expectedHostRevision:1}]);
  const after=f.commit([{type:'delete-tag',id:tag,expectedRevision:1},{type:'set-host-tag',hostId:h,tagId:tag,present:false,expectedHostRevision:1}]);
  assert.equal(after.hosts[0]?.revision,2);assert.equal(after.tags.length,0);assert.equal(after.hostTags.length,0);
});

test('source permission gate preserves valid permissive storage and blocks creation in a public directory', async t => {
  const f = await fixture(t);
  f.commit([host()]);
  f.repo.close();
  const bytes = readFileSync(f.path);
  chmodSync(f.path, 0o644);
  code(await openMetadata({path: f.path}), 'unwritable');
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(statSync(f.path).mode & 0o777, 0o644);
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);

  // Correcting the owned fixture is explicit test setup, never adapter behavior.
  chmodSync(f.path, 0o600);
  chmodSync(f.dir, 0o755);
  code(await openMetadata({path: f.path}), 'unwritable');
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.dir).mode & 0o777, 0o755);
  const fresh = join(f.dir, 'new.db');
  code(await openMetadata({path: fresh}), 'unwritable');
  assert.equal(existsSync(fresh), false);
  assert.equal(statSync(f.dir).mode & 0o777, 0o755);
});

test('foreign and corrupt permissive originals keep their earlier diagnosis and unchanged permissions', async t => {
  for (const [kind, expected] of [['foreign', 'foreign-database'], ['corrupt', 'corrupt']] as const) {
    const dir = mkdtempSync('/private/tmp/ssterm-storage-permission-');
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const path = join(dir, 'metadata.db');
    if (kind === 'foreign') raw(path, 'CREATE TABLE foreign_fixture(value TEXT)');
    else writeFileSync(path, 'fixture-sensitive invalid SQLite file');
    chmodSync(path, 0o644);
    chmodSync(dir, 0o755);
    const bytes = readFileSync(path);
    code(await openMetadata({path}), expected);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mode & 0o777, 0o644);
    assert.equal(statSync(dir).mode & 0o777, 0o755);
  }
});

test('settings writes keep the catalog revision, so an outstanding catalog preview still applies', async t => {
  const f = await fixture(t);
  f.commit([host()]);
  const catalog = new CatalogModule({ repository: f.repo });
  const preview = value(catalog.prepare({ type: 'create-group', data: { label: 'After settings' } }));
  const before = f.snapshot();
  const after = f.commit([{ type: 'update-settings', expectedRevision: before.settings.revision, data: { terminalFontSize: 20 } }]);
  assert.equal(after.catalogRevision, before.catalogRevision);
  assert.equal(after.settings.revision, before.settings.revision + 1);
  assert.equal(after.settings.terminalFontSize, 20);
  value(catalog.apply(preview.token));
  assert.equal(f.snapshot().catalogRevision, before.catalogRevision + 1);
  const mixed = f.commit([host(), { type: 'update-settings', expectedRevision: after.settings.revision, data: { terminalFontSize: 21 } }]);
  assert.equal(mixed.catalogRevision, before.catalogRevision + 2, 'a batch with catalog edits still bumps');
});

test('a real v1 store (protected vault, encrypted snippet, local rule) upgrades to v2 after a backup and keeps every byte of protected content', async t => {
  const { PROTECTION_FORMAT, ENVELOPE_VERSION } = await import('../../packages/adapters/src/protection.ts');
  const { readdirSync } = await import('node:fs');
  const f = await fixture(t);
  const h = randomUUID();
  const rule = randomUUID();
  f.commit([host(h), { type: 'create-tunnel-rule', id: rule, data: { label: 'db', hostId: h, bindPort: 15432, destinationHost: 'db.internal', destinationPort: 5432 } }]);
  const s = f.snapshot();
  f.repo.close();
  // Make it what a v1 build leaves behind: protected vault, one encrypted snippet, the v1 tunnel_rule table.
  const db = new DatabaseSync(f.path);
  const ref = randomUUID();
  const snippet = randomUUID();
  const envelope = Buffer.from(Array.from({ length: 64 }, (_v, i) => (i ? (i * 37) & 0xff : ENVELOPE_VERSION)));
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  const operation = randomUUID();
  db.prepare('INSERT INTO secret_operation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(operation, s.vault.id, 'create', 'complete', ref, 'content-key', null, 'vault', s.vault.id, null, s.vault.createdAt, s.vault.createdAt);
  db.prepare('INSERT INTO secret_ref VALUES(?,?,?,?,?,?,?)').run(ref, s.vault.id, 1, s.vault.createdAt, s.vault.createdAt, 'content-key', operation);
  db.prepare('UPDATE local_vault SET contentKeyRef=?,protectionFormat=?').run(ref, PROTECTION_FORMAT);
  db.prepare('INSERT INTO snippet (id,vaultId,revision,createdAt,updatedAt,label,bodyEnvelope,envelopeVersion,keyRef,protectionFormat) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(snippet, s.vault.id, 1, s.vault.createdAt, s.vault.createdAt, 'deploy', envelope, ENVELOPE_VERSION, ref, PROTECTION_FORMAT);
  db.exec('COMMIT');
  downgradeToSchemaV1(db);
  assert.throws(() => db.prepare("UPDATE tunnel_rule SET type='remote'").run(), /CHECK/u, 'the v1 table refuses remote rules');
  db.close();

  const repo = value(await openMetadata({ path: f.path }));
  t.after(() => repo.close());
  const after = value(repo.snapshot());
  assert.deepEqual(after.tunnelRules.map((row) => [row.id, row.type, row.bindPort, row.destinationHost]), [[rule, 'local', 15432, 'db.internal']]);
  assert.deepEqual(Buffer.from(after.snippets[0]!.bodyEnvelope), envelope, 'encrypted snippet bytes untouched');
  assert.equal(after.vault.contentKeyRef, ref);
  const backups = readdirSync(f.dir).filter((name) => /^metadata\.db\.v1-.*\.backup$/u.test(name));
  assert.equal(backups.length, 1, 'a backup of the v1 store is kept next to it');
  const check = new DatabaseSync(join(f.dir, backups[0]!), { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 1);
  check.close();
  // v2 accepts the new rule types.
  value(repo.commit({ expectedCatalogRevision: after.catalogRevision, changes: [
    { type: 'create-tunnel-rule', id: randomUUID(), data: { label: 'socks', hostId: h, type: 'dynamic', bindPort: 1080 } },
    { type: 'create-tunnel-rule', id: randomUUID(), data: { label: 'public', hostId: h, type: 'remote', bindAddress: '0.0.0.0', bindPort: 0, destinationHost: '127.0.0.1', destinationPort: 3000 } },
  ] }));
  code(repo.commit({ expectedCatalogRevision: value(repo.snapshot()).catalogRevision, changes: [
    { type: 'create-tunnel-rule', id: randomUUID(), data: { label: 'bad', hostId: h, bindAddress: '0.0.0.0', bindPort: 8080, destinationHost: 'x', destinationPort: 1 } },
  ] }), 'constraint');
  repo.close();
  const reopened = value(await openMetadata({ path: f.path }));
  assert.equal(value(reopened.snapshot()).tunnelRules.length, 3, 'reopens as v2 without another migration');
  reopened.close();
  assert.equal(readdirSync(f.dir).filter((name) => name.endsWith('.backup')).length, 1);
});

test('a v1 store whose credential journal awaits runtime reconciliation still upgrades (the step never touches the journal)', async t => {
  const { readdirSync } = await import('node:fs');
  const f = await fixture(t);
  const s = f.snapshot();
  f.repo.close();
  const db = new DatabaseSync(f.path);
  // e.g. a Keychain denial left this operation waiting for input; v1 opened it and reconciled at runtime.
  db.prepare('INSERT INTO secret_operation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), s.vault.id, 'create', 'needs-input', randomUUID(), 'password', null, 'identity', randomUUID(), null, s.vault.createdAt, s.vault.createdAt);
  downgradeToSchemaV1(db);
  const v1Sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='tunnel_rule'").get()?.sql as string;
  assert.match(v1Sql, /CHECK\(type='local'\)/u);
  assert.match(v1Sql, /length\(id\)=36/u, 'the shipped id checks are kept');
  db.close();
  const repo = value(await openMetadata({ path: f.path }));
  t.after(() => repo.close());
  const after = value(repo.snapshot());
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.secretOperations.map((op) => op.state), ['needs-input'], 'the journal is carried over for reconciliation');
  assert.equal(readdirSync(f.dir).filter((name) => /\.v1-.*\.backup$/u.test(name)).length, 1);
});
