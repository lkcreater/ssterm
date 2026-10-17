import { constants } from "node:fs";
import { link, lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import type { RemoteReader, RemoteWriter, SftpFailure, SftpResult } from "@ssterm/domain";
import { attributes, remotePath } from "./sftp.ts";

type LocalFailure = SftpFailure | "not-file" | "destination-exists" | "publication-unknown";
type Result<T> = { ok: true; value: T } | { ok: false; code: LocalFailure };
const fail = <T>(code: LocalFailure): Result<T> => ({ ok: false, code });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function failureOf(error: unknown): Exclude<LocalFailure, "publication-unknown"> {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT": case "ENOTDIR": return "not-found";
    case "ELOOP": case "EISDIR": return "not-file";
    case "EEXIST": return "destination-exists";
    case "ENOSPC": return "no-space";
    case "EDQUOT": return "quota-exceeded";
    case "EPERM": case "EACCES": return "permission-denied";
    case "EMFILE": case "ENFILE": case "ENOMEM": return "resource-limit";
    case "ENAMETOOLONG": return "invalid-path";
  }
  return "failure";
}
const validIo = (position: number, length: number) => Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length > 0 && length <= 65_536;
/** Native fs promises intentionally settle only after actual I/O, so the engine can quarantine its permit. */
export function createLocalTransferFiles(publication: Pick<typeof import("node:fs/promises"), "link" | "lstat" | "rename" | "unlink"> = { link, lstat, rename, unlink }) {
  // Bind publication to the file this adapter created, not a later replacement of its pathname.
  // Node has no portable inode-conditional rename/unlink: the containing directory must be trusted
  // against hostile concurrent mutation between these checks and the filesystem operation.
  const stageOwners = new Map<string, { dev: number; ino: number; closed: boolean }>();
  const makeLedgerRoom = () => {
    if (stageOwners.size < 1_024) return true;
    for (const [path, owner] of stageOwners) if (owner.closed) { stageOwners.delete(path); return true; }
    return false;
  };
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
      const ownership = flags & constants.O_CREAT ? { dev: stats.dev, ino: stats.ino, closed: false } : undefined;
      if (ownership) stageOwners.set(target, ownership);
      let closing: Promise<SftpResult<void>> | undefined;
      const owned = handle;
      const close = () => closing ??= owned.close().then(() => ({ ok: true as const, value: undefined }), () => ({ ok: false as const, code: "failure" as const }))
        .finally(() => { if (ownership) ownership.closed = true; });
      return ok(build(owned, close, () => closing !== undefined));
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      return fail(signal?.aborted ? "cancelled" : failureOf(error));
    }
  }
  return {
    maxRead: 65_536,
    maxWrite: 65_536,
    atomicReplace: true,
    async publish(stagedPath: string, finalPath: string, options: { replace: boolean }, signal?: AbortSignal): Promise<Result<{ retainedPartial: boolean }>> {
      const staged = remotePath(stagedPath), final = remotePath(finalPath);
      if (!staged || !final || staged === final || posix.dirname(staged) !== posix.dirname(final)
        || typeof options?.replace !== "boolean") return fail("invalid-request");
      if (signal?.aborted) return fail("cancelled");
      try {
        const owner = stageOwners.get(staged);
        if (!owner?.closed) return fail("invalid-request");
        const before = await publication.lstat(staged);
        if (!before.isFile()) return fail("not-file");
        if (before.dev !== owner.dev || before.ino !== owner.ino) return fail("invalid-request");
        if (options.replace) {
          // Refuse selected symlinks, directories and devices even when replacement was approved.
          const existing = await publication.lstat(final).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
          if (existing && !existing.isFile()) return fail("not-file");
        }
        if (signal?.aborted) return fail("cancelled");
        if (options.replace) {
          await publication.rename(staged, final);
          stageOwners.delete(staged);
          return ok({ retainedPartial: false });
        }
        // link is exclusive, unlike POSIX rename, so a newly appearing final file is preserved.
        await publication.link(staged, final);
        stageOwners.delete(staged);
        // A missing or substituted final pathname is an ambiguous publication, never success.
        const published = await publication.lstat(final).catch(() => null);
        if (!published || published.dev !== before.dev || published.ino !== before.ino)
          return fail("publication-unknown");
        try {
          const current = await publication.lstat(staged);
          if (current.dev !== before.dev || current.ino !== before.ino)
            return ok({ retainedPartial: true });
          await publication.unlink(staged);
          return ok({ retainedPartial: false });
        } catch { return ok({ retainedPartial: true }); }
      } catch (error) { return fail(failureOf(error)); }
    },
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
          } catch (error) {
            const code = failureOf(error);
            return { ok: false, code: signal?.aborted ? "cancelled" : code === "destination-exists" ? "failure" : code };
          }
        },
        close,
      }));
    },
    openWrite(path: string, options: { mode: number }, signal?: AbortSignal): Promise<Result<RemoteWriter>> {
      if (options.mode !== 0o600) return Promise.resolve(fail("invalid-request"));
      if (!makeLedgerRoom()) return Promise.resolve(fail("resource-limit"));
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
          } catch (error) {
            const code = failureOf(error);
            return { ok: false, code: signal?.aborted ? "cancelled" : code === "destination-exists" ? "failure" : code };
          }
        },
        close,
      }));
    },
  };
}
