import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { posix } from "node:path";
import {
  channels, failure, MAX_FILE_MTIME, isAttributesOutcome, isConnectHostRequest, isFilePathRequest, isListingOutcome, isResolvedPathOutcome,
  isResolvePathRequest, isSftpState, isTerminalStateRequest, isTerminalTarget,
  type ConnectHostRequest, type ConnectHostResponse, type DirectoryListing, type FileAttributes, type FileErrorCode,
  type FileOutcome, type FilePathRequest, type Owner, type Result, type SftpSessionView, type SftpState,
  type TerminalActionResponse, type TerminalTarget,
} from "@ssterm/contracts";
import type { RemoteAttributes, SftpFailure, SftpResult } from "@ssterm/domain";
import type { SessionRegistry } from "@ssterm/services";
import { filePath, type LocalFiles } from "@ssterm/adapters/local-files";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";
import { createKindSessions, project, type LifecycleRegistry } from "./terminals";

/**
 * Local operations at once across every window (one controller per process). A stalled volume (a dead network
 * mount) hangs fs calls on libuv's 4-thread pool, which the rest of main shares; two operations of at most two
 * lstats each leave the pool usable.
 */
export const LOCAL_FILES_IN_FLIGHT = 2;
/** A local operation still running after this frees its slot and reports `not-responding`. */
export const LOCAL_FILES_TIMEOUT_MS = 10_000;

// Server status text never exists past the adapter; these are fixed codes only.
const fileError = (code: SftpFailure): FileErrorCode =>
  code === "cancelled" || code === "not-file" ? "failure" : code === "invalid-request" ? "invalid-path" : code;
const fail = (error: FileErrorCode): FileOutcome<never> => ({ ok: false, error });
const settle = <A, T>(result: SftpResult<A>, map: (value: A) => T): FileOutcome<T> =>
  result.ok ? { ok: true, value: map(result.value) } : fail(fileError(result.code));
const attributes = (value: RemoteAttributes): FileAttributes => ({
  type: value.type === "unknown" ? "other" : value.type, size: value.size,
  mtime: value.mtime !== null && value.mtime <= MAX_FILE_MTIME ? value.mtime : null, permissions: value.permissions,
});
/** `~`, `~/…` and relative input are taken from the source's home directory; anything else is already absolute. */
const expand = (path: string, home: string) =>
  path === "~" ? home : path.startsWith("~/") ? posix.join(home, path.slice(2)) : path.startsWith("/") ? path : posix.join(home, path);

