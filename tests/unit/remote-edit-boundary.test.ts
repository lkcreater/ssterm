import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IpcMain } from 'electron';
import { createRemoteEditController, registerRemoteEditHandlers, remoteEditChannels, withRemoteEditPrompt } from '../../apps/desktop/src/main/remote-edit.ts';
import { WindowBoundary } from '../../apps/desktop/src/main/boundary.ts';
import { channels, failure, isRemoteEditState, isRemoteEditRequest, isStartRemoteEditRequest, isUploadRemoteEditRequest, REMOTE_EDIT_CAPABILITIES, type RemoteEditView } from '../../packages/contracts/src/index.ts';
import type { RemoteEditInput } from '../../packages/services/src/remote-edit.ts';

const owner = { windowId: 1, generation: 1 };
const source = { kind: 'remote' as const, sessionId: 'session', generation: 1 };
const start = { owner, source, path: '/ไฟล์.txt' };
const target = { label: 'Lab', environment: 'PROD' as const, endpointHost: 'localhost', endpointPort: 22, username: 'fixture' };
const view: RemoteEditView = { id: 'edit', revision: 1, sessionId: 'session', generation: 1, target, remotePath: '/ไฟล์.txt', state: 'ready', localChanged: false, localAvailable: true, size: 4, approvalId: null, error: null, partialPath: null, cleanupPending: false };
function fixture() {
  let locked = false, live = true, kind = 'sftp', targetPresent = true;
  let provider = {};
  let input: RemoteEditInput | undefined;
  let registryCallback: (snapshot: any) => void = () => {};
  let serviceCallback: () => void = () => {};
  let lockCallback: () => void = () => {};
  let docs: RemoteEditView[] = [];
  const calls: unknown[][] = [];
  const service = {
    snapshot: () => docs.map((v) => ({ ...v, target: { ...v.target } })),
    subscribe: (_: string, cb: () => void) => { serviceCallback = cb; return () => calls.push(['unsubService']); },
    start(value: RemoteEditInput) { input = value; docs = [{ ...view }]; serviceCallback(); return { ok: true, value: { editId: 'edit' } }; },
    check(...args: unknown[]) { calls.push(['check', ...args]); return args[2] === docs[0]?.revision ? { ok: true, value: undefined } : { ok: false, code: 'invalid-request' }; },
    openEditor(...args: unknown[]) { calls.push(['open', ...args]); return { ok: true, value: undefined }; },
    upload(...args: unknown[]) { calls.push(['upload', ...args]); return { ok: true, value: undefined }; },
    discard(...args: unknown[]) { calls.push(['discard', ...args]); return { ok: true, value: undefined }; },
    closeSession(...args: unknown[]) { calls.push(['closeSession', ...args]); },
    closeOwner(...args: unknown[]) { calls.push(['closeOwner', ...args]); },
    lock() { calls.push(['lock']); },
    pendingCount() { return docs.length + 1; },
    async dispose() { calls.push(['dispose']); },
  } as unknown as Parameters<typeof createRemoteEditController>[0]['service'];
  const registry = {
    get locked() { return locked; },
    snapshot: () => [{ id: 'session', generation: 1, kind, hostId: 'host', state: 'Ready', target: targetPresent ? { label: 'Lab', environment: 'PROD', address: 'localhost', port: 22, username: 'fixture' } : null }],
    sftp: (id: string, session: string, generation: number) => live && id === 'window:1:1' && session === 'session' && generation === 1 ? provider : undefined,
    subscribe: (_: string, cb: typeof registryCallback) => { registryCallback = cb; return () => calls.push(['unsubRegistry']); },
    close(...args: unknown[]) { calls.push(['close', ...args]); },
  } as unknown as Parameters<typeof createRemoteEditController>[0]['registry'];
  const controller = createRemoteEditController({ registry, service, onLock: (cb) => { lockCallback = cb; return () => calls.push(['unsubLock']); } });
  const sent: unknown[] = [];
  controller.register(owner, (_, state) => sent.push(state));
  return { controller, sent, calls, input: () => input!, setKind(v: string) { kind = v; }, setTargetPresent(v: boolean) { targetPresent = v; }, swap() { provider = {}; }, stale() { live = false; }, lock() { locked = true; lockCallback(); },
    closed() { registryCallback({ kind: 'sftp', id: 'session', generation: 1, state: 'Closed' }); } };
}

test('remote edit guards restrict sources, paths, revisions and private fields', () => {
  assert.ok(isStartRemoteEditRequest(start));
  for (const value of [{ ...start, source: { kind: 'local' } }, { ...start, path: 'relative' }, { ...start, path: '/bad\0' }, { ...start, path: '/�' }, { ...start, executable: '/bin/sh' }, { ...start, source: { ...source, generation: 0 } }]) assert.equal(isStartRemoteEditRequest(value), false);
  assert.ok(isRemoteEditRequest({ owner, editId: 'edit', revision: 1 }));
  assert.equal(isRemoteEditRequest({ owner, editId: 'edit', revision: 0 }), false);
  assert.equal(isRemoteEditRequest({ owner, editId: 'edit', revision: 1, path: '/private' }), false);
  assert.ok(isUploadRemoteEditRequest({ owner, editId: 'edit', revision: 2, approvalId: 'nonce' }));
  assert.equal(isUploadRemoteEditRequest({ owner, editId: 'edit', revision: 2, approvalId: '' }), false);
  const state = { owner, sequence: 0, edits: [view], capabilities: REMOTE_EDIT_CAPABILITIES };
  assert.ok(isRemoteEditState(state));
  for (const edits of [[{ ...view, target: null }], [{ ...view, documentPath: '/private' }], [{ ...view, sha256: 'private' }], [{ ...view, error: '/private/file' }], Array(9).fill(view)]) assert.equal(isRemoteEditState({ ...state, edits }), false);
  assert.equal(isRemoteEditState({ ...state, capabilities: { ...state.capabilities, resume: true } }), false);
});

