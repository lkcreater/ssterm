import { lstat, opendir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import type { RemoteEntry, SftpFailure, SftpResult, SftpSession } from "@ssterm/domain";
import { attributes, listableName, remotePath, SFTP_MAX_ENTRIES } from "./sftp.ts";

/**
 * The read side of `SftpSession` over this Mac's filesystem. Main-only; metadata only, never file contents.
 * A signal is checked on entry and between the steps of a listing; main aborts it when an operation times out.
 */
export type LocalFiles = Pick<SftpSession, "home" | "realpath" | "stat" | "lstat" | "list">;

/** Per listing: a dead network mount blocks each lstat on one of libuv's four shared threads. */
const LSTAT_CONCURRENCY = 2;
const fail = <T>(code: SftpFailure): SftpResult<T> => ({ ok: false, code });
const ok = <T>(value: T): SftpResult<T> => ({ ok: true, value });
function failureOf(error: unknown): SftpFailure {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT": case "ENOTDIR": case "ELOOP": return "not-found";
    // EPERM is how macOS privacy protection (TCC) refuses a folder.
    case "EACCES": case "EPERM": return "permission-denied";
    case "ENAMETOOLONG": return "invalid-path";
    case "EMFILE": case "ENFILE": case "ENOMEM": return "resource-limit";
  }
  return "failure";
}
const metadata = (stats: Stats) => attributes({ mode: stats.mode, size: stats.size, mtime: Math.floor(stats.mtimeMs / 1000) });
async function run<T>(path: string, signal: AbortSignal | undefined, operation: (path: string) => Promise<T>): Promise<SftpResult<T>> {
  const target = remotePath(path);
  if (!target) return fail("invalid-request");
  if (signal?.aborted) return fail("cancelled");
  try { return ok(await operation(target)); } catch (error) { return fail(signal?.aborted ? "cancelled" : failureOf(error)); }
}

/** No root restriction: only paths the user navigates to explicitly are read, one directory at a time. */
export function createLocalFiles(home: string = homedir()): LocalFiles {
  return {
    home: remotePath(home) ?? "/",
    realpath: (path, signal) => run(path, signal, async (target) => {
      const resolved = remotePath(await realpath(target));
      if (!resolved) throw new Error("unaddressable");
      return resolved;
    }),
    stat: (path, signal) => run(path, signal, async (target) => metadata(await stat(target))),
    lstat: (path, signal) => run(path, signal, async (target) => metadata(await lstat(target))),
    list: (path, signal) => run(path, signal, async (target) => {
      const names: string[] = [];
      let skipped = 0, truncated = false;
      // Streamed so a huge directory is never read whole; breaking out of the loop closes the handle.
      for await (const entry of await opendir(target, { bufferSize: 128 })) {
        signal?.throwIfAborted();
        if (names.length + skipped === SFTP_MAX_ENTRIES) { truncated = true; break; }
        if (listableName(entry.name)) names.push(entry.name);
        else skipped++;
      }
      const entries: RemoteEntry[] = new Array(names.length);
      let next = 0;
      const worker = async () => {
        while (next < names.length) {
          signal?.throwIfAborted();
          const index = next++;
          const name = names[index]!;
          // A name removed since it was listed still shows, without attributes.
          const attrs = await lstat(posix.join(target, name)).then(metadata, () => attributes(undefined));
          entries[index] = { name, addressable: !name.includes("\uFFFD"), ...attrs };
        }
      };
      await Promise.all(Array.from({ length: LSTAT_CONCURRENCY }, worker));
      return { entries, truncated, skipped };
    }),
  };
}
/** Lexical normalization shared with SFTP: absolute, NUL-free, well-formed, at most 4,096 UTF-8 bytes; else undefined. */
export { remotePath as filePath } from "./sftp.ts";
