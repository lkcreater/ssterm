import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as native from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  MAX_REMOTE_EDIT_BYTES, type RemoteEditFiles, type RemoteEditWorkspace,
  type RemoteEditSnapshot, type RemoteEditIOResult, type RemoteEditFailure,
  type RemoteReader, type RemoteWriter, type SftpResult, type SftpFailure,
} from "@ssterm/domain";

const CHUNK = 65_536;
const MARKER = ".ssterm-remote-edit";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EDIT_NAME = new RegExp(`^edit-(${UUID})$`);
const SNAPSHOT_NAME = new RegExp(`^snapshot-${UUID}\\.txt$`);
const markerText = (id: string) => `ssterm-remote-edit-v1\n${id}\n`;
const ok = <T>(value: T): RemoteEditIOResult<T> => ({ ok: true, value });
const fail = <T>(code: RemoteEditFailure): RemoteEditIOResult<T> => ({ ok: false, code });
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const stable = (a: Stats, b: Stats) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const validIO = (position: number, length: number) => Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length > 0 && length <= CHUNK;
const isPrivate = (s: Stats) => (s.mode & 0o077) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid());
function failure(error: unknown): RemoteEditFailure {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOENT": case "ENOTDIR": return "not-found";
    case "ELOOP": case "EISDIR": return "not-file";
    case "EACCES": case "EPERM": return "permission-denied";
    case "ENOSPC": return "no-space";
    case "EDQUOT": return "quota-exceeded";
    case "EMFILE": case "ENFILE": case "ENOMEM": return "resource-limit";
    default: return "failure";
  }
}

/** Main-only private working copies. Native operations settle before releasing their ownership.
 * Node lacks directory-relative, inode-conditional unlink: the private profile must be trusted
 * against malicious same-UID mutation between identity checks and native operations.
 */
