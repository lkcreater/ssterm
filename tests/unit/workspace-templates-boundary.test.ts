import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { openMetadata, seal, open, ENVELOPE_VERSION, PROTECTION_FORMAT } from '../../packages/adapters/src/index.ts';
import type { MetadataChange, StoreResult } from '../../packages/domain/src/index.ts';
import {
  channels, failure, isWorkspaceTemplateConfiguration, isSaveWorkspaceTemplateRequest, isWorkspaceTemplatesResponse,
  isWorkspaceTemplateView, isDeleteWorkspaceTemplateRequest, copyWorkspaceTemplateConfiguration,
  type WorkspaceTemplateConfiguration, type WorkspaceTemplateNode, type WorkspaceTemplateView,
} from '../../packages/contracts/src/index.ts';
import { registerWorkspaceTemplateHandlers, workspaceTemplateChannels } from '../../apps/desktop/src/main/workspace-templates.ts';
import { WindowBoundary } from '../../apps/desktop/src/main/boundary.ts';
import { createDesktopBridge } from '../../apps/desktop/src/preload/bridge.ts';
import { downgradeToSchemaV3 } from '../fixtures/storage/schema-v1.ts';

const owner = { windowId: 1, generation: 1 };
const hostId = '00000000-0000-4000-8000-000000000001';
const pane = (slotId = 'slot-1'): WorkspaceTemplateNode => ({ kind: 'pane', slotId, hostId });
const configuration = (): WorkspaceTemplateConfiguration => ({ version: 1, tabs: [{ root: pane(), activeSlot: 'slot-1', mode: 'split' }], activeTab: 0, snippetId: null });
const saveRequest = () => ({ owner, templateId: null, expectedRevision: null, label: 'งาน ไทย', configuration: configuration() });
function value<T>(r: StoreResult<T>): T { if (!r.ok) assert.fail(JSON.stringify(r.error)); return r.value; }
async function fixture(t: TestContext) {
  const dir = mkdtempSync('/private/tmp/ssterm-template-');
  const path = join(dir, 'catalog.sqlite');
  let repository = value(await openMetadata({ path }));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const commit = (changes: MetadataChange[]) => repository.commit({ expectedCatalogRevision: value(repository.snapshot()).catalogRevision, changes });
  value(commit([{ type: 'create-host', id: hostId, data: { label: 'Owned test', address: 'host.example' } }]));
  return { dir, path, commit, get repository() { return repository; }, async reopen() { repository.close(); repository = value(await openMetadata({ path })); return repository; } };
}

