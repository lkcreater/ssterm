/** Browser-safe SFTP capabilities shared by main services and remote-edit ports. */
/** `unknown`: the server sent no permission bits. */
export type RemoteType = 'file' | 'directory' | 'symlink' | 'other' | 'unknown';
/** `mtime` in whole seconds; `permissions` masked to 0o7777. Null when the server omitted the field. */
export interface RemoteAttributes {
  type: RemoteType;
  size: number | null;
  mtime: number | null;
  permissions: number | null;
}
/** Listing attributes are lstat-based. `addressable: false` means the name decoded lossily (U+FFFD) and cannot be sent back. */
export interface RemoteEntry extends RemoteAttributes {
  name: string;
  addressable: boolean;
}
/** At most 10,000 names per listing; `skipped` counts names refused as unsafe ('/', NUL, empty, over 1,024 bytes). */
export interface RemoteListing {
  entries: RemoteEntry[];
  truncated: boolean;
  skipped: number;
}
/** Server status text is never carried. `closed`: ssterm closed the session; `connection-lost`: the remote side did. */
export type SftpFailure = 'not-found' | 'not-file' | 'permission-denied' | 'no-space' | 'quota-exceeded' | 'failure' | 'invalid-path' | 'unsupported' | 'connection-lost' | 'resource-limit' | 'cancelled' | 'closed' | 'invalid-request';
export type SftpResult<T> = { ok: true; value: T } | { ok: false; code: SftpFailure };
/**
 * Main-only file capability of one SFTP session generation. Paths are absolute POSIX, normalized lexically,
 * at most 4,096 UTF-8 bytes. Every operation resolves (never throws); an aborted signal resolves `cancelled`
 * at once. Bounds are refused, never queued: 32 open handles, 64 requests and 2 MiB in flight.
 */
export interface SftpSession {
  /** Resolved once when the session became Ready (`/` when the server would not say). */
  readonly home: string;
  /** Largest single read and write this session accepts (server limits, capped below ssh2's packet limit). */
  readonly maxRead: number;
  readonly maxWrite: number;
  /** Explicit replacement is supported only when the backend negotiates an atomic replacement operation. */
  readonly atomicReplace?: boolean;
  /** Publish a closed, same-directory staged file. Never removes the old destination as a fallback. */
  publish?(stagedPath: string, finalPath: string, options: { replace: boolean }, signal?: AbortSignal): Promise<SftpResult<{ retainedPartial: boolean }>>;
  realpath(path: string, signal?: AbortSignal): Promise<SftpResult<string>>;
  /** Follows symlinks. */
  stat(path: string, signal?: AbortSignal): Promise<SftpResult<RemoteAttributes>>;
  lstat(path: string, signal?: AbortSignal): Promise<SftpResult<RemoteAttributes>>;
  list(path: string, signal?: AbortSignal): Promise<SftpResult<RemoteListing>>;
  openRead(path: string, signal?: AbortSignal): Promise<SftpResult<RemoteReader>>;
  /** Exclusive create only: an existing destination is `failure`. */
  openWrite(path: string, options: { mode: number }, signal?: AbortSignal): Promise<SftpResult<RemoteWriter>>;
}
export interface RemoteReader {
  /** `null` at end of file; a short read is not an end. `length` is 1..`maxRead`. */
  read(position: number, length: number, signal?: AbortSignal): Promise<SftpResult<Uint8Array | null>>;
  /** Idempotent; releases the handle. */
  close(): Promise<SftpResult<void>>;
}
export interface RemoteWriter {
  /** At most the server write limit per call. A cancelled write may still land. */
  write(position: number, bytes: Uint8Array, signal?: AbortSignal): Promise<SftpResult<void>>;
  /** Idempotent. Success means the server confirmed closing the destination. */
  close(): Promise<SftpResult<void>>;
}
/** Lifecycle owner's view. Only the session registry holds this; consumers receive `SftpSession`. */
export interface SftpChannel extends SftpSession {
  /** Resolves every outstanding operation `closed` and closes the subsystem channel. Idempotent. */
  dispose(): void;
  readonly drained: Promise<void>;
}