export function createRemoteEditFiles(options: { root: string; io?: Partial<typeof native> }): RemoteEditFiles {
  const fs = { ...native, ...options.io };
  const root = options.root;
  let rootOwner: Stats | undefined;
  const live = new Set<string>();
  async function ensureRoot(): Promise<void> {
    if (!isAbsolute(root) || basename(root) !== "remote-edit-temp") throw new Error("invalid root");
    try { await fs.mkdir(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || !isPrivate(stat) || (rootOwner && !same(stat, rootOwner))) throw new Error("unsafe root");
    rootOwner ??= stat;
  }
  async function entriesBounded(path: string, limit: number): Promise<string[]> {
    const directory = await fs.opendir(path);
    const names: string[] = [];
    try {
      while (names.length <= limit) {
        const entry = await directory.read();
        if (!entry) return names;
        names.push(entry.name);
      }
      throw new Error("entry limit");
    } finally { await directory.close(); }
  }
  async function verifyDirectory(path: string, owner: Stats): Promise<void> {
    await ensureRoot();
    const current = await fs.lstat(path);
    if (dirname(path) !== root || !current.isDirectory() || !isPrivate(current) || !same(current, owner)) throw new Error("unsafe workspace");
  }
  async function verifyMarker(path: string, id: string): Promise<void> {
    const handle = await fs.open(join(path, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const bytes = Buffer.alloc(128);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !isPrivate(stat) || stat.nlink !== 1 || stat.size !== Buffer.byteLength(markerText(id))) throw new Error("unsafe marker");
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (bytes.subarray(0, read.bytesRead).toString("utf8") !== markerText(id)) throw new Error("invalid marker");
    } finally { bytes.fill(0); await handle.close(); }
  }
  async function removeDirectory(path: string, id: string, owner: Stats): Promise<void> {
    await verifyDirectory(path, owner);
    await verifyMarker(path, id);
    const entries = await entriesBounded(path, 64);
    if (entries.length > 64 || entries.some((name) => name !== MARKER && name !== "document.txt" && !SNAPSHOT_NAME.test(name))) throw new Error("unowned entry");
    // Validate the complete namespace before removing anything. Never traverse directories or links.
    const identities = new Map<string, Stats>();
    for (const name of entries) {
      const stat = await fs.lstat(join(path, name));
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe entry");
      identities.set(name, stat);
    }
    for (const name of entries.filter((name) => name !== MARKER)) {
      await verifyDirectory(path, owner);
      const current = await fs.lstat(join(path, name));
      if (!same(current, identities.get(name)!)) throw new Error("changed entry");
      await fs.unlink(join(path, name));
    }
    await verifyDirectory(path, owner);
    const marker = await fs.lstat(join(path, MARKER));
    if (!same(marker, identities.get(MARKER)!)) throw new Error("changed marker");
    await fs.unlink(join(path, MARKER));
    try { await fs.rmdir(path); }
    catch (error) {
      // Retain a trustworthy marker for a retriable cleanup if directory removal failed.
      await fs.writeFile(join(path, MARKER), markerText(id), { flag: "wx", mode: 0o600 }).catch(() => undefined);
      throw error;
    }
  }
  function workspace(path: string, id: string, owner: Stats): RemoteEditWorkspace {
    const documentPath = join(path, "document.txt");
    const pending = new Set<Promise<unknown>>();
    const handles = new Set<native.FileHandle>();
    let cleaning = false, cleaned = false, snapshotting = false;
    let cleanupPromise: Promise<RemoteEditIOResult<void>> | undefined;
    function track<T>(action: () => Promise<T>): Promise<T> {
      const promise = action(); pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    }
    async function closeHandle(handle: native.FileHandle): Promise<SftpResult<void>> {
      try { await handle.close(); handles.delete(handle); return { ok: true, value: undefined }; }
      catch { return { ok: false, code: "failure" }; }
    }
    function reader(handle: native.FileHandle): RemoteReader {
      let closed: Promise<SftpResult<void>> | undefined;
      return {
        read(position, length, signal) { return track(async () => {
          if (closed || cleaning) return { ok: false, code: "closed" };
          if (signal?.aborted) return { ok: false, code: "cancelled" };
          if (!validIO(position, length)) return { ok: false, code: "invalid-request" };
          const buffer = Buffer.alloc(length);
          try {
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (signal?.aborted || cleaning) { buffer.fill(0); return { ok: false, code: "cancelled" }; }
            if (!bytesRead) { buffer.fill(0); return { ok: true, value: null }; }
            return { ok: true, value: buffer.subarray(0, bytesRead) };
          } catch (error) { buffer.fill(0); return { ok: false, code: failure(error) as SftpFailure }; }
        }); },
        close() { return closed ??= track(() => closeHandle(handle)); },
      };
    }
    return {
      documentPath,
      openWrite(signal) { return track(async () => {
        if (cleaning) return fail("closed");
        if (signal?.aborted) return fail("cancelled");
        let handle: native.FileHandle | undefined;
        try {
          await verifyDirectory(path, owner);
          handle = await fs.open(documentPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          handles.add(handle);
          if (signal?.aborted || cleaning) { await closeHandle(handle); return fail("cancelled"); }
          const opened = handle;
          let closed: Promise<SftpResult<void>> | undefined;
          const writer: RemoteWriter = {
            write(position, bytes, writeSignal) { return track(async () => {
              if (closed || cleaning) return { ok: false, code: "closed" };
              if (writeSignal?.aborted) return { ok: false, code: "cancelled" };
              if (!(bytes instanceof Uint8Array) || !validIO(position, bytes.length) || position + bytes.length > MAX_REMOTE_EDIT_BYTES) return { ok: false, code: "invalid-request" };
              try {
                let offset = 0;
                while (offset < bytes.length) {
                  if (writeSignal?.aborted || cleaning) return { ok: false, code: "cancelled" };
                  const result = await opened.write(bytes, offset, bytes.length - offset, position + offset);
                  if (!result.bytesWritten) return { ok: false, code: "failure" };
                  offset += result.bytesWritten;
                }
                return writeSignal?.aborted || cleaning ? { ok: false, code: "cancelled" } : { ok: true, value: undefined };
              } catch { return { ok: false, code: "failure" }; }
            }); },
            close() { return closed ??= track(() => closeHandle(opened)); },
          };
          return ok(writer);
        } catch (error) { if (handle) await closeHandle(handle); return fail(signal?.aborted ? "cancelled" : failure(error)); }
      }); },
      snapshot(signal) { return track(async () => {
        if (cleaning) return fail("closed");
        if (snapshotting) return fail("resource-limit");
        if (signal?.aborted) return fail("cancelled");
        snapshotting = true;
        const snapshotPath = join(path, `snapshot-${randomUUID()}.txt`);
        let input: native.FileHandle | undefined, output: native.FileHandle | undefined, snapshotOwner: Stats | undefined;
        const buffer = Buffer.alloc(CHUNK);
        let succeeded = false;
        try {
          await verifyDirectory(path, owner);
          input = await fs.open(documentPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          handles.add(input);
          const before = await input.stat();
          if (!before.isFile() || before.nlink !== 1) return fail("not-file");
          if (before.size > MAX_REMOTE_EDIT_BYTES) return fail("too-large");
          if (!same(before, await fs.lstat(documentPath))) return fail("local-changed");
          output = await fs.open(snapshotPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          handles.add(output);
          snapshotOwner = await output.stat();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const hash = createHash("sha256");
          let size = 0;
          while (true) {
            if (signal?.aborted || cleaning) return fail("cancelled");
            const { bytesRead } = await input.read(buffer, 0, CHUNK, size);
            if (!bytesRead) break;
            if (size + bytesRead > MAX_REMOTE_EDIT_BYTES) return fail("too-large");
            const bytes = buffer.subarray(0, bytesRead);
            try { if (bytes.includes(0)) return fail("invalid-text"); decoder.decode(bytes, { stream: true }); }
            catch { return fail("invalid-text"); }
            hash.update(bytes);
            let offset = 0;
            while (offset < bytesRead) {
              const result = await output.write(bytes, offset, bytesRead - offset, size + offset);
              if (!result.bytesWritten) return fail("failure");
              offset += result.bytesWritten;
            }
            size += bytesRead;
            buffer.fill(0);
          }
          try { decoder.decode(); } catch { return fail("invalid-text"); }
          if (!stable(before, await input.stat()) || !stable(before, await fs.lstat(documentPath)) || size !== before.size) return fail("local-changed");
          if (signal?.aborted || cleaning) return fail("cancelled");
          await output.chmod(0o400);
          snapshotOwner = await output.stat();
          if (!(await closeHandle(output)).ok) return fail("failure"); output = undefined;
          if (!(await closeHandle(input)).ok) return fail("failure"); input = undefined;
          let disposed = false;
          const ownership = snapshotOwner;
          const digest = hash.digest("hex");
          const snapshot: RemoteEditSnapshot = {
            size, sha256: digest,
            openRead(readSignal) { return track(async () => {
              if (disposed || cleaning) return fail("closed");
              if (readSignal?.aborted) return fail("cancelled");
              let handle: native.FileHandle | undefined;
              try {
                await verifyDirectory(path, owner);
                handle = await fs.open(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                handles.add(handle);
                const current = await handle.stat();
                if (!current.isFile() || current.nlink !== 1 || !stable(ownership, current) || !same(current, await fs.lstat(snapshotPath))) {
                  await closeHandle(handle); return fail("local-changed");
                }
                if (readSignal?.aborted || disposed || cleaning) { await closeHandle(handle); return fail("cancelled"); }
                return ok(reader(handle));
              } catch (error) { if (handle) await closeHandle(handle); return fail(readSignal?.aborted ? "cancelled" : failure(error)); }
            }); },
            dispose() { return track(async () => {
              if (disposed || cleaned) return ok(undefined);
              if (cleaning) return fail("cleanup-failed");
              try {
                await verifyDirectory(path, owner);
                const current = await fs.lstat(snapshotPath);
                if (!same(ownership, current) || !current.isFile()) return fail("cleanup-failed");
                await fs.unlink(snapshotPath); disposed = true; return ok(undefined);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") { disposed = true; return ok(undefined); }
                return fail("cleanup-failed");
              }
            }); },
          };
          succeeded = true;
          return ok(snapshot);
        } catch (error) { return fail(signal?.aborted ? "cancelled" : failure(error)); }
        finally {
          buffer.fill(0);
          if (input) await closeHandle(input);
          if (output) await closeHandle(output);
          if (!succeeded && snapshotOwner) {
            const current = await fs.lstat(snapshotPath).catch(() => undefined);
            if (current && same(current, snapshotOwner)) await fs.unlink(snapshotPath).catch(() => undefined);
          }
          snapshotting = false;
        }
      }); },
      cleanup() {
        if (cleaned) return Promise.resolve(ok(undefined));
        return cleanupPromise ??= (async () => {
          cleaning = true;
          try {
            await Promise.allSettled([...pending]);
            const closed = await Promise.all([...handles].map(closeHandle));
            if (closed.some((result) => !result.ok)) return fail<void>("cleanup-failed");
            await removeDirectory(path, id, owner);
            cleaned = true; live.delete(path);
            return ok(undefined);
          } catch { return fail<void>("cleanup-failed"); }
          finally { cleanupPromise = undefined; }
        })();
      },
    };
  }
  /** A failed initializer still owns its partial native resources. Returning this inert
   * workspace lets the service count and retry cleanup without granting document access. */
  function failedWorkspace(path: string, owner: Stats, markerOwner: Stats | undefined,
    markerHandle: native.FileHandle | undefined, code: RemoteEditFailure): RemoteEditWorkspace {
    let cleaned = false;
    let cleaning: Promise<RemoteEditIOResult<void>> | undefined;
    live.add(path);
    return {
      documentPath: join(path, "document.txt"),
      openWrite: async () => fail(code),
      snapshot: async () => fail(code),
      cleanup() {
        if (cleaned) return Promise.resolve(ok(undefined));
        return cleaning ??= (async () => {
          try {
            await verifyDirectory(path, owner);
            if (markerHandle) {
              // A failed stat/write/close can leave an actual handle; retain it until close succeeds.
              markerOwner ??= await markerHandle.stat();
              await markerHandle.close(); markerHandle = undefined;
            }
            const entries = await entriesBounded(path, 1);
            if (entries.some((entry) => entry !== MARKER)) return fail<void>("cleanup-failed");
            if (entries.includes(MARKER)) {
              if (!markerOwner) return fail<void>("cleanup-failed");
              const current = await fs.lstat(join(path, MARKER));
              if (!current.isFile() || !same(markerOwner, current)) return fail<void>("cleanup-failed");
              await fs.unlink(join(path, MARKER));
            }
            await verifyDirectory(path, owner);
            await fs.rmdir(path);
            cleaned = true; live.delete(path);
            return ok(undefined);
          } catch { return fail<void>("cleanup-failed"); }
          finally { cleaning = undefined; }
        })();
      },
    };
  }
  return {
    async create(signal) {
      if (signal?.aborted) return fail("cancelled");
      let path: string | undefined, owner: Stats | undefined, markerOwner: Stats | undefined;
      let markerHandle: native.FileHandle | undefined;
      try {
        await ensureRoot();
        if (signal?.aborted) return fail("cancelled");
        const id = randomUUID(); path = join(root, `edit-${id}`);
        await fs.mkdir(path, { mode: 0o700 }); owner = await fs.lstat(path);
        markerHandle = await fs.open(join(path, MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        markerOwner = await markerHandle.stat();
        await markerHandle.writeFile(markerText(id));
        await markerHandle.close(); markerHandle = undefined;
        const result = workspace(path, id, owner); live.add(path);
        if (signal?.aborted) {
          const cleaned = await result.cleanup();
          if (cleaned.ok) return fail("cancelled");
          return ok({ documentPath: result.documentPath,
            openWrite: async () => fail("cancelled"), snapshot: async () => fail("cancelled"),
            cleanup: () => result.cleanup() });
        }
        return ok(result);
      } catch (error) {
        const code = signal?.aborted ? "cancelled" : failure(error);
        if (path && owner) {
          const retained = failedWorkspace(path, owner, markerOwner, markerHandle, code);
          if (!(await retained.cleanup()).ok) return ok(retained);
        } else if (markerHandle) {
          // No directory ownership means no deletion authority; never swallow a live handle.
          await markerHandle.close().catch(() => undefined);
        }
        return fail(code);
      }
    },
    async prune() {
      try {
        await ensureRoot();
        const entries = await entriesBounded(root, 128);
        if (entries.length > 128) return fail("cleanup-failed");
        let failed = false;
        for (const name of entries) {
          const match = EDIT_NAME.exec(name), path = join(root, name);
          if (!match) { failed = true; continue; }
          if (live.has(path)) continue;
          try { await removeDirectory(path, match[1]!, await fs.lstat(path)); }
          catch { failed = true; }
        }
        return failed ? fail("cleanup-failed") : ok(undefined);
      } catch { return fail("cleanup-failed"); }
    },
  };
}