test('template configuration rejects extra authority, malformed active state, duplicates and all layout bounds', () => {
  assert.ok(isWorkspaceTemplateConfiguration(configuration()));
  const two = configuration();
  two.tabs[0]!.root = { kind: 'split', direction: 'row', ratio: 0.2, first: pane('a'), second: pane('b') };
  two.tabs[0]!.activeSlot = 'b'; two.tabs[0]!.mode = 'focus';
  assert.ok(isWorkspaceTemplateConfiguration(two));
  const invalid: unknown[] = [null, [], { ...configuration(), version: 2 }, { ...configuration(), command: 'secret' },
    { ...configuration(), activeTab: -1 }, { ...configuration(), activeTab: 1 }, { ...configuration(), activeTab: 0.5 },
    { ...configuration(), snippetId: 'not-id' }, { ...configuration(), tabs: [] }, { ...configuration(), tabs: Array(1) },
    { ...configuration(), tabs: [{ ...configuration().tabs[0], activeSlot: 'missing' }] },
    { ...configuration(), tabs: [{ ...configuration().tabs[0], mode: 'invalid' }] },
    { ...configuration(), tabs: [{ root: { ...pane(), sessionId: 'old' }, activeSlot: 'slot-1', mode: 'split' }] },
    { ...configuration(), tabs: [configuration().tabs[0], configuration().tabs[0]] },
  ];
  for (const ratio of [0.19, 0.81, NaN, Infinity]) {
    const bad = structuredClone(two); (bad.tabs[0]!.root as Extract<WorkspaceTemplateNode, { kind: 'split' }>).ratio = ratio; invalid.push(bad);
  }
  for (const slotId of ['', 'x'.repeat(65), 'slot with spaces']) {
    const bad = configuration(); bad.tabs[0]!.root = pane(slotId); bad.tabs[0]!.activeSlot = slotId; invalid.push(bad);
  }
  const eight = configuration(); eight.tabs = Array.from({ length: 8 }, (_, i) => ({ root: pane(`p${i}`), activeSlot: `p${i}`, mode: 'split' }));
  assert.ok(isWorkspaceTemplateConfiguration(eight));
  invalid.push({ ...eight, tabs: [...eight.tabs, { root: pane('p8'), activeSlot: 'p8', mode: 'split' }] });
  const split = (first: WorkspaceTemplateNode, second: WorkspaceTemplateNode): WorkspaceTemplateNode => ({ kind: 'split', direction: 'column', ratio: 0.8, first, second });
  const four = configuration(); four.tabs[0]!.root = split(pane('slot-1'), split(pane('a'), split(pane('b'), pane('c'))));
  assert.ok(isWorkspaceTemplateConfiguration(four), 'three split levels and four leaves');
  invalid.push({ ...four, tabs: [{ ...four.tabs[0], root: split(pane('extra'), four.tabs[0]!.root) }] });
  const five = configuration(); five.tabs[0]!.root = split(split(pane('slot-1'), pane('a')), split(pane('b'), split(pane('c'), pane('d')))); invalid.push(five);
  const ninePanes = structuredClone(eight); ninePanes.tabs[0]!.root = split(pane('p0'), pane('extra')); invalid.push(ninePanes);
  const cyclic: Record<string, unknown> = { kind: 'split', direction: 'row', ratio: 0.5, second: pane('x') }; cyclic.first = cyclic;
  invalid.push({ ...configuration(), tabs: [{ root: cyclic, activeSlot: 'x', mode: 'split' }] });
  for (const bad of invalid) assert.equal(isWorkspaceTemplateConfiguration(bad), false);
  const copied = copyWorkspaceTemplateConfiguration(two);
  assert.deepEqual(copied, two); assert.notEqual(copied.tabs[0]!.root, two.tabs[0]!.root);
});

test('template request/view guards fence revisions, bound labels and refuse private/unknown fields', () => {
  assert.ok(isSaveWorkspaceTemplateRequest(saveRequest()));
  const id = randomUUID();
  assert.ok(isSaveWorkspaceTemplateRequest({ ...saveRequest(), templateId: id, expectedRevision: 1 }));
  for (const override of [{ templateId: id }, { expectedRevision: 1 }, { templateId: id, expectedRevision: 0 }, { label: '' }, { label: 'x'.repeat(201) },
    { label: '\u0000' }, { body: 'secret' }, { owner: { ...owner, extra: 1 } }, { configuration: { ...configuration(), terminalBytes: [] } }])
    assert.equal(isSaveWorkspaceTemplateRequest({ ...saveRequest(), ...override }), false);
  const view = { id, revision: 1, label: 'ไทย', configuration: configuration() };
  assert.ok(isWorkspaceTemplateView(view));
  assert.ok(isWorkspaceTemplatesResponse({ templates: [view] }));
  assert.equal(isWorkspaceTemplateView({ ...view, vaultId: randomUUID() }), false);
  assert.equal(isWorkspaceTemplatesResponse({ templates: [view, view] }), false);
  assert.equal(isDeleteWorkspaceTemplateRequest({ owner, templateId: id, expectedRevision: 1, force: true }), false);
});

