import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  channels, failure, isTerminalStateRequest, isStartRemoteEditRequest, isRemoteEditRequest, isUploadRemoteEditRequest,
  isRemoteEditState, REMOTE_EDIT_CAPABILITIES,
  type Owner, type Result, type RemoteEditState, type StartRemoteEditRequest, type StartRemoteEditResponse,
  type RemoteEditRequest, type UploadRemoteEditRequest, type TerminalActionResponse,
} from '@ssterm/contracts';
import { createRemoteEditService, type SessionRegistry } from '@ssterm/services';
import { filePath } from '@ssterm/adapters/local-files';
import type { WindowBoundary } from './boundary';
import { sessionOwnerId } from './session-runtime';
import { project } from './terminals';

type Registry = Pick<SessionRegistry, 'snapshot' | 'subscribe' | 'sftp' | 'close' | 'locked'>;
type Service = ReturnType<typeof createRemoteEditService>;
interface Registration { owner: Owner; sequence: number; send(channel: string, state: RemoteEditState): void; unsubscribe(): void }
const accepted: Result<TerminalActionResponse> = { ok: true, value: { accepted: true } };
/** The renderer chooses only a captured Ready SFTP file. All bytes and local paths remain main-only. */
export function createRemoteEditController(options: { registry: Registry; service: Service; onLock?(listener: () => void): () => void }) {
  const { registry, service } = options;
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const current = (owner: Owner) => disposed ? undefined : registrations.get(sessionOwnerId(owner));
  const state = (row: Registration): RemoteEditState => ({ owner: { ...row.owner }, sequence: row.sequence,
    edits: service.snapshot(sessionOwnerId(row.owner)), capabilities: { ...REMOTE_EDIT_CAPABILITIES } });
  const stopLock = options.onLock?.(() => { void service.lock(); });
  const run = async (request: RemoteEditRequest, action: (owner: string) => ReturnType<Service['check']>, cleanup = false): Promise<Result<TerminalActionResponse>> => {
    if (!isRemoteEditRequest(request)) return failure('invalid-request');
    if (!current(request.owner)) return failure('stale-owner');
    const ownerId = sessionOwnerId(request.owner);
    const edit = service.snapshot(ownerId).find((item) => item.id === request.editId);
    if (!edit || (!cleanup && (registry.locked || !registry.sftp(ownerId, edit.sessionId, edit.generation)))) return failure('conflict');
    const result = await action(ownerId);
    return result.ok ? accepted : failure(result.code === 'resource-limit' ? 'busy' : 'conflict');
  };
  return {
    register(owner: Owner, send: Registration['send']): void {
      if (disposed) return;
      const old = current(owner);
      if (old) { old.send = send; return; }
      const ownerId = sessionOwnerId(owner);
      const row: Registration = { owner: { ...owner }, sequence: 0, send, unsubscribe: () => {} };
      registrations.set(ownerId, row);
      const stopService = service.subscribe(ownerId, () => {
        if (current(owner) !== row) return;
        row.sequence++;
        const value = state(row);
        if (isRemoteEditState(value)) { try { row.send(channels.remoteEditStateChanged, value); } catch { /* Owner is closing. */ } }
      });
      const stopRegistry = registry.subscribe(ownerId, (snapshot) => {
        if (registry.locked) { void service.lock(); return; }
        if (snapshot.kind === 'sftp' && snapshot.state !== 'Ready') void service.closeSession(ownerId, snapshot.id, snapshot.generation);
      });
      row.unsubscribe = () => { stopService(); stopRegistry(); };
    },
    remoteEditState(owner: Owner): Result<RemoteEditState> {
      const row = current(owner);
      if (!row) return failure('stale-owner');
      const value = state(row);
      return isRemoteEditState(value) ? { ok: true, value } : failure('unavailable');
    },
    async startRemoteEdit(request: StartRemoteEditRequest): Promise<Result<StartRemoteEditResponse>> {
      if (!isStartRemoteEditRequest(request) || !filePath(request.path)) return failure('invalid-request');
      if (!current(request.owner)) return failure('stale-owner');
      if (registry.locked) return failure('unavailable');
      const ownerId = sessionOwnerId(request.owner);
      const { sessionId, generation } = request.source;
      const remote = registry.sftp(ownerId, sessionId, generation);
      const snapshot = registry.snapshot(ownerId, sessionId).find((item) => item.id === sessionId && item.generation === generation && item.kind === 'sftp' && item.state === 'Ready');
      if (!remote || !snapshot) return failure('conflict');
      const target = project(snapshot).target;
      if (!target) return failure('conflict');
      const result = service.start({ owner: ownerId, sessionId, generation, target, path: request.path, remote,
        validate: () => !!current(request.owner) && !registry.locked && registry.sftp(ownerId, sessionId, generation) === remote,
        onStall: () => { registry.close(ownerId, sessionId, generation); } });
      return result.ok ? { ok: true, value: { editId: result.value.editId } } : failure(result.code === 'resource-limit' ? 'busy' : result.code === 'invalid-request' || result.code === 'invalid-path' ? 'invalid-request' : result.code === 'unsupported' ? 'unavailable' : 'conflict');
    },
    openRemoteEditor(request: RemoteEditRequest) { return run(request, (id) => service.openEditor(id, request.editId, request.revision)); },
    checkRemoteEdit(request: RemoteEditRequest) { return run(request, (id) => service.check(id, request.editId, request.revision)); },
    uploadRemoteEdit(request: UploadRemoteEditRequest) {
      if (!isUploadRemoteEditRequest(request)) return Promise.resolve(failure('invalid-request'));
      return run({ owner: request.owner, editId: request.editId, revision: request.revision }, (id) => service.upload(id, request.editId, request.revision, request.approvalId));
    },
    discardRemoteEdit(request: RemoteEditRequest) { return run(request, (id) => service.discard(id, request.editId, request.revision), true); },
    pendingCount(owner?: Owner): number { return service.pendingCount(owner ? sessionOwnerId(owner) : undefined); },
    revokeOwner(owner: Owner): void {
      const row = current(owner);
      if (!row) return;
      registrations.delete(sessionOwnerId(owner)); row.unsubscribe();
      void service.closeOwner(sessionOwnerId(owner));
    },
    dispose() {
      if (disposed) return;
      disposed = true; stopLock?.();
      for (const row of registrations.values()) row.unsubscribe();
      registrations.clear();
      return service.dispose();
    },
  };
}
export type RemoteEditController = ReturnType<typeof createRemoteEditController>;
export const remoteEditChannels = Object.freeze([channels.remoteEditState, channels.startRemoteEdit, channels.openRemoteEditor, channels.checkRemoteEdit, channels.uploadRemoteEdit, channels.discardRemoteEdit]);
export function registerRemoteEditHandlers(options: { ipc: Pick<IpcMain, 'handle' | 'removeHandler'>; boundary: WindowBoundary; controller(): RemoteEditController | undefined }) {
  const handle = <T>(channel: string, validate: (v: unknown) => v is T, run: (controller: RemoteEditController, request: T) => unknown) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === 'object' && 'owner' in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure('invalid-request');
        const controller = options.controller();
        if (!controller) return failure('unavailable');
        controller.register(authorized.value, (channel, value) => { if (!event.sender.isDestroyed()) event.sender.send(channel, value); });
        return await run(controller, request);
      } catch { return failure('unavailable'); }
    });
  };
  handle(channels.remoteEditState, isTerminalStateRequest, (c, r) => c.remoteEditState(r.owner));
  handle(channels.startRemoteEdit, isStartRemoteEditRequest, (c, r) => c.startRemoteEdit(r));
  handle(channels.openRemoteEditor, isRemoteEditRequest, (c, r) => c.openRemoteEditor(r));
  handle(channels.checkRemoteEdit, isRemoteEditRequest, (c, r) => c.checkRemoteEdit(r));
  handle(channels.uploadRemoteEdit, isUploadRemoteEditRequest, (c, r) => c.uploadRemoteEdit(r));
  handle(channels.discardRemoteEdit, isRemoteEditRequest, (c, r) => c.discardRemoteEdit(r));
  return () => { for (const channel of remoteEditChannels) options.ipc.removeHandler(channel); };
}

export function withRemoteEditPrompt(prompt: { message: string; detail: string } | undefined, count: number, action: 'close' | 'quit') {
  if (count === 0) return prompt;
  const detail = `${count} remote ${count === 1 ? 'edit' : 'edits'} will be discarded. ssterm will attempt cleanup of private working files; any marked leftovers are retried at next start. A publication already in progress may finish; check the remote file. Your editor may retain its own copies.`;
  return { message: prompt?.message ?? (action === 'quit' ? 'Quit with remote edits?' : 'Close with remote edits?'), detail: prompt ? `${prompt.detail}\n\n${detail}` : detail };
}
