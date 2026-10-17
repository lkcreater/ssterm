import { posix } from "node:path";
import type { SFTPWrapper } from "ssh2";
import type { RemoteAttributes, RemoteEntry, RemoteReader, RemoteWriter, SftpChannel, SftpFailure, SftpResult } from "@ssterm/domain";

export const SFTP_MAX_HANDLES = 32;
export const SFTP_MAX_REQUESTS = 64;
export const SFTP_MAX_INFLIGHT_BYTES = 2_097_152;
// ssh2 refuses any inbound SFTP packet over 262,144 bytes, and a DATA reply adds 9 bytes of header, so a
// 262,144-byte read would be a fatal protocol error. 261,120 is OpenSSH's advertised max-read-length.
export const SFTP_MAX_READ = 261_120;
/** Conservative fallback when ssh2's negotiated limits are missing or malformed. */
const FALLBACK_IO = 32_768;
export const SFTP_MAX_ENTRIES = 10_000;
export const SFTP_MAX_NAME_BYTES = 1_024;
export const SFTP_MAX_PATH_BYTES = 4_096;

// ssh2-internal: negotiated limits (limits@openssh.com) and channel states. Requests issued once the
// channel is closing are never answered, which is why every call checks `ended` first.
interface Internals {
  _maxReadLen?: unknown;
  _maxWriteLen?: unknown;
  maxOpenHandles?: unknown;
  incoming?: { state?: unknown };
  outgoing?: { state?: unknown };
}
type Failure = (Error & { code?: unknown }) | null | undefined;
type Callback = (error: Failure, ...values: any[]) => void;
/**
 * ssh2 fails outstanding requests without a status code when the channel goes away, including on a
 * remote EOF (OpenSSH sends EOF before CLOSE), when only `incoming` has left "open".
 */
export const channelGone = (sftp: SFTPWrapper) => {
  const { incoming, outgoing } = sftp as unknown as Internals;
  return incoming?.state !== "open" || outgoing?.state !== "open";
};
const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const fail = <T>(code: SftpFailure): SftpResult<T> => ({ ok: false, code });
const ok = <T>(value: T): SftpResult<T> => ({ ok: true, value });

/** Absolute, lexically normalized, well-formed, NUL-free and at most 4,096 UTF-8 bytes; otherwise undefined. */
export function remotePath(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || /\p{Cs}/u.test(path)) return;
  let normalized = posix.normalize(path);
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return Buffer.byteLength(normalized) <= SFTP_MAX_PATH_BYTES ? normalized : undefined;
}

/** A listed name that is safe to show and send back: not empty, no '/' or NUL, at most 1,024 UTF-8 bytes. */
export const listableName = (name: unknown): name is string =>
  typeof name === "string" && name !== "" && !name.includes("/") && !name.includes("\0") && Buffer.byteLength(name) <= SFTP_MAX_NAME_BYTES;

const TYPES = new Map<number, RemoteAttributes["type"]>([[0o100000, "file"], [0o040000, "directory"], [0o120000, "symlink"]]);
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Mode, size and mtime (seconds) as SFTP reports them, or as lstat does locally. */
export function attributes(attrs: { mode?: unknown; size?: unknown; mtime?: unknown } | undefined): RemoteAttributes {
  const mode = integer(attrs?.mode);
  return {
    type: mode === null ? "unknown" : TYPES.get(mode & 0o170000) ?? "other",
    size: integer(attrs?.size),
    mtime: integer(attrs?.mtime),
    permissions: mode === null ? null : mode & 0o7777,
  };
}

/**
 * Wraps a negotiated ssh2 SFTP channel. `home` is resolved by the caller before Ready. `lost()` must run
 * before the connection reports a remote loss, because that report disposes the channel (`closed`).
 */
