import { MAX_REMOTE_EDIT_BYTES, MAX_REMOTE_EDITS, REMOTE_EDIT_STATES, type RemoteEditView } from '@ssterm/domain/remote-edit';
import { exactObject, isCounter, isOwner, type Owner } from './index.ts';
import { isFilePath, isFilePathRequest, type FileSource } from './files.ts';
import { isTerminalSession } from './terminals.ts';

export type { RemoteEditView, RemoteEditStatus, RemoteEditFailure } from '@ssterm/domain/remote-edit';
export const REMOTE_EDIT_CAPABILITIES = Object.freeze({ editor: 'textedit' as const, maxBytes: MAX_REMOTE_EDIT_BYTES, resume: false as const, remoteToRemote: false as const });
export interface RemoteEditState { owner: Owner; sequence: number; edits: RemoteEditView[]; capabilities: typeof REMOTE_EDIT_CAPABILITIES }
export interface StartRemoteEditRequest { owner: Owner; source: Extract<FileSource, { kind: 'remote' }>; path: string }
export interface RemoteEditRequest { owner: Owner; editId: string; revision: number }
export interface UploadRemoteEditRequest extends RemoteEditRequest { approvalId: string }
export interface StartRemoteEditResponse { editId: string }
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
const errors: readonly unknown[] = ['not-found', 'not-file', 'permission-denied', 'no-space', 'quota-exceeded', 'failure', 'invalid-path', 'unsupported', 'connection-lost', 'resource-limit', 'cancelled', 'closed', 'invalid-request', 'too-large', 'invalid-text', 'local-changed', 'remote-changed', 'editor-unavailable', 'cleanup-failed', 'timeout', 'publication-unknown'];
export function isStartRemoteEditRequest(v: unknown): v is StartRemoteEditRequest {
  return isFilePathRequest(v) && v.source.kind === 'remote' && !v.path.includes('\uFFFD');
}
export function isRemoteEditRequest(v: unknown): v is RemoteEditRequest {
  return exactObject(v, ['owner', 'editId', 'revision']) && isOwner(v.owner) && identifier(v.editId) && isCounter(v.revision) && v.revision > 0;
}
export function isUploadRemoteEditRequest(v: unknown): v is UploadRemoteEditRequest {
  return exactObject(v, ['owner', 'editId', 'revision', 'approvalId']) && isOwner(v.owner) && identifier(v.editId) && isCounter(v.revision) && v.revision > 0 && identifier(v.approvalId);
}
export function isStartRemoteEditResponse(v: unknown): v is StartRemoteEditResponse {
  return exactObject(v, ['editId']) && identifier(v.editId);
}
export function isRemoteEditView(v: unknown): v is RemoteEditView {
  return exactObject(v, ['id', 'revision', 'sessionId', 'generation', 'target', 'remotePath', 'state', 'localChanged', 'localAvailable', 'size', 'approvalId', 'error', 'partialPath', 'cleanupPending']) &&
    identifier(v.id) && isCounter(v.revision) && v.revision > 0 && identifier(v.sessionId) && isCounter(v.generation) && v.generation > 0 &&
    v.target !== null && isTerminalSession({ sessionId: 'edit', generation: 1, hostId: 'edit', phase: 'ready', target: v.target, end: null, error: null }) &&
    isFilePath(v.remotePath) && (REMOTE_EDIT_STATES as readonly unknown[]).includes(v.state) && typeof v.localChanged === 'boolean' && typeof v.localAvailable === 'boolean' &&
    (v.size === null || (isCounter(v.size) && v.size <= MAX_REMOTE_EDIT_BYTES)) && (v.approvalId === null || identifier(v.approvalId)) &&
    (v.error === null || errors.includes(v.error)) && (v.partialPath === null || isFilePath(v.partialPath)) && typeof v.cleanupPending === 'boolean';
}
export function isRemoteEditState(v: unknown): v is RemoteEditState {
  return exactObject(v, ['owner', 'sequence', 'edits', 'capabilities']) && isOwner(v.owner) && isCounter(v.sequence) &&
    Array.isArray(v.edits) && v.edits.length <= MAX_REMOTE_EDITS && v.edits.every(isRemoteEditView) && new Set(v.edits.map((edit) => edit.id)).size === v.edits.length &&
    exactObject(v.capabilities, ['editor', 'maxBytes', 'resume', 'remoteToRemote']) && v.capabilities.editor === 'textedit' &&
    v.capabilities.maxBytes === MAX_REMOTE_EDIT_BYTES && v.capabilities.resume === false && v.capabilities.remoteToRemote === false;
}
