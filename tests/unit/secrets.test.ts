import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMetadata, seal, open, ProtectionFault, PROTECTION_FORMAT } from '../../packages/adapters/src/index.ts';
import { KeychainSecretProvider, clearTestNamespace, classifyProviderError, readOutcome, writeOutcome, deleteOutcome } from '../../packages/adapters/src/keychain.ts';
import { SecretService, TransientSecrets } from '../../packages/services/src/index.ts';
import type { MetadataRepository, SecretItem, SecretProvider, StoreResult } from '../../packages/domain/src/index.ts';
import { MemorySecretProvider, SimulatedCrash } from '../fixtures/secrets/memory-provider.ts';
const FIXTURE_PASSWORD = 'fixture-password-ทดสอบ-7d1c';
const FIXTURE_REPLACEMENT = 'fixture-replacement-ลับ-41ab';
const FIXTURE_BODY = 'fixture-body-สวัสดี-run-9f3e';
const bytes = (text: string) => new TextEncoder().encode(text);
function value<T>(result: StoreResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
async function store(t: TestContext, provider = new MemorySecretProvider()) {
  const dir = mkdtempSync('/private/tmp/ssterm-secrets-test-');
  const path = join(dir, 'catalog.sqlite');
  const transient = new TransientSecrets();
  const state = {
    dir,
    path,
    provider,
    transient,
    repo: value(await openMetadata({ path })) as MetadataRepository,
    service: undefined as unknown as SecretService,
    restart: async () => {}
  };
  state.service = new SecretService({ repository: state.repo, provider, transient });
  // Simulates an app restart: same database file and OS store, fresh process state.
  state.restart = async () => {
    state.repo.close();
    state.repo = value(await openMetadata({ path }));
    state.service = new SecretService({ repository: state.repo, provider, transient });
  };
  t.after(() => {
    transient.purgeAll();
    state.repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return state;
}
const snapshot = (repo: MetadataRepository) => value(repo.snapshot());
async function savedIdentity(s: Awaited<ReturnType<typeof store>>) {
  const identityId = randomUUID();
  const result = await s.service.storeSecret({
    kind: 'password',
    owner: { type: 'identity', id: identityId, expectedRevision: null },
    value: bytes(FIXTURE_PASSWORD),
    publish: ref => [{ type: 'create-identity', id: identityId, data: { label: 'Lab', username: 'alice', method: 'password', passwordRef: ref } }]
  });
  assert.equal(result.status, 'published');
  return { identityId, ref: (result as { ref: string }).ref };
}
// ---- Provider contract: the same behavior from the fixture and the real macOS Keychain ----
const contract = (name: string, make: (namespace: string) => SecretProvider, clear: (namespace: string) => Promise<number>, skip = false) => test(`provider contract: ${name}`, { skip }, async t => {
  const namespaces = [`dev.ssterm.test.${randomUUID()}`, `dev.ssterm.test.${randomUUID()}`];
  t.after(async () => {
    for (const namespace of namespaces) assert.equal(await clear(namespace), 0);
  });
  const provider = make(namespaces[0]!);
  const other = make(namespaces[1]!);
  const item: SecretItem = { vaultId: randomUUID(), kind: 'password', ref: randomUUID() };
  const binary = Buffer.concat([Buffer.from([0, 255, 0, 128]), Buffer.from(FIXTURE_PASSWORD)]);
  assert.deepEqual(await provider.read(item), { status: 'missing' });
  assert.deepEqual(await provider.lookup(item), { status: 'missing' });
  assert.deepEqual(await provider.delete(item), { status: 'missing' });
  assert.deepEqual(await provider.write(item, binary), { status: 'confirmed' });
  const read = await provider.read(item);
  assert.equal(read.status, 'present');
  assert.deepEqual(Buffer.from((read as { value: Uint8Array }).value), binary);
  const found = await provider.lookup(item);
  assert.deepEqual(found, { status: 'present' });
  assert.ok(!JSON.stringify(found).includes('fixture'));
  // Kind and vault are part of the stable identity; namespaces are isolated.
  assert.deepEqual(await provider.lookup({ ...item, kind: 'passphrase' }), { status: 'missing' });
  assert.deepEqual(await provider.lookup({ ...item, vaultId: randomUUID() }), { status: 'missing' });
  assert.deepEqual(await other.lookup(item), { status: 'missing' });
  const large = randomBytes(64 * 1024);
  const bigItem = { ...item, kind: 'private-key' as const };
  assert.deepEqual(await provider.write(bigItem, large), { status: 'confirmed' });
  assert.deepEqual(Buffer.from((await provider.read(bigItem) as { value: Uint8Array }).value), large);
  assert.deepEqual(await provider.delete(bigItem), { status: 'confirmed' });
  for (const invalid of [{ ...item, ref: '../x' }, { ...item, vaultId: '' }, { ...item, kind: 'token' }] as SecretItem[]) {
    assert.deepEqual(await provider.read(invalid), { status: 'error', code: 'invalid' });
    assert.deepEqual(await provider.write(invalid, binary), { status: 'error', code: 'invalid' });
  }
  assert.deepEqual(await provider.delete(item), { status: 'confirmed' });
  assert.deepEqual(await provider.read(item), { status: 'missing' });
});
const memoryStores = new Map<string, MemorySecretProvider>();
contract('in-memory fault-injection fixture', namespace => {
  const provider = new MemorySecretProvider();
  memoryStores.set(namespace, provider);
  return provider;
}, async namespace => {
  const provider = memoryStores.get(namespace)!;
  provider.items.clear();
  return provider.items.size;
});
contract('macOS Keychain test namespace', namespace => new KeychainSecretProvider(namespace), clearTestNamespace, process.platform !== 'darwin');
test('Keychain provider accepts only the production or a dev.ssterm.test.<uuid> namespace', async () => {
  for (const namespace of ['dev.ssterm.desktop', 'com.termius', 'dev.ssterm.test.probe', `dev.ssterm.test.${randomUUID()}.x`]) assert.throws(() => new KeychainSecretProvider(namespace));
  await assert.rejects(clearTestNamespace('dev.ssterm.desktop.secrets'));
});
test('recorded keyring-core error shapes map to typed outcomes without fabricating locked, denied or missing', () => {
  const recorded = (message: string) => Object.assign(new Error(message), { code: 'GenericFailure' });
  const cases: [Error | unknown, string, string, string][] = [
    [recorded("Couldn't access platform storage: User interaction is not allowed."), 'unavailable', 'unknown', 'unknown'],
    [recorded('Platform failure: The user name or passphrase you entered is not correct.'), 'unavailable', 'unknown', 'unknown'],
    [recorded('Platform failure: User canceled the operation.'), 'unavailable', 'unknown', 'unknown'],
    [recorded('Entry is matched by 2 credentials: [...]'), 'error', 'unknown', 'unknown'],
    [recorded("Value of 'user' is invalid: cannot be empty"), 'error', 'error', 'error'],
    [recorded('No matching credential found'), 'missing', 'unknown', 'missing'],
    [recorded('Secret data is malformed: x'), 'error', 'unknown', 'unknown'],
    [recorded('anything else'), 'unavailable', 'unknown', 'unknown'],
    ['not an error', 'unavailable', 'unknown', 'unknown']
  ];
  for (const [error, read, write, remove] of cases) {
    const kind = classifyProviderError(error);
    const outcomes = [readOutcome(kind), writeOutcome(kind), deleteOutcome(kind)];
    assert.deepEqual(outcomes.map(o => o.status), [read, write, remove]);
    for (const outcome of outcomes) {
      assert.ok(!['locked', 'denied'].includes(outcome.status));
      assert.ok(!/platform|keychain|passphrase|interaction/iu.test(JSON.stringify(outcome)));
    }
  }
});
// ---- Authenticated protection ----
test('aes-256-gcm-v1 envelopes round-trip and bind vault, snippet and field; tampering and unknown formats reject with bytes unchanged', () => {
  const key = randomBytes(32);
  const binding = { vaultId: randomUUID(), snippetId: randomUUID(), field: 'body' as const };
  const envelope = (plain: Uint8Array) => ({ bodyEnvelope: seal(key, binding, plain), envelopeVersion: 1, protectionFormat: PROTECTION_FORMAT });
  for (const text of ['', FIXTURE_BODY, 'ไทย ✓ 🚀 \u0000 end']) assert.equal(open(key, binding, envelope(bytes(text))).toString('utf8'), text);
  const sealed = envelope(bytes(FIXTURE_BODY));
  assert.equal(sealed.bodyEnvelope[0], 1);
  assert.equal(sealed.bodyEnvelope.length, 1 + 12 + bytes(FIXTURE_BODY).length + 16);
  assert.ok(!Buffer.from(sealed.bodyEnvelope).includes(Buffer.from(FIXTURE_BODY)));
  assert.notDeepEqual(envelope(bytes(FIXTURE_BODY)).bodyEnvelope.subarray(1, 13), sealed.bodyEnvelope.subarray(1, 13));
  const original = Buffer.from(sealed.bodyEnvelope);
  const rejects = (candidate: typeof sealed, k: Uint8Array = key, b: typeof binding = binding, code = 'corrupt') => {
    const before = Buffer.from(candidate.bodyEnvelope);
    assert.throws(() => open(k, b, candidate), (error: unknown) => error instanceof ProtectionFault && error.code === code && !String(error.message).includes('fixture'));
    assert.deepEqual(Buffer.from(candidate.bodyEnvelope), before);
  };
  const last = original.length - 1;
  for (const index of [0, 1, 12, 13, 20, last - 15, last]) {
    const tampered = Buffer.from(original);
    tampered[index]! ^= 0x01;
    rejects({ ...sealed, bodyEnvelope: tampered });
  }
  rejects({ ...sealed, bodyEnvelope: original.subarray(0, last) });
  rejects({ ...sealed, bodyEnvelope: original.subarray(0, 28) });
  rejects(sealed, randomBytes(32));
  rejects(sealed, key, { ...binding, vaultId: randomUUID() });
  rejects(sealed, key, { ...binding, snippetId: randomUUID() });
  rejects(sealed, key, { ...binding, field: 'label' as 'body' });
  rejects({ ...sealed, envelopeVersion: 2 }, key, binding, 'unsupported');
  rejects({ ...sealed, protectionFormat: 'aes-256-gcm-v2' }, key, binding, 'unsupported');
  assert.throws(() => seal(randomBytes(16), binding, bytes('x')), ProtectionFault);
  assert.deepEqual(Buffer.from(sealed.bodyEnvelope), original);
});
// ---- Journal walkthroughs (domain-storage-spec) ----
test('saved credential publishes with a new owner in one batch; repository refuses unjournaled or orphaned descriptors', async t => {
  const s = await store(t);
  const { identityId, ref } = await savedIdentity(s);
  const after = snapshot(s.repo);
  assert.equal(after.identities[0]?.passwordRef, ref);
  assert.deepEqual(after.secretRefs.map(r => [r.id, r.kind]), [[ref, 'password']]);
  assert.deepEqual(after.secretOperations.map(op => op.state), ['complete']);
  assert.equal(s.provider.items.size, 1);
  // Detaching a credential without journaling its cleanup would orphan the descriptor.
  const orphan = s.repo.commit({ expectedCatalogRevision: after.catalogRevision, changes: [{ type: 'update-identity', id: identityId, expectedRevision: 1, data: { passwordRef: null } }] });
  assert.equal(!orphan.ok && orphan.error.code, 'constraint');
  // A second credential operation for the same owner slot cannot start while one is unresolved.
  s.provider.inject({ op: 'write', status: 'unknown' }, { op: 'lookup', status: 'unknown' });
  const pending = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) });
  assert.deepEqual([pending.status, (pending as { reason?: string }).reason], ['pending', 'unknown']);
  const second = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) });
  assert.deepEqual(second, { status: 'failed', code: 'constraint' });
  const backup = await s.repo.backup({ destination: join(s.dir, 'blocked.sqlite') });
  assert.equal(!backup.ok && backup.error.code, 'recovery-required');
});
test('key credentials compose with KeyMetadata/Identity creation; restricted deletion and both refs clean up; vanished drafts cancel', async t => {
  const s = await store(t);
  const keyId = randomUUID();
  const identityId = randomUUID();
  const key = { label: 'Lab key', algorithm: 'ssh-ed25519', publicKey: 'ssh-ed25519 AAAAfixturepublic', fingerprint: 'SHA256:fixture' };
  const privateKey = await s.service.storeSecret({
    kind: 'private-key',
    owner: { type: 'key', id: keyId, expectedRevision: null },
    value: bytes('fixture-private-key'),
    publish: ref => [{ type: 'create-key', id: keyId, data: { ...key, privateKeyRef: ref } }, { type: 'create-identity', id: identityId, data: { label: 'Key login', username: 'deploy', method: 'key', keyId } }]
  });
  assert.equal(privateKey.status, 'published');
  const passphrase = await s.service.storeSecret({ kind: 'passphrase', owner: { type: 'key', id: keyId, expectedRevision: 1 }, value: bytes(FIXTURE_PASSWORD) });
  assert.equal(passphrase.status, 'published');
  let current = snapshot(s.repo);
  const row = current.keys[0]!;
  assert.deepEqual([row.privateKeyRef, row.passphraseRef, row.revision], [(privateKey as { ref: string }).ref, (passphrase as { ref: string }).ref, 2]);
  const swap = s.repo.commit({ expectedCatalogRevision: current.catalogRevision, changes: [{ type: 'update-key', id: keyId, expectedRevision: 2, data: { privateKeyRef: (passphrase as { ref: string }).ref } }] });
  assert.equal(!swap.ok && swap.error.code, 'constraint');
  const restricted = await s.service.removeSecrets([{ type: 'delete-key', id: keyId, expectedRevision: 2 }], [row.privateKeyRef, row.passphraseRef!]);
  assert.deepEqual(restricted, { status: 'failed', code: 'constraint' });
  assert.equal(s.provider.items.size, 2);
  const removed = await s.service.removeSecrets([{ type: 'delete-identity', id: identityId, expectedRevision: 1 }, { type: 'delete-key', id: keyId, expectedRevision: 2 }], [row.privateKeyRef, row.passphraseRef!]);
  assert.deepEqual(removed, { status: 'committed', cleanup: [{ status: 'cleaned' }, { status: 'cleaned' }] });
  current = snapshot(s.repo);
  assert.deepEqual([current.keys.length, current.secretRefs.length, s.provider.items.size], [0, 0, 0]);
  // A new-owner draft lost in a crash cannot be reconstructed: the written item is cleaned, nothing publishes.
  s.provider.inject({ op: 'write', apply: true, crash: true });
  await assert.rejects(s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: randomUUID(), expectedRevision: null }, value: bytes(FIXTURE_REPLACEMENT), publish: () => [] }), SimulatedCrash);
  await s.restart();
  assert.deepEqual(await s.service.reconcile(), { published: 0, cleaned: 0, cancelled: 1, needsInput: 0, pending: 0 });
  assert.deepEqual([snapshot(s.repo).identities.length, snapshot(s.repo).secretRefs.length, s.provider.items.size], [0, 0, 0]);
});
test('crash after OS write before publish: restart lookup publishes the same ref, swaps and cleans the old one without a duplicate create', async t => {
  const s = await store(t);
  const { identityId, ref: oldRef } = await savedIdentity(s);
  s.provider.inject({ op: 'write', apply: true, crash: true });
  await assert.rejects(s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef, value: bytes(FIXTURE_REPLACEMENT) }), SimulatedCrash);
  await s.restart();
  const staged = snapshot(s.repo).secretOperations.find(op => op.state === 'staged')!;
  assert.equal(snapshot(s.repo).identities[0]?.passwordRef, oldRef);
  const writes = s.provider.count('write');
  // Publication also performs the journaled old-ref cleanup.
  assert.deepEqual(await s.service.reconcile(), { published: 1, cleaned: 0, cancelled: 0, needsInput: 0, pending: 0 });
  assert.equal(s.provider.count('write'), writes);
  const after = snapshot(s.repo);
  assert.equal(after.identities[0]?.passwordRef, staged.intendedRef);
  assert.equal(after.identities[0]?.revision, 2);
  assert.deepEqual(after.secretRefs.map(r => r.id), [staged.intendedRef]);
  assert.ok(after.secretOperations.every(op => op.state === 'complete'));
  assert.equal(s.provider.items.size, 1);
  assert.equal(Buffer.from((await s.provider.read({ vaultId: after.vault.id, kind: 'password', ref: staged.intendedRef }) as { value: Uint8Array }).value).toString(), FIXTURE_REPLACEMENT);
  assert.ok((await s.repo.backup({ destination: join(s.dir, 'ok.sqlite') })).ok);
});
test('owner revision changed before publish: the confirmed unused item is cleaned up and the old ref stays valid', async t => {
  const s = await store(t);
  const { identityId, ref: oldRef } = await savedIdentity(s);
  s.provider.inject({ op: 'write', apply: true, crash: true });
  await assert.rejects(s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef, value: bytes(FIXTURE_REPLACEMENT) }), SimulatedCrash);
  await s.restart();
  value(s.repo.commit({ expectedCatalogRevision: snapshot(s.repo).catalogRevision, changes: [{ type: 'update-identity', id: identityId, expectedRevision: 1, data: { label: 'Renamed' } }] }));
  assert.deepEqual(await s.service.reconcile(), { published: 0, cleaned: 0, cancelled: 1, needsInput: 0, pending: 0 });
  const after = snapshot(s.repo);
  assert.equal(after.identities[0]?.passwordRef, oldRef);
  assert.deepEqual(after.secretRefs.map(r => r.id), [oldRef]);
  assert.equal(s.provider.items.size, 1);
  assert.ok(after.secretOperations.every(op => op.state === 'complete'));
});
test('unknown write then confirmed missing becomes needs-input; re-entry resumes the same operation and ref', async t => {
  const s = await store(t);
  const { identityId, ref: oldRef } = await savedIdentity(s);
  s.provider.inject({ op: 'write', status: 'unknown' }, { op: 'lookup', status: 'unknown' });
  const pending = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef, value: bytes(FIXTURE_REPLACEMENT) });
  assert.equal(pending.status, 'pending');
  const operationId = (pending as { operationId: string }).operationId;
  assert.equal(snapshot(s.repo).secretOperations.find(op => op.operationId === operationId)?.state, 'reconcile');
  await s.restart();
  assert.deepEqual(await s.service.reconcile(), { published: 0, cleaned: 0, cancelled: 0, needsInput: 1, pending: 0 });
  const op = snapshot(s.repo).secretOperations.find(row => row.operationId === operationId)!;
  assert.equal(op.state, 'needs-input');
  assert.equal(snapshot(s.repo).identities[0]?.passwordRef, oldRef);
  assert.deepEqual(await s.service.resume(operationId), { status: 'pending', operationId, reason: 'needs-input' });
  const lookups = s.provider.count('lookup');
  const resumed = await s.service.resume(operationId, bytes(FIXTURE_REPLACEMENT));
  assert.deepEqual(resumed, { status: 'published', operationId, ref: op.intendedRef });
  assert.equal(s.provider.count('lookup'), lookups + 1);
  assert.equal(snapshot(s.repo).identities[0]?.passwordRef, op.intendedRef);
  assert.equal(s.provider.items.size, 1);
});
test('delete commits SQL first; OS denial leaves visible cleanup pending and a later retry completes it', async t => {
  const s = await store(t);
  const { identityId, ref } = await savedIdentity(s);
  s.provider.inject({ op: 'delete', status: 'denied' });
  const removed = await s.service.removeSecrets([{ type: 'delete-identity', id: identityId, expectedRevision: 1 }], [ref]);
  assert.deepEqual(removed, { status: 'committed', cleanup: [{ status: 'pending', reason: 'denied' }] });
  let current = snapshot(s.repo);
  assert.equal(current.identities.length, 0);
  assert.deepEqual(current.secretRefs.map(r => r.id), [ref]);
  assert.equal(current.secretOperations.find(op => op.action === 'delete')?.state, 'cleanup');
  assert.equal(s.provider.items.size, 1);
  const blocked = await s.repo.backup({ destination: join(s.dir, 'blocked.sqlite') });
  assert.equal(!blocked.ok && blocked.error.code, 'recovery-required');
  await s.restart();
  assert.deepEqual(await s.service.reconcile(), { published: 0, cleaned: 1, cancelled: 0, needsInput: 0, pending: 0 });
  current = snapshot(s.repo);
  assert.deepEqual(current.secretRefs, []);
  assert.equal(s.provider.items.size, 0);
  assert.ok((await s.repo.backup({ destination: join(s.dir, 'ok.sqlite') })).ok);
  // A failed SQL transaction leaves provider items untouched.
  const kept = await savedIdentity(s);
  const failed = await s.service.removeSecrets([{ type: 'delete-identity', id: kept.identityId, expectedRevision: 99 }], [kept.ref]);
  assert.deepEqual(failed, { status: 'failed', code: 'conflict' });
  assert.equal(s.provider.items.size, 1);
});
test('content key initializes once; snippets encrypt; a restored backup without the key keeps ciphertext unavailable and never regenerates', async t => {
  const s = await store(t);
  const empty = await s.service.saveSnippet({ id: randomUUID(), label: 'x', body: bytes('x') });
  assert.deepEqual(empty, { status: 'key-unavailable', reason: 'uninitialized' });
  assert.equal((await s.service.initializeContentKey()).status, 'published');
  assert.deepEqual(await s.service.initializeContentKey(), { status: 'ready' });
  assert.equal(s.provider.count('write'), 1);
  const vault = snapshot(s.repo).vault;
  assert.equal(vault.protectionFormat, PROTECTION_FORMAT);
  const snippetId = randomUUID();
  const emptyId = randomUUID();
  assert.equal((await s.service.saveSnippet({ id: snippetId, label: 'Deploy', body: bytes(FIXTURE_BODY) })).status, 'saved');
  assert.equal((await s.service.saveSnippet({ id: emptyId, label: 'Empty', body: new Uint8Array() })).status, 'saved');
  const opened = await s.service.openSnippet(snippetId);
  assert.equal(opened.status, 'open');
  assert.equal((opened as { body: { use: (f: (b: Uint8Array) => string) => string } }).body.use(b => Buffer.from(b).toString()), FIXTURE_BODY);
  const openedEmpty = await s.service.openSnippet(emptyId);
  assert.equal((openedEmpty as { body: { use: (f: (b: Uint8Array) => number) => number } }).body.use(b => b.length), 0);
  const updated = await s.service.saveSnippet({ id: snippetId, label: 'Deploy', body: bytes('v2'), expectedRevision: 1 });
  assert.equal(updated.status, 'saved');
  assert.equal((updated as { snapshot: { snippets: { id: string; revision: number }[] } }).snapshot.snippets.find(r => r.id === snippetId)?.revision, 2);
  const backupPath = join(s.dir, 'backup.sqlite');
  const manifest = value(await s.repo.backup({ destination: backupPath }));
  assert.deepEqual(manifest.protectionFormats, [PROTECTION_FORMAT]);
  // Restore on a machine whose OS store lacks the content key.
  const restoredPath = join(s.dir, 'restored', 'catalog.sqlite');
  mkdirSync(join(s.dir, 'restored'), { mode: 0o700 });
  copyFileSync(backupPath, restoredPath);
  const restoredRepo = value(await openMetadata({ path: restoredPath }));
  t.after(() => restoredRepo.close());
  const emptyStore = new MemorySecretProvider();
  const restored = new SecretService({ repository: restoredRepo, provider: emptyStore, transient: s.transient });
  const before = snapshot(restoredRepo).snippets.find(r => r.id === snippetId)!;
  assert.deepEqual(await restored.openSnippet(snippetId), { status: 'key-unavailable', reason: 'missing' });
  assert.deepEqual(await restored.initializeContentKey(), { status: 'ready' });
  assert.deepEqual(await restored.saveSnippet({ id: snippetId, label: 'Overwrite', body: bytes('x'), expectedRevision: 2 }), { status: 'key-unavailable', reason: 'missing' });
  assert.equal(emptyStore.count('write'), 0);
  assert.equal(emptyStore.items.size, 0);
  const afterRestore = snapshot(restoredRepo).snippets.find(r => r.id === snippetId)!;
  assert.deepEqual(Buffer.from(afterRestore.bodyEnvelope), Buffer.from(before.bodyEnvelope));
  assert.equal(afterRestore.label, 'Deploy');
});
test('tampered stored ciphertext is reported corrupt and overwrite is refused with original bytes kept', async t => {
  const s = await store(t);
  await s.service.initializeContentKey();
  const id = randomUUID();
  await s.service.saveSnippet({ id, label: 'Tamper', body: bytes(FIXTURE_BODY) });
  const writer = new DatabaseSync(s.path);
  writer.prepare('UPDATE snippet SET bodyEnvelope=? WHERE id=?').run((() => {
    const envelope = Buffer.from(snapshot(s.repo).snippets[0]!.bodyEnvelope);
    envelope[20]! ^= 0xff;
    return envelope;
  })(), id);
  writer.close();
  const tampered = Buffer.from(snapshot(s.repo).snippets[0]!.bodyEnvelope);
  assert.deepEqual(await s.service.openSnippet(id), { status: 'corrupt' });
  assert.deepEqual(await s.service.saveSnippet({ id, label: 'Tamper', body: bytes('replacement'), expectedRevision: 1 }), { status: 'corrupt' });
  assert.deepEqual(Buffer.from(snapshot(s.repo).snippets[0]!.bodyEnvelope), tampered);
});
test('snippet tags are written as one revision-fenced set with the body; delete keeps the vault key and removes memberships', async t => {
  const s = await store(t);
  await s.service.initializeContentKey();
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  const before = snapshot(s.repo);
  value(s.repo.commit({ expectedCatalogRevision: before.catalogRevision, changes: [a, b, c].map((id, i) => ({ type: 'create-tag' as const, id, data: { label: `tag-${i}` } })) }));
  const id = randomUUID();
  const multiline = 'set -e\r\nexport ชื่อ="ทดสอบ 🚀"\n\tcd /srv && ls\n\n';
  const created = await s.service.saveSnippet({ id, label: 'Deploy ไทย', body: bytes(multiline), tagIds: [a, b] });
  assert.equal(created.status, 'saved');
  const tagsOf = () => snapshot(s.repo).snippetTags.filter(row => row.snippetId === id).map(row => row.tagId).sort();
  assert.deepEqual(tagsOf(), [a, b].sort());
  assert.equal(snapshot(s.repo).snippets.find(row => row.id === id)?.revision, 1);
  // Replace the set: one tag removed, one added, body changed; one revision step.
  const updated = await s.service.saveSnippet({ id, label: 'Deploy ไทย', body: bytes(`${multiline}echo done`), expectedRevision: 1, tagIds: [b, c] });
  assert.equal(updated.status, 'saved');
  assert.deepEqual(tagsOf(), [b, c].sort());
  assert.equal(snapshot(s.repo).snippets.find(row => row.id === id)?.revision, 2);
  const opened = await s.service.openSnippet(id);
  assert.equal((opened as { body: { use: (f: (b: Uint8Array) => string) => string } }).body.use(b => new TextDecoder('utf-8', { fatal: true }).decode(b)), `${multiline}echo done`);
  // A stale revision changes neither the body nor the tags.
  const envelope = Buffer.from(snapshot(s.repo).snippets[0]!.bodyEnvelope);
  assert.deepEqual(await s.service.saveSnippet({ id, label: 'Stale', body: bytes('x'), expectedRevision: 1, tagIds: [] }), { status: 'failed', code: 'conflict' });
  assert.deepEqual(tagsOf(), [b, c].sort());
  assert.deepEqual(Buffer.from(snapshot(s.repo).snippets[0]!.bodyEnvelope), envelope);
  // An unknown tag refuses the whole save; duplicates are invalid.
  assert.equal((await s.service.saveSnippet({ id, label: 'x', body: bytes('x'), expectedRevision: 2, tagIds: [randomUUID()] })).status, 'failed');
  assert.deepEqual(await s.service.saveSnippet({ id, label: 'x', body: bytes('x'), expectedRevision: 2, tagIds: [b, b] }), { status: 'failed', code: 'invalid' });
  assert.equal(snapshot(s.repo).snippets[0]!.revision, 2);
  // The plaintext never reaches the database or its WAL.
  for (const file of [s.path, `${s.path}-wal`].filter(existsSync)) {
    const raw = readFileSync(file);
    assert.ok(!raw.includes(Buffer.from('ทดสอบ 🚀')) && !raw.includes(Buffer.from('cd /srv')), file);
  }
  // Delete: stale refused, current removes row and memberships, key untouched.
  const keyRef = snapshot(s.repo).vault.contentKeyRef;
  assert.equal((await s.service.deleteSnippet(id, 1)).ok, false);
  assert.equal((await s.service.deleteSnippet(id, 2)).ok, true);
  const after = snapshot(s.repo);
  assert.equal(after.snippets.length, 0);
  assert.equal(after.snippetTags.length, 0);
  assert.equal(after.tags.length, 3);
  assert.equal(after.vault.contentKeyRef, keyRef);
  assert.equal(s.provider.items.size, 1);
});
test('first content-key initialization recovers a crash by lookup and retires an ambiguous missing attempt before one new key', async t => {
  const crashed = await store(t);
  crashed.provider.inject({ op: 'write', apply: true, crash: true });
  await assert.rejects(crashed.service.initializeContentKey(), SimulatedCrash);
  await crashed.restart();
  const staged = snapshot(crashed.repo).secretOperations[0]!;
  assert.deepEqual(await crashed.service.saveSnippet({ id: randomUUID(), label: 'x', body: bytes('x') }), { status: 'key-unavailable', reason: 'uninitialized' });
  const writes = crashed.provider.count('write');
  assert.equal((await crashed.service.initializeContentKey()).status, 'published');
  assert.equal(crashed.provider.count('write'), writes);
  assert.equal(snapshot(crashed.repo).vault.contentKeyRef, staged.intendedRef);
  assert.equal(crashed.provider.items.size, 1);
  const ambiguous = await store(t);
  ambiguous.provider.inject({ op: 'write', status: 'unknown' }, { op: 'lookup', status: 'unknown' });
  const pending = await ambiguous.service.initializeContentKey();
  assert.deepEqual([pending.status, (pending as { reason?: string }).reason], ['pending', 'unknown']);
  assert.equal(snapshot(ambiguous.repo).vault.contentKeyRef, null);
  const result = await ambiguous.service.initializeContentKey();
  assert.equal(result.status, 'published');
  const after = snapshot(ambiguous.repo);
  assert.deepEqual(after.secretOperations.map(op => op.state), ['complete', 'complete']);
  assert.equal(after.vault.contentKeyRef, after.secretOperations.find(op => op.operationId !== (pending as { operationId: string }).operationId)?.intendedRef);
  assert.equal(ambiguous.provider.items.size, 1);
});
test('existing owners accept only a plain ref swap: an extra publish payload is refused before staging or writing', async t => {
  const s = await store(t);
  const { identityId, ref } = await savedIdentity(s);
  const before = snapshot(s.repo);
  const writes = s.provider.count('write');
  const payload = () => [{ type: 'update-identity' as const, id: identityId, expectedRevision: 1, data: { username: 'mallory' } }];
  assert.deepEqual(await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT), publish: payload }), { status: 'failed', code: 'invalid' });
  assert.deepEqual(snapshot(s.repo), before);
  assert.equal(s.provider.count('write'), writes);
  // Resume refuses the same payload for an existing-owner operation.
  s.provider.inject({ op: 'write', status: 'unknown' }, { op: 'lookup', status: 'unknown' });
  const pending = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) });
  assert.deepEqual(await s.service.resume((pending as { operationId: string }).operationId, bytes(FIXTURE_REPLACEMENT), payload), { status: 'failed', code: 'invalid' });
});
test('definite write refusals stay pending without publishing; the next attempt looks up before any create', async t => {
  for (const status of ['denied', 'unavailable'] as const) {
    const s = await store(t);
    const { identityId, ref } = await savedIdentity(s);
    const writes = s.provider.count('write');
    s.provider.inject({ op: 'write', status });
    const result = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) });
    assert.deepEqual([result.status, (result as { reason?: string }).reason], ['pending', status]);
    assert.equal(s.provider.count('write'), writes + 1);
    const current = snapshot(s.repo);
    const op = current.secretOperations.find(row => row.action === 'replace')!;
    assert.equal(op.state, 'reconcile');
    assert.deepEqual(current.secretRefs.map(r => r.id), [ref]);
    assert.equal(current.identities[0]?.passwordRef, ref);
    const lookups = s.provider.count('lookup');
    s.provider.inject({ op: 'lookup', status: 'unavailable' });
    assert.deepEqual(await s.service.resume(op.operationId, bytes(FIXTURE_REPLACEMENT)), { status: 'pending', operationId: op.operationId, reason: 'unavailable' });
    assert.equal(s.provider.count('lookup'), lookups + 1);
    assert.equal(s.provider.count('write'), writes + 1);
  }
});
test('locked lookup and read keep journal, refs and ciphertext; nothing publishes or regenerates', async t => {
  const s = await store(t);
  const { identityId, ref } = await savedIdentity(s);
  s.provider.inject({ op: 'write', apply: true, crash: true });
  await assert.rejects(s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) }), SimulatedCrash);
  await s.restart();
  const writes = s.provider.count('write');
  s.provider.inject({ op: 'lookup', status: 'locked' });
  assert.deepEqual(await s.service.reconcile(), { published: 0, cleaned: 0, cancelled: 0, needsInput: 0, pending: 1 });
  let current = snapshot(s.repo);
  const op = current.secretOperations.find(row => row.action === 'replace')!;
  assert.equal(op.state, 'reconcile');
  assert.equal(current.identities[0]?.passwordRef, ref);
  s.provider.inject({ op: 'lookup', status: 'locked' });
  assert.deepEqual(await s.service.resume(op.operationId, bytes(FIXTURE_REPLACEMENT)), { status: 'pending', operationId: op.operationId, reason: 'locked' });
  assert.equal(s.provider.count('write'), writes);
  assert.equal(snapshot(s.repo).identities[0]?.passwordRef, ref);
  assert.equal((await s.service.resume(op.operationId)).status, 'published');
  assert.equal((await s.service.initializeContentKey()).status, 'published');
  const id = randomUUID();
  await s.service.saveSnippet({ id, label: 'Locked', body: bytes(FIXTURE_BODY) });
  const envelope = Buffer.from(snapshot(s.repo).snippets[0]!.bodyEnvelope);
  const keyWrites = s.provider.count('write');
  s.provider.inject({ op: 'read', status: 'locked' });
  assert.deepEqual(await s.service.openSnippet(id), { status: 'key-unavailable', reason: 'locked' });
  s.provider.inject({ op: 'read', status: 'locked' });
  assert.deepEqual(await s.service.saveSnippet({ id, label: 'Locked', body: bytes('x'), expectedRevision: 1 }), { status: 'key-unavailable', reason: 'locked' });
  assert.deepEqual(await s.service.initializeContentKey(), { status: 'ready' });
  assert.equal(s.provider.count('write'), keyWrites);
  current = snapshot(s.repo);
  assert.deepEqual(Buffer.from(current.snippets[0]!.bodyEnvelope), envelope);
});
test('needs-input: an item found present publishes instead of being deleted; a moved owner cancels so backup is not blocked', async t => {
  const pendingReplacement = async (s: Awaited<ReturnType<typeof store>>) => {
    const { identityId, ref } = await savedIdentity(s);
    s.provider.inject({ op: 'write', status: 'unknown' }, { op: 'lookup', status: 'unknown' });
    const pending = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) });
    await s.restart();
    assert.equal((await s.service.reconcile()).needsInput, 1);
    return { identityId, ref, op: snapshot(s.repo).secretOperations.find(row => row.operationId === (pending as { operationId: string }).operationId)! };
  };
  const present = await store(t);
  const { op } = await pendingReplacement(present);
  // The OS write landed after all (for example another process finished it).
  present.provider.items.set(`${op.vaultId}/password/${op.intendedRef}`, Buffer.from(FIXTURE_REPLACEMENT));
  assert.deepEqual(await present.service.resume(op.operationId), { status: 'published', operationId: op.operationId, ref: op.intendedRef });
  assert.equal(snapshot(present.repo).identities[0]?.passwordRef, op.intendedRef);
  assert.equal(present.provider.items.size, 1);
  const moved = await store(t);
  const replacement = await pendingReplacement(moved);
  value(moved.repo.commit({ expectedCatalogRevision: snapshot(moved.repo).catalogRevision, changes: [{ type: 'update-identity', id: replacement.identityId, expectedRevision: 1, data: { label: 'Moved' } }] }));
  assert.deepEqual(await moved.service.reconcile(), { published: 0, cleaned: 0, cancelled: 1, needsInput: 0, pending: 0 });
  assert.ok(snapshot(moved.repo).secretOperations.every(row => row.state === 'complete'));
  assert.equal(snapshot(moved.repo).identities[0]?.passwordRef, replacement.ref);
  assert.ok((await moved.repo.backup({ destination: join(moved.dir, 'unblocked.sqlite') })).ok);
});
test('a vanished new-owner draft whose item is missing completes without cleanup or publication', async t => {
  const s = await store(t);
  s.provider.inject({ op: 'write', status: 'unknown' }, { op: 'lookup', status: 'unknown' });
  const pending = await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: randomUUID(), expectedRevision: null }, value: bytes(FIXTURE_PASSWORD), publish: () => [] });
  assert.equal(pending.status, 'pending');
  await s.restart();
  const deletes = s.provider.count('delete');
  assert.deepEqual(await s.service.reconcile(), { published: 0, cleaned: 0, cancelled: 1, needsInput: 0, pending: 0 });
  const current = snapshot(s.repo);
  assert.deepEqual([current.identities.length, current.secretRefs.length, s.provider.items.size, s.provider.count('delete') - deletes], [0, 0, 0, 0]);
  assert.ok(current.secretOperations.every(row => row.state === 'complete'));
});
test('cleanup of a still-referenced ref is refused by the repository and by the service before any OS delete', async t => {
  const s = await store(t);
  const { ref } = await savedIdentity(s);
  const before = snapshot(s.repo);
  const queued = s.repo.commit({ expectedCatalogRevision: before.catalogRevision, changes: [{ type: 'queue-secret-cleanup', operationId: randomUUID(), ref }] });
  assert.equal(!queued.ok && queued.error.code, 'constraint');
  assert.deepEqual(snapshot(s.repo), before);
  // Even if a snapshot claimed a pending cleanup for a live ref, the service re-checks before deleting.
  const forged = structuredClone(before);
  forged.secretOperations.push({ ...forged.secretOperations[0]!, operationId: randomUUID(), action: 'delete', state: 'cleanup', expectedRevision: null });
  const repository: MetadataRepository = { ...s.repo, snapshot: () => ({ ok: true, value: forged }), commit: () => assert.fail('no commit expected'), backup: s.repo.backup, close: () => undefined };
  const service = new SecretService({ repository, provider: s.provider, transient: s.transient });
  const deletes = s.provider.count('delete');
  assert.deepEqual(await service.reconcile(), { published: 0, cleaned: 0, cancelled: 0, needsInput: 0, pending: 1 });
  assert.equal(s.provider.count('delete'), deletes);
  assert.equal(s.provider.items.size, 1);
});
test('fixture secrets never reach SQLite/WAL bytes, backups, console output or returned results', async t => {
  const s = await store(t);
  const output: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const write = process.stderr.write.bind(process.stderr);
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) console[name] = (...args: unknown[]) => output.push(args.map(String).join(' '));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const results: unknown[] = [];
  try {
    const { identityId, ref } = await savedIdentity(s);
    results.push(await s.service.initializeContentKey());
    const snippetId = randomUUID();
    results.push(await s.service.saveSnippet({ id: snippetId, label: 'Run', body: bytes(FIXTURE_BODY) }));
    s.provider.inject({ op: 'write', status: 'denied' });
    results.push(await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: identityId, expectedRevision: 1 }, oldRef: ref, value: bytes(FIXTURE_REPLACEMENT) }));
    results.push(await s.service.cancel((results.at(-1) as { operationId: string }).operationId));
    results.push(await s.service.storeSecret({ kind: 'password', owner: { type: 'identity', id: randomUUID(), expectedRevision: 7 }, value: bytes(FIXTURE_REPLACEMENT) }));
    results.push(await s.repo.backup({ destination: join(s.dir, 'redaction.sqlite') }));
  } finally {
    Object.assign(console, originals);
    process.stderr.write = write;
  }
  const contentKey = [...s.provider.items.entries()].find(([account]) => account.includes('/content-key/'))![1];
  const haystacks = [readFileSync(s.path), existsSync(`${s.path}-wal`) ? readFileSync(`${s.path}-wal`) : Buffer.alloc(0), readFileSync(join(s.dir, 'redaction.sqlite')), readFileSync(join(s.dir, 'redaction.sqlite.manifest.json')), Buffer.from(output.join('\n')), Buffer.from(JSON.stringify(results))];
  assert.ok(haystacks[1]!.length > 0, 'WAL content is inspected');
  for (const haystack of haystacks) for (const needle of [FIXTURE_PASSWORD, FIXTURE_REPLACEMENT, FIXTURE_BODY].map(v => Buffer.from(v)).concat(Buffer.from(contentKey))) assert.equal(haystack.indexOf(needle), -1);
});
test('transient holder copies, expires, overwrites on dispose and purges every live value', async () => {
  const registry = new TransientSecrets();
  const source = bytes(FIXTURE_PASSWORD);
  const held = registry.hold(source, 50);
  source.fill(0);
  assert.equal(held.use(b => Buffer.from(b).toString()), FIXTURE_PASSWORD);
  let view: Uint8Array | undefined;
  const other = registry.hold(bytes(FIXTURE_BODY));
  other.use(b => {
    view = b;
  });
  assert.equal(registry.size, 2);
  other.dispose();
  assert.ok(view!.every(byte => byte === 0));
  assert.throws(() => other.use(b => b));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(held.disposed, true);
  assert.equal(registry.size, 0);
  registry.hold(bytes('a'));
  registry.hold(bytes('b'));
  assert.equal(registry.purgeAll(), 2);
  assert.equal(registry.size, 0);
  for (const ttl of [0, -1, 1.5, 5 * 60_000 + 1]) assert.throws(() => registry.hold(bytes('x'), ttl));
});