test('template storage persists layout metadata, refuses stale rows, missing refs, secrets and cap overflow; later deleted hosts stay explicit', async t => {
  const f = await fixture(t); const id = randomUUID();
  const create = (id: string, config = configuration()): Extract<MetadataChange, { type: 'create-workspace-template' }> => ({ type: 'create-workspace-template', id, data: { label: 'งาน ไทย', configuration: config } });
  let snapshot = value(f.commit([create(id)]));
  assert.equal(snapshot.workspaceTemplates[0]!.revision, 1);
  assert.deepEqual(snapshot.workspaceTemplates[0]!.configuration, configuration());
  const stored = new DatabaseSync(f.path, { readOnly: true });
  assert.deepEqual(stored.prepare('SELECT configuration FROM workspace_template WHERE id=?').get(id)?.configuration, JSON.stringify(configuration()));
  assert.deepEqual(stored.prepare('PRAGMA table_info(workspace_template)').all().map(row => row.name), ['id', 'vaultId', 'revision', 'createdAt', 'updatedAt', 'label', 'configuration']);
  stored.close();
  const changed = configuration(); changed.tabs[0]!.mode = 'focus';
  snapshot = value(f.commit([{ type: 'update-workspace-template', id, expectedRevision: 1, data: { configuration: changed } }]));
  assert.equal(snapshot.workspaceTemplates[0]!.revision, 2);
  assert.equal(f.commit([{ type: 'delete-workspace-template', id, expectedRevision: 1 }]).ok, false);
  for (const config of [{ ...configuration(), snippetId: randomUUID() }, { ...configuration(), tabs: [{ root: { kind: 'pane', slotId: 'slot-1', hostId: randomUUID() }, activeSlot: 'slot-1', mode: 'split' }] }])
    assert.equal(f.commit([create(randomUUID(), config as WorkspaceTemplateConfiguration)]).ok, false);
  assert.equal(f.commit([{ ...create(randomUUID()), data: { label: 'bad', configuration: configuration(), body: 'DO NOT STORE' } } as MetadataChange]).ok, false);
  const reopened = await f.reopen();
  assert.deepEqual(value(reopened.snapshot()).workspaceTemplates[0]!.configuration, changed);
  // Deletion is allowed: saved references are reported missing at restore rather than silently replaced.
  value(f.commit([{ type: 'delete-host', id: hostId, expectedRevision: 1 }]));
  await f.reopen();
  assert.equal(value(f.repository.snapshot()).workspaceTemplates[0]!.configuration.tabs[0]!.root.kind, 'pane');
  assert.equal(f.commit([{ type: 'update-workspace-template', id, expectedRevision: 2, data: { label: 'resave missing ref' } }]).ok, false);
  value(f.commit([{ type: 'delete-workspace-template', id, expectedRevision: 2 }]));
  assert.equal(value(f.repository.snapshot()).workspaceTemplates.length, 0);
  // Use a fresh host ID: deleted entity IDs cannot be reused.
  const replacement = randomUUID(); value(f.commit([{ type: 'create-host', id: replacement, data: { label: 'New', address: 'new.example' } }]));
  const config = configuration(); (config.tabs[0]!.root as Extract<WorkspaceTemplateNode, { kind: 'pane' }>).hostId = replacement;
  value(f.commit(Array.from({ length: 64 }, () => create(randomUUID(), config))));
  const before = value(f.repository.snapshot());
  assert.equal(f.commit([create(randomUUID(), config)]).ok, false);
  assert.equal(value(f.repository.snapshot()).catalogRevision, before.catalogRevision);
  assert.equal(value(f.repository.snapshot()).workspaceTemplates.length, 64);
});

