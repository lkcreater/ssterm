import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { RemoteReader, RemoteWriter, SftpFailure, SftpResult } from "@ssterm/domain";
import { attributes, remotePath } from "./sftp.ts";

type LocalFailure = SftpFailure | "not-file" | "destination-exists";
type Result<T> = { ok: true; value: T } | { ok: false; code: LocalFailure };
const fail = <T>(code: LocalFailure): Result<T> => ({ ok: false, code });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function failureOf(error: unknown): LocalFailure {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT": case "ENOTDIR": return "not-found";
    case "ELOOP": case "EISDIR": return "not-file";
    case "EEXIST": return "destination-exists";
    case "EPERM": case "EACCES": return "permission-denied";
    case "EMFILE": case "ENFILE": case "ENOMEM": return "resource-limit";
    case "ENAMETOOLONG": return "invalid-path";
  }
  return "failure";
}
const validIo = (position: number, length: number) => Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length > 0 && length <= 65_536;
/** Native fs promises intentionally settle only after actual I/O, so the engine can quarantine its permit. */
export function createLocalTransferFiles() {
  async function acquire<T>(path: string, signal: AbortSignal | undefined, flags: number, build: (handle: FileHandle, close: () => Promise<SftpResult<void>>, closed: () => boolean) => T): Promise<Result<T>> {
    const target = remotePath(path);
    if (!target) return fail("invalid-request");
    if (signal?.aborted) return fail("cancelled");
    let handle: FileHandle | undefined;
    try {
      handle = await open(target, flags, 0o600);
      if (signal?.aborted) { await handle.close(); return fail("cancelled"); }
      const stats = await handle.stat();
      if (signal?.aborted || !stats.isFile()) { await handle.close(); return fail(signal?.aborted ? "cancelled" : "not-file"); }
      let closing: Promise<SftpResult<void>> | undefined;
      const owned = handle;
      const close = () => closing ??= owned.close().then(() => ({ ok: true as const, value: undefined }), () => ({ ok: false as const, code: "failure" as const }));
      return ok(build(owned, close, () => closing !== undefined));
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      return fail(signal?.aborted ? "cancelled" : failureOf(error));
    }
  }
  return {
    maxRead: 65_536,
    maxWrite: 65_536,
    async lstat(path: string, signal?: AbortSignal) {
      const target = remotePath(path);
      if (!target) return fail<ReturnType<typeof attributes>>("invalid-request");
      if (signal?.aborted) return fail<ReturnType<typeof attributes>>("cancelled");
      try {
        const stats = await lstat(target);
        return signal?.aborted ? fail<ReturnType<typeof attributes>>("cancelled") : ok(attributes({ mode: stats.mode, size: stats.size, mtime: Math.floor(stats.mtimeMs / 1000) }));
      } catch (error) { return fail<ReturnType<typeof attributes>>(signal?.aborted ? "cancelled" : failureOf(error)); }
    },
    openRead(path: string, signal?: AbortSignal): Promise<Result<RemoteReader>> {
      return acquire(path, signal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, (handle, close, closed): RemoteReader => ({
        async read(position, length, signal) {
          if (closed()) return { ok: false, code: "closed" };
          if (signal?.aborted) return { ok: false, code: "cancelled" };
          if (!validIo(position, length)) return { ok: false, code: "invalid-request" };
          try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            return signal?.aborted ? { ok: false, code: "cancelled" } : { ok: true, value: bytesRead ? new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead) : null };
          } catch { return { ok: false, code: signal?.aborted ? "cancelled" : "failure" }; }
        },
        close,
      }));
    },
    openWrite(path: string, options: { mode: number }, signal?: AbortSignal): Promise<Result<RemoteWriter>> {
      if (options.mode !== 0o600) return Promise.resolve(fail("invalid-request"));
      return acquire(path, signal, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, (handle, close, closed): RemoteWriter => ({
        async write(position, bytes, signal) {
          if (closed()) return { ok: false, code: "closed" };
          if (signal?.aborted) return { ok: false, code: "cancelled" };
          if (!(bytes instanceof Uint8Array) || !validIo(position, bytes.byteLength)) return { ok: false, code: "invalid-request" };
          try {
            let offset = 0;
            while (offset < bytes.length) {
              if (signal?.aborted) return { ok: false, code: "cancelled" };
              const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
              if (!bytesWritten) return { ok: false, code: "failure" };
              offset += bytesWritten;
            }
            return signal?.aborted ? { ok: false, code: "cancelled" } : { ok: true, value: undefined };
          } catch { return { ok: false, code: signal?.aborted ? "cancelled" : "failure" }; }
        },
        close,
      }));
    },
  };
}
