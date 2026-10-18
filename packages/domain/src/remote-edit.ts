import type { RemoteReader, RemoteWriter, SftpFailure } from './sftp-types.ts';

/** Browser-safe bounds and main-only ports; remote document bytes never cross IPC. */
export const MAX_REMOTE_EDIT_BYTES = 8 * 1024 * 1024;
export const MAX_REMOTE_EDITS = 8;
export const REMOTE_EDIT_WORKERS = 2;
export type RemoteEditFailure = SftpFailure | 'too-large' | 'invalid-text' | 'local-changed' |
  'remote-changed' | 'editor-unavailable' | 'cleanup-failed' | 'timeout' | 'publication-unknown';
export type RemoteEditIOResult<T> = { ok: true; value: T } | { ok: false; code: RemoteEditFailure };
export const REMOTE_EDIT_STATES = [
  'queued', 'downloading', 'ready', 'opening', 'editing', 'checking', 'changed', 'conflict',
  'uploading', 'publishing', 'uploaded', 'cancelling', 'failed', 'cleanup-failed',
] as const;
export type RemoteEditStatus = (typeof REMOTE_EDIT_STATES)[number];
export interface RemoteEditTarget {
  label: string;
  environment: 'DEV' | 'STAGING' | 'PROD' | null;
  endpointHost: string;
  endpointPort: number;
  username: string | null;
}
export interface RemoteEditView {
  id: string;
  revision: number;
  sessionId: string;
  generation: number;
  target: RemoteEditTarget;
  remotePath: string;
  state: RemoteEditStatus;
  localChanged: boolean;
  /** A validated app-owned working copy is still available (clean metadata history has none). */
  localAvailable: boolean;
  size: number | null;
  approvalId: string | null;
  error: RemoteEditFailure | null;
  /** Failed remote stage only; app-owned local working paths never cross IPC. */
  partialPath: string | null;
  cleanupPending: boolean;
}

/** Immutable, private copy of exactly the text a user approved. Path stays inside its owning adapter. */
export interface RemoteEditSnapshot {
  readonly size: number;
  readonly sha256: string;
  openRead(signal?: AbortSignal): Promise<RemoteEditIOResult<RemoteReader>>;
  dispose(): Promise<RemoteEditIOResult<void>>;
}
export interface RemoteEditWorkspace {
  /** Generated document.txt path; main/launcher only, never renderer input or IPC output. */
  readonly documentPath: string;
  /** Exclusive initial creation, requested mode 0600. */
  openWrite(signal?: AbortSignal): Promise<RemoteEditIOResult<RemoteWriter>>;
  /** Bounded UTF-8/no-NUL snapshot; reject a changing or nonregular working file. */
  snapshot(signal?: AbortSignal): Promise<RemoteEditIOResult<RemoteEditSnapshot>>;
  /** Delete only the marked directory/entries owned by this workspace, after native I/O settles. */
  cleanup(): Promise<RemoteEditIOResult<void>>;
}
export interface RemoteEditFiles {
  create(signal?: AbortSignal): Promise<RemoteEditIOResult<RemoteEditWorkspace>>;
  /** Confined startup cleanup; refuse unsafe/unmarked paths rather than broadly deleting temp files. */
  prune(): Promise<RemoteEditIOResult<void>>;
}
export interface RemoteEditEditor {
  /** Fixed native text editor; no shell or renderer-provided executable/arguments. */
  open(documentPath: string, signal?: AbortSignal): Promise<RemoteEditIOResult<void>>;
}