test('template IPC checks owner/frame/app lock before validation/repository access and projects durable CRUD', async t => {
  const f = await fixture(t);
  const mainFrame = { url: 'http://127.0.0.1:5174/' };
  const sender = { id: 7, mainFrame, isDestroyed: () => false };
  const boundary = new WindowBoundary(mainFrame.url, { name: 'ssterm', version: '0', platform: 'darwin' }, () => ({ status: 'ready', schemaVersion: 4 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, 'handle' | 'removeHandler'>;
  let reads = 0; let available = true;
  const unregister = registerWorkspaceTemplateHandlers({ ipc, boundary, repository: () => { reads++; return available ? f.repository : undefined; } });
  t.after(() => { unregister(); boundary.dispose(); assert.equal(handlers.size, 0); });
  const event = { sender, senderFrame: mainFrame };
  const invoke = (channel: string, request: unknown, from: unknown = event, ...extra: unknown[]) => handlers.get(channel)!(from as IpcMainInvokeEvent, request, ...extra);
  assert.deepEqual([...handlers.keys()], [...workspaceTemplateChannels]);
  const id = randomUUID();
  const requests = [{ owner }, saveRequest(), { owner, templateId: id, expectedRevision: 1 }];
  for (const [index, channel] of workspaceTemplateChannels.entries()) {
    const request = requests[index]; const before = reads;
    for (const from of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { ...mainFrame } }, { sender, senderFrame: null }])
      assert.deepEqual(invoke(channel, request, from), failure('unauthorized'));
    assert.deepEqual(invoke(channel, { ...request, owner: { ...owner, generation: 9 } }), failure('stale-owner'));
    boundary.setAccessGate(() => false);
    assert.deepEqual(invoke(channel, { ...request, invalid: true }), failure('unauthorized'));
    boundary.setAccessGate(() => true);
    assert.deepEqual(invoke(channel, { ...request, extra: true }), failure('invalid-request'));
    assert.deepEqual(invoke(channel, request, event, request), failure('invalid-request'));
    assert.equal(reads, before);
  }
  assert.deepEqual(invoke(channels.workspaceTemplates, { owner }), { ok: true, value: { templates: [] } });
  const created = invoke(channels.saveWorkspaceTemplate, saveRequest()) as { ok: true; value: WorkspaceTemplateView };
  assert.equal(created.ok, true); assert.deepEqual(Object.keys(created.value).sort(), ['configuration', 'id', 'label', 'revision']);
  const templateId = created.value.id;
  const updated = invoke(channels.saveWorkspaceTemplate, { ...saveRequest(), templateId, expectedRevision: 1, label: 'Updated' }) as typeof created;
  assert.equal(updated.value.revision, 2);
  assert.deepEqual(invoke(channels.saveWorkspaceTemplate, { ...saveRequest(), templateId, expectedRevision: 1 }), failure('conflict'));
  await f.reopen();
  assert.deepEqual(invoke(channels.workspaceTemplates, { owner }), { ok: true, value: { templates: [updated.value] } });
  assert.deepEqual(invoke(channels.deleteWorkspaceTemplate, { owner, templateId, expectedRevision: 2 }), { ok: true, value: { deleted: true } });
  available = false; assert.deepEqual(invoke(channels.workspaceTemplates, { owner }), failure('unavailable'));
});

test('template bridge deep-projects requests and refuses malformed/secret-bearing responses', async () => {
  const calls: { channel: string; args: unknown[] }[] = []; let reply: unknown;
  const { api, dispose } = createDesktopBridge({ async invoke(channel, ...args) { calls.push({ channel, args }); return reply; }, on() {}, removeListener() {} });
  const request = saveRequest();
  reply = { ok: true, value: { id: randomUUID(), revision: 1, label: request.label, configuration: configuration() } };
  assert.equal((await api.saveWorkspaceTemplate(request)).ok, true);
  assert.deepEqual(calls[0], { channel: channels.saveWorkspaceTemplate, args: [request] });
  const sent = calls[0]!.args[0] as typeof request;
  assert.notEqual(sent.owner, request.owner); assert.notEqual(sent.configuration.tabs[0]!.root, request.configuration.tabs[0]!.root);
  reply = { ok: true, value: { templates: [{ ...(reply as { value: object }).value, body: 'leaked' }] } };
  assert.deepEqual(await api.workspaceTemplates({ owner }), failure('unavailable'));
  reply = { ok: true, value: { deleted: true, secret: 'leaked' } };
  assert.deepEqual(await api.deleteWorkspaceTemplate({ owner, templateId: randomUUID(), expectedRevision: 1 }), failure('unavailable'));
  const count = calls.length;
  assert.deepEqual(await api.saveWorkspaceTemplate({ ...request, configuration: { ...configuration(), sessionId: 'old' } } as typeof request), failure('invalid-request'));
  assert.equal(calls.length, count); dispose();
});

test('real schema 3 upgrade backs up before adding templates and preserves encrypted content plus pending journal byte-for-byte', async t => {
  const f = await fixture(t); const initial = value(f.repository.snapshot()); f.repository.close();
  const db = new DatabaseSync(f.path); const ref = randomUUID(), snippetId = randomUUID(), op = randomUUID();
  const key = randomBytes(32); const binding = { vaultId: initial.vault.id, snippetId, field: 'body' as const };
  const envelope = seal(key, binding, Buffer.from('owned encrypted snippet'));
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  const timestamp = initial.vault.createdAt;
  db.prepare('INSERT INTO secret_operation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(op, initial.vault.id, 'create', 'complete', ref, 'content-key', null, 'vault', initial.vault.id, null, timestamp, timestamp);
  db.prepare('INSERT INTO secret_ref VALUES(?,?,?,?,?,?,?)').run(ref, initial.vault.id, 1, timestamp, timestamp, 'content-key', op);
  db.prepare('UPDATE local_vault SET contentKeyRef=?,protectionFormat=?').run(ref, PROTECTION_FORMAT);
  db.prepare('INSERT INTO snippet VALUES(?,?,?,?,?,?,?,?,?,?)').run(snippetId, initial.vault.id, 1, timestamp, timestamp, 'Protected', envelope, ENVELOPE_VERSION, ref, PROTECTION_FORMAT);
  db.prepare('INSERT INTO secret_operation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), initial.vault.id, 'create', 'needs-input', randomUUID(), 'password', null, 'identity', randomUUID(), null, timestamp, timestamp);
  db.exec('COMMIT'); downgradeToSchemaV3(db);
  const journal = db.prepare('SELECT * FROM secret_operation ORDER BY operationId').all().map(row => ({ ...row }));
  const refs = db.prepare('SELECT * FROM secret_ref').all().map(row => ({ ...row })); db.close();
  const repository = await f.reopen(); const after = value(repository.snapshot());
  assert.equal(after.schemaVersion, 4); assert.deepEqual(after.workspaceTemplates, []);
  assert.equal(after.catalogRevision, initial.catalogRevision);
  assert.deepEqual(after.secretOperations, journal); assert.deepEqual(after.secretRefs, refs);
  assert.deepEqual(after.snippets[0]!.bodyEnvelope, envelope);
  const decrypted = open(key, binding, after.snippets[0]!); assert.equal(decrypted.toString(), 'owned encrypted snippet'); decrypted.fill(0); key.fill(0);
  const backup = readdirSync(f.dir).filter(name => /\.v3-.+\.backup$/u.test(name)); assert.equal(backup.length, 1);
  const backupPath = join(f.dir, backup[0]!); const preserved = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(preserved.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.equal(preserved.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workspace_template'").get()?.n, 0);
  assert.deepEqual(preserved.prepare('SELECT * FROM secret_operation ORDER BY operationId').all().map(row => ({ ...row })), journal); preserved.close();
  const manifest = JSON.parse(readFileSync(backupPath + '.manifest.json', 'utf8'));
  assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(backupPath)).digest('hex'));
  const config = { ...configuration(), snippetId };
  value(f.commit([{ type: 'create-workspace-template', id: randomUUID(), data: { label: 'Migrated', configuration: config } }]));
  await f.reopen(); assert.equal(value(f.repository.snapshot()).workspaceTemplates.length, 1);
  assert.equal(readdirSync(f.dir).filter(name => name.endsWith('.backup')).length, 1);
  value(f.commit([{ type: 'delete-snippet', id: snippetId, expectedRevision: 1 }]));
  await f.reopen();
  assert.equal(value(f.repository.snapshot()).workspaceTemplates[0]!.configuration.snippetId, snippetId, 'deleting a snippet preserves the explicit missing reference');
});