test('remote edit controller captures exact owned Ready SFTP generation and capability identity', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.controller.startRemoteEdit({ ...start, owner: { windowId: 4, generation: 1 } }), failure('stale-owner'));
    assert.deepEqual(await f.controller.startRemoteEdit({ ...start, source: { ...source, generation: 2 } }), failure('conflict'));
    assert.deepEqual(await f.controller.startRemoteEdit({ ...start, path: '/' + 'ก'.repeat(1400) }), failure('invalid-request'));
    f.setKind('terminal'); assert.deepEqual(await f.controller.startRemoteEdit(start), failure('conflict')); f.setKind('sftp');
    f.setTargetPresent(false); assert.deepEqual(await f.controller.startRemoteEdit(start), failure('conflict')); f.setTargetPresent(true);
    assert.deepEqual(await f.controller.startRemoteEdit(start), { ok: true, value: { editId: 'edit' } });
    assert.deepEqual(f.input().target, target);
    assert.equal(f.input().validate(), true);
    assert.ok(f.sent.every(isRemoteEditState));
    assert.ok(!JSON.stringify(f.controller.remoteEditState(owner)).includes('validate'));
    f.swap(); assert.equal(f.input().validate(), false);
    f.input().onStall(); assert.deepEqual(f.calls.at(-1), ['close', 'window:1:1', 'session', 1]);
  } finally { await f.controller.dispose(); }
});

test('remote edit stale revisions, close, lock, ownership and cleanup stay fenced', async () => {
  const f = fixture();
  const request = { owner, editId: 'edit', revision: 1 };
  await f.controller.startRemoteEdit(start);
  assert.deepEqual(await f.controller.checkRemoteEdit({ ...request, revision: 9 }), failure('conflict'));
  assert.deepEqual(await f.controller.openRemoteEditor({ ...request, owner: { windowId: 2, generation: 1 } }), failure('stale-owner'));
  f.closed(); assert.deepEqual(f.calls.at(-1), ['closeSession', 'window:1:1', 'session', 1]);
  f.lock(); assert.equal(f.input().validate(), false); assert.deepEqual(f.calls.at(-1), ['lock']);
  assert.deepEqual(await f.controller.checkRemoteEdit(request), failure('conflict'));
  assert.equal(f.controller.pendingCount(owner), 2, 'includes idle workspaces and native cleanup');
  f.stale(); assert.ok((await f.controller.discardRemoteEdit(request)).ok, 'owned local cleanup remains available after disconnect');
  f.controller.revokeOwner(owner); assert.deepEqual(f.calls.at(-1), ['closeOwner', 'window:1:1']);
  assert.deepEqual(f.controller.remoteEditState(owner), failure('stale-owner'));
  await f.controller.dispose(); assert.deepEqual(f.calls.at(-1), ['dispose']);
});

test('remote edit IPC checks app lock, sender, frame, owner and exact arity before service access', async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc = { handle: (name: string, cb: (...args: any[]) => unknown) => handlers.set(name, cb), removeHandler: (name: string) => handlers.delete(name) } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
  const frame = { url: 'file:///app/index.html' };
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false, send() {} };
  const event = { sender, senderFrame: frame };
  const boundary = new WindowBoundary(frame.url, { name: 'ssterm', version: '1', platform: 'darwin' }, () => ({ status: 'ready', schemaVersion: 4 }));
  boundary.register(sender, 1, true, () => {});
  let reads = 0;
  const remove = registerRemoteEditHandlers({ ipc, boundary, controller: () => { reads++; return undefined; } });
  const invoke = (ev: unknown, ...args: unknown[]) => handlers.get(channels.remoteEditState)!(ev, ...args);
  for (const ev of [{ ...event, sender: { ...sender } }, { ...event, senderFrame: { ...frame } }, { ...event, senderFrame: null }]) assert.deepEqual(await invoke(ev, { owner }), failure('unauthorized'));
  boundary.setAccessGate(() => false);
  for (const channel of remoteEditChannels) assert.deepEqual(await handlers.get(channel)!(event, { owner, malformed: true }), failure('unauthorized'));
  assert.equal(reads, 0);
  boundary.setAccessGate(() => true);
  assert.deepEqual(await invoke(event, { owner }, 'extra'), failure('invalid-request'));
  assert.deepEqual(await invoke(event, { owner: { ...owner, generation: 9 } }), failure('stale-owner'));
  assert.equal(reads, 0);
  assert.deepEqual(await invoke(event, { owner }), failure('unavailable'));
  assert.equal(reads, 1);
  remove(); assert.equal(handlers.size, 0); boundary.dispose();
});

test('remote edit exit prompt includes idle edits, publication uncertainty and editor copies', () => {
  assert.equal(withRemoteEditPrompt(undefined, 0, 'close'), undefined);
  assert.match(withRemoteEditPrompt(undefined, 1, 'quit')!.detail, /1 remote edit.*attempt cleanup.*next start.*publication.*editor/s);
  assert.match(withRemoteEditPrompt({ message: 'Close?', detail: 'Disconnect.' }, 2, 'close')!.detail, /Disconnect\.\n\n2 remote edits/);
});