export function createSftpChannel(sftp: SFTPWrapper, home: string): SftpChannel & { lost(): void } {
  const internals = sftp as unknown as Internals;
  const maxRead = Math.min(SFTP_MAX_READ, positive(internals._maxReadLen, FALLBACK_IO));
  const maxWrite = positive(internals._maxWriteLen, FALLBACK_IO);
  // ssh2 reports "no limit" as Infinity, which the fallback caps at the session bound anyway.
  const maxHandles = Math.min(SFTP_MAX_HANDLES, positive(internals.maxOpenHandles, SFTP_MAX_HANDLES));
  const pending = new Set<(code: SftpFailure) => void>();
  let ended: SftpFailure | undefined, disposed = false;
  let handles = 0, requests = 0, bytes = 0;
  let resolveDrain!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
  const end = (code: SftpFailure) => {
    if (ended) return;
    ended = code;
    for (const settle of [...pending]) settle(code);
  };
  sftp.on("close", () => { end("connection-lost"); resolveDrain(); });
  // Remote EOF: ssh2 has already failed outstanding requests and will answer no new ones.
  sftp.on("end", () => end("connection-lost"));
  // A protocol error destroys the channel; the session layer reports it. Without a listener it would throw.
  sftp.on("error", () => end("connection-lost"));

  const failureOf = (error: { code?: unknown }): SftpFailure => {
    if (ended) return ended;
    switch (error.code) {
      case 2: return "not-found";
      case 3: return "permission-denied";
      case 5: return "invalid-path";
      case 8: return "unsupported";
      case 6: case 7: return "connection-lost";
    }
    return typeof error.code !== "number" && channelGone(sftp) ? "connection-lost" : "failure";
  };

  /**
   * One ssh2 request under the in-flight bounds. Budget is released only when ssh2 answers, so a cancelled
   * request still counts until the server replies; `late` receives an answer that arrives after settlement.
   */
  const call = <T>(
    signal: AbortSignal | undefined,
    size: number,
    issue: (callback: Callback) => void,
    map: (error: Failure, ...values: any[]) => SftpResult<T>,
    late?: Callback,
    bounded = true,
  ): Promise<SftpResult<T>> => {
    if (ended) return Promise.resolve(fail(ended));
    if (signal?.aborted) return Promise.resolve(fail("cancelled"));
    if (bounded && (requests >= SFTP_MAX_REQUESTS || bytes + size > SFTP_MAX_INFLIGHT_BYTES)) return Promise.resolve(fail("resource-limit"));
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: SftpResult<T>) => {
        if (settled) return;
        settled = true;
        pending.delete(onEnd);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onEnd = (code: SftpFailure) => settle(fail(code));
      const onAbort = () => settle(fail("cancelled"));
      pending.add(onEnd);
      signal?.addEventListener("abort", onAbort, { once: true });
      requests++; bytes += size;
      let answered = false;
      try {
        issue((error, ...values) => {
          if (answered) return;
          answered = true;
          requests--; bytes -= size;
          if (settled) { late?.(error, ...values); return; }
          try { settle(map(error, ...values)); } catch { settle(fail("failure")); }
        });
      } catch {
        if (!answered) { answered = true; requests--; bytes -= size; }
        settle(fail("failure"));
      }
    });
  };
  const status = (error: Failure): SftpResult<void> => error ? fail(failureOf(error)) : ok(undefined);

  /** CLOSE is never refused by the in-flight bounds or cancelled, so a busy session can always release handles. */
  const closeHandle = (handle: Buffer): Promise<SftpResult<void>> => {
    if (ended) { handles--; return Promise.resolve(fail(ended)); }
    return call(undefined, 0, (callback) => sftp.close(handle, callback), status, undefined, false)
      .finally(() => { handles--; });
  };
  /** Takes a ledger slot when OPEN/OPENDIR is issued; a handle that arrives after cancellation is closed. */
  const openHandle = (signal: AbortSignal | undefined, issue: (callback: Callback) => void): Promise<SftpResult<Buffer>> => {
    if (!ended && handles >= maxHandles)
      return Promise.resolve(fail("resource-limit"));
    return call(signal, 0, (callback) => {
      handles++;
      try { issue(callback); } catch (error) { handles--; throw error; }
    }, (error, handle: unknown) => {
      if (!error && Buffer.isBuffer(handle)) return ok(handle);
      handles--;
      return fail(error ? failureOf(error) : "failure");
    }, (error, handle: unknown) => {
      if (!error && Buffer.isBuffer(handle)) void closeHandle(handle);
      else handles--;
    });
  };
  const opened = <T>(handle: Buffer, build: (close: () => Promise<SftpResult<void>>, isClosed: () => boolean) => T): T => {
    let closing: Promise<SftpResult<void>> | undefined;
    return build(() => closing ??= closeHandle(handle), () => closing !== undefined);
  };

  const channel: SftpChannel & { lost(): void } = {
    home,
    maxRead,
    maxWrite,
    lost: () => end("connection-lost"),
    drained,
    realpath(path, signal) {
      const target = remotePath(path);
      if (!target) return Promise.resolve(fail("invalid-request"));
      return call(signal, 0, (callback) => sftp.realpath(target, callback), (error, resolved: unknown) => {
        if (error) return fail(failureOf(error));
        const value = remotePath(resolved);
        return value ? ok(value) : fail("failure");
      });
    },
    stat(path, signal) {
      const target = remotePath(path);
      if (!target) return Promise.resolve(fail("invalid-request"));
      return call(signal, 0, (callback) => sftp.stat(target, callback), (error, attrs) => error ? fail(failureOf(error)) : ok(attributes(attrs)));
    },
    lstat(path, signal) {
      const target = remotePath(path);
      if (!target) return Promise.resolve(fail("invalid-request"));
      return call(signal, 0, (callback) => sftp.lstat(target, callback), (error, attrs) => error ? fail(failureOf(error)) : ok(attributes(attrs)));
    },
    async list(path, signal) {
      const target = remotePath(path);
      if (!target) return fail("invalid-request");
      const handle = await openHandle(signal, (callback) => sftp.opendir(target, callback));
      if (!handle.ok) return handle;
      const entries: RemoteEntry[] = [];
      let skipped = 0, truncated = false;
      let outcome: SftpResult<void> = ok(undefined);
      // Bounds round trips too: a hostile server could answer with empty or dot-only batches forever.
      for (let rounds = 0; ; rounds++) {
        if (rounds > SFTP_MAX_ENTRIES) { truncated = true; break; }
        type Batch = { filename?: unknown; attrs?: Record<string, unknown> }[] | null;
        const batch = await call<Batch>(signal, 0, (callback) => sftp.readdir(handle.value, callback), (error, list: unknown) => {
          if (error?.code === 1) return ok(null);
          if (error) return fail(failureOf(error));
          return Array.isArray(list) ? ok(list) : fail("failure");
        });
        if (!batch.ok) { outcome = batch; break; }
        if (batch.value === null) break;
        for (const item of batch.value) {
          const name = item?.filename;
          if (name === "." || name === "..") continue;
          // Counts skipped names too, so a hostile server cannot stream unsafe names forever.
          if (entries.length + skipped === SFTP_MAX_ENTRIES) { truncated = true; break; }
          if (!listableName(name)) {
            skipped++;
            continue;
          }
          entries.push({ name, addressable: !name.includes("\uFFFD"), ...attributes(item.attrs) });
        }
        if (truncated) break;
      }
      const closed = closeHandle(handle.value);
      if (!outcome.ok) return outcome;
      // The CLOSE itself is never cancelled (it releases the slot); cancellation only stops waiting for it.
      if (!signal) await closed;
      else if (!signal.aborted) {
        let onAbort!: () => void;
        await Promise.race([closed, new Promise<void>((resolve) => signal.addEventListener("abort", onAbort = () => resolve(), { once: true }))]);
        signal.removeEventListener("abort", onAbort);
      }
      return signal?.aborted ? fail("cancelled") : ok({ entries, truncated, skipped });
    },
    async openRead(path, signal) {
      const target = remotePath(path);
      if (!target) return fail("invalid-request");
      const handle = await openHandle(signal, (callback) => sftp.open(target, "r", callback));
      if (!handle.ok) return handle;
      // The pathname can change between preflight lstat and OPEN. Refuse handles to special files.
      const checked = await call(signal, 0, (callback) => sftp.fstat(handle.value, callback), (error, attrs) => error ? fail<RemoteAttributes>(failureOf(error)) : ok(attributes(attrs)));
      if (!checked.ok || checked.value.type !== "file") {
        await closeHandle(handle.value);
        return checked.ok ? fail("not-file") : checked;
      }
      return ok(opened(handle.value, (close, isClosed): RemoteReader => ({
        read(position, length, signal) {
          if (isClosed()) return Promise.resolve(fail(ended ?? "closed"));
          if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 1
            || length > maxRead)
            return Promise.resolve(fail("invalid-request"));
          let buffer!: Buffer;
          return call(signal, length, (callback) => {
            buffer = Buffer.alloc(length);
            sftp.read(handle.value, buffer, 0, length, position, callback);
          }, (error, count: unknown) => {
            if (error) return fail(failureOf(error));
            if (typeof count !== "number" || count < 0 || count > length) return fail("failure");
            return ok(count === 0 ? null : new Uint8Array(buffer.buffer, buffer.byteOffset, count));
          });
        },
        close,
      })));
    },
    async openWrite(path, options, signal) {
      const target = remotePath(path);
      const mode = options?.mode;
      if (!target || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) return fail("invalid-request");
      const handle = await openHandle(signal, (callback) => sftp.open(target, "wx", { mode }, callback));
      if (!handle.ok) return handle;
      return ok(opened(handle.value, (close, isClosed): RemoteWriter => ({
        write(position, data, signal) {
          if (isClosed()) return Promise.resolve(fail(ended ?? "closed"));
          if (!Number.isSafeInteger(position) || position < 0 || !(data instanceof Uint8Array) || data.byteLength < 1
            || data.byteLength > maxWrite)
            return Promise.resolve(fail("invalid-request"));
          // ssh2 copies the payload into its packet synchronously; the caller's bytes are not retained.
          const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          return call(signal, data.byteLength, (callback) => sftp.write(handle.value, view, 0, view.length, position, callback), status);
        },
        close,
      })));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      end("closed");
      try { sftp.end(); } catch { /* The connection teardown closes the channel regardless. */ }
    },
  };
  return channel;
}