export function createSftpController(options: {
  registry: LifecycleRegistry & Pick<SessionRegistry, "sftp">;
  checkAccess?: () => Promise<boolean>;
  /** This Mac's filesystem; available while the workspace is locked because it needs no saved secret. */
  local: LocalFiles;
  localTimeoutMs?: number;
}) {
  const { registry, localTimeoutMs = LOCAL_FILES_TIMEOUT_MS } = options;
  const sessions = createKindSessions<SftpSessionView>({
    kind: "sftp", registry, checkAccess: options.checkAccess, stateChannel: channels.sftpStateChanged, isState: isSftpState,
    view: (snapshot, ownerId) => {
      const { end: _end, ...view } = project(snapshot);
      return { ...view, home: registry.sftp(ownerId, snapshot.id, snapshot.generation)?.home ?? null };
    },
  });
  let localRunning = 0;
  /**
   * Runs one file operation on the exact source: the local provider, or a remote SFTP session fenced by owner,
   * session, generation, kind and Ready. A stale, foreign, non-Ready or terminal session is `conflict`.
   */
  const withFiles = async <T>(
    request: FilePathRequest, valid: (value: unknown) => value is FilePathRequest, isOutcome: (value: unknown) => value is FileOutcome<T>,
    target: (home: string) => string,
    operation: (files: LocalFiles, path: string, signal?: AbortSignal) => Promise<FileOutcome<T>>,
  ): Promise<Result<FileOutcome<T>>> => {
    // Normalized here so the 4,096-byte UTF-8 bound holds before any provider sees the path.
    const run = async (files: LocalFiles, signal?: AbortSignal) => {
      const path = filePath(target(files.home));
      return path ? operation(files, path, signal) : fail("invalid-path");
    };
    if (!valid(request)) return failure("invalid-request");
    if (!sessions.registration(request.owner)) return failure("stale-owner");
    const ownerId = sessionOwnerId(request.owner);
    const { source } = request;
    try {
      let outcome: FileOutcome<T>;
      if (source.kind === "remote") {
        const files = registry.sftp(ownerId, source.sessionId, source.generation);
        if (!files) return failure("conflict");
        outcome = await run(files);
      } else {
        if (localRunning >= LOCAL_FILES_IN_FLIGHT) return failure("busy");
        localRunning++;
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // ponytail: the timeout frees the slot, but a hung lstat/opendir still holds a libuv thread until the OS
        // returns; repeated timeouts on a dead mount can exhaust the pool. Upgrade: run the local provider in a
        // killable utilityProcess.
        const stalled = new Promise<FileOutcome<T>>((done) => {
          timer = setTimeout(() => { abort.abort(); done(fail("not-responding")); }, localTimeoutMs);
        });
        try { outcome = await Promise.race([run(options.local, abort.signal), stalled]); } finally {
          clearTimeout(timer);
          localRunning--;
        }
      }
      if (!sessions.registration(request.owner)) return failure("stale-owner");
      return isOutcome(outcome) ? { ok: true, value: outcome } : failure("unavailable");
    } catch { return failure("unavailable"); }
  };
  return {
    register: sessions.register,
    sftpState: (owner: Owner): Result<SftpState> => sessions.state(owner),
    connectSftp: (request: ConnectHostRequest): Promise<Result<ConnectHostResponse>> => sessions.connect(request),
    closeSftp: (request: TerminalTarget): Promise<Result<TerminalActionResponse>> => sessions.close(request),
    reconnectSftp: (request: TerminalTarget): Promise<Result<TerminalActionResponse>> => sessions.reconnect(request),
    dismissSftp: (request: TerminalTarget): Promise<Result<TerminalActionResponse>> => sessions.dismiss(request),
    listDirectory(request: FilePathRequest): Promise<Result<FileOutcome<DirectoryListing>>> {
      return withFiles(request, isFilePathRequest, isListingOutcome, () => request.path, async (files, path, signal) =>
        settle(await files.list(path, signal), (listing) => ({
          path, truncated: listing.truncated, skipped: listing.skipped,
          entries: listing.entries.map((entry) => ({ name: entry.name, addressable: entry.addressable, ...attributes(entry) })),
        })));
    },
    /** Follows symlinks, so a link is entered or selected by what it points to, at the link's own path. */
    statPath(request: FilePathRequest): Promise<Result<FileOutcome<FileAttributes>>> {
      return withFiles(request, isFilePathRequest, isAttributesOutcome, () => request.path, async (files, path, signal) => settle(await files.stat(path, signal), attributes));
    },
    resolvePath(request: FilePathRequest): Promise<Result<FileOutcome<string>>> {
      return withFiles(request, isResolvePathRequest, isResolvedPathOutcome, (home) => expand(request.path, home),
        async (files, path, signal) => settle(await files.realpath(path, signal), (resolved) => resolved));
    },
    revokeOwner: sessions.revokeOwner,
    dispose: sessions.dispose,
  };
}
export type SftpController = ReturnType<typeof createSftpController>;

/** Every IPC channel `registerSftpHandlers` owns, for callers that re-register them. */
export const sftpChannels = Object.freeze([
  channels.sftpState, channels.connectSftp, channels.closeSftp, channels.reconnectSftp, channels.dismissSftp,
  channels.listDirectory, channels.statPath, channels.resolvePath,
]);

export function registerSftpHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => SftpController | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (controller: SftpController, request: T) => unknown) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        controller.register(authorized.value, (name, value) => {
          if (!event.sender.isDestroyed()) event.sender.send(name, value);
        });
        return await run(controller, request);
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.sftpState, isTerminalStateRequest, (controller, request) => controller.sftpState(request.owner));
  handle(channels.connectSftp, isConnectHostRequest, (controller, request) => controller.connectSftp(request));
  handle(channels.closeSftp, isTerminalTarget, (controller, request) => controller.closeSftp(request));
  handle(channels.reconnectSftp, isTerminalTarget, (controller, request) => controller.reconnectSftp(request));
  handle(channels.dismissSftp, isTerminalTarget, (controller, request) => controller.dismissSftp(request));
  handle(channels.listDirectory, isFilePathRequest, (controller, request) => controller.listDirectory(request));
  handle(channels.statPath, isFilePathRequest, (controller, request) => controller.statPath(request));
  handle(channels.resolvePath, isResolvePathRequest, (controller, request) => controller.resolvePath(request));
  return () => { for (const channel of sftpChannels) options.ipc.removeHandler(channel); };
}
