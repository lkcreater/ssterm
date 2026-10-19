import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as native from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { FileRecordStore } from './record-file.ts';

/**
 * SST-034: the confined, private `userData/recordings` directory. Knows names, identities and bytes only; the file
 * format and keys belong to the recorder. Unknown, linked or foreign entries are never listed, read or removed.
 * Node lacks directory-relative, inode-conditional unlink: like remote-edit-temp, the private profile must be trusted
 * against malicious same-UID mutation between an identity check and the native call.
 */
export const RECORDINGS_ROOT = 'recordings';
export const RECORDING_NAME = /^(out|cmd)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(part|ssr)$/u;
const MARKER = '.ssterm-recordings';
const MARKER_TEXT = 'ssterm-recordings-v1\n';
/** More entries than this and the directory is treated as unsafe: capture fails closed and nothing is deleted. */
const MAX_ENTRIES = 16_384;
export interface FileIdentity { dev: number; ino: number }
export interface RecordingFileInfo extends FileIdentity { name: string; size: number }
export interface RecordingSink {
  readonly identity: FileIdentity;
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface RecordingSource {
  readonly size: number;
  /** Fewer bytes than asked only at end of file. */
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface RecordingFiles {
  /** Creates or verifies the private root and its marker; false means unsafe, and capture must fail closed. */
  open(): Promise<boolean>;
  /** Regular, private, single-link files with recording names; undefined when the root is unsafe. */
  list(): Promise<RecordingFileInfo[] | undefined>;
  /** O_CREAT | O_EXCL | O_NOFOLLOW, mode 0600. */
  create(name: string): Promise<RecordingSink>;
  read(name: string): Promise<RecordingSource>;
  /** Renames only the same file (dev/ino) to another recording name. */
  rename(from: string, to: string, identity: FileIdentity): Promise<void>;
  /** Unlinks only the same file; a missing file counts as removed. */
  remove(name: string, identity: FileIdentity): Promise<boolean>;
  readPolicy(): Promise<unknown>;
  writePolicy(value: unknown): Promise<boolean>;
  /**
   * Streams plaintext into an exclusive 0600 stage next to `destination` and renames it over the destination only
   * when `produce` returns true and `stillValid` allows dispatch of the native rename after all staging awaits.
   * The stage is removed on abort or failure. `destination` comes from a native save
   * dialog, which already confirmed any replacement.
   */
  exportTo(destination: string, produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<boolean>, stillValid: () => boolean): Promise<'saved' | 'aborted' | 'failed'>;
}
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
const isPrivate = (s: Stats) => (s.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || s.uid === process.getuid());
const named = (name: string) => {
  if (!RECORDING_NAME.test(name)) throw new Error('invalid recording name');
  return name;
};

export function createRecordingFiles(options: { root: string; io?: Partial<typeof native> }): RecordingFiles {
  const fs = { ...native, ...options.io };
  const root = options.root;
  const policy = new FileRecordStore(join(root, 'policy.json'));
  let owner: Stats | undefined;
  async function ensureRoot(): Promise<void> {
    if (!isAbsolute(root) || basename(root) !== RECORDINGS_ROOT) throw new Error('invalid root');
    try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || !isPrivate(stat) || (owner && !same(stat, owner))) throw new Error('unsafe root');
    owner ??= stat;
  }
  async function file(name: string): Promise<Stats> {
    await ensureRoot();
    const stat = await fs.lstat(join(root, named(name)));
    if (!stat.isFile() || stat.nlink !== 1 || !isPrivate(stat)) throw new Error('unsafe entry');
    return stat;
  }
  async function marker(): Promise<void> {
    const path = join(root, MARKER);
    try {
      await fs.writeFile(path, MARKER_TEXT, { mode: 0o600, flag: 'wx' });
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      const text = await handle.readFile('utf8');
      if (!stat.isFile() || stat.nlink !== 1 || !isPrivate(stat) || text !== MARKER_TEXT) throw new Error('foreign marker');
    } finally { await handle.close(); }
  }
  return {
    async open() {
      try { await ensureRoot(); await marker(); return true; } catch { return false; }
    },
    async list() {
      try {
        await ensureRoot();
        const directory = await fs.opendir(root);
        const names: string[] = [];
        try {
          for (let entry = await directory.read(); entry; entry = await directory.read()) {
            if (names.length >= MAX_ENTRIES) return undefined;
            if (RECORDING_NAME.test(entry.name)) names.push(entry.name);
          }
        } finally { await directory.close(); }
        const files: RecordingFileInfo[] = [];
        for (const name of names) {
          const stat = await fs.lstat(join(root, name)).catch(() => undefined);
          if (stat?.isFile() && stat.nlink === 1 && isPrivate(stat)) files.push({ name, size: stat.size, dev: stat.dev, ino: stat.ino });
        }
        return files;
      } catch { return undefined; }
    },
    async create(name) {
      await ensureRoot();
      const handle = await fs.open(join(root, named(name)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stat = await handle.stat();
      return {
        identity: { dev: stat.dev, ino: stat.ino },
        async write(bytes) {
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new Error('short write');
            offset += bytesWritten;
          }
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    async read(name) {
      const expected = await file(name);
      const handle = await fs.open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!same(stat, expected) || !stat.isFile()) throw new Error('changed entry');
        return {
          size: stat.size,
          async read(position, length) {
            const buffer = Buffer.alloc(length);
            let filled = 0;
            while (filled < length) {
              const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
              if (!bytesRead) break;
              filled += bytesRead;
            }
            return buffer.subarray(0, filled);
          },
          close: () => handle.close(),
        };
      } catch (error) { await handle.close(); throw error; }
    },
    async rename(from, to, identity) {
      const stat = await file(from);
      if (!same(stat, identity)) throw new Error('changed entry');
      await fs.rename(join(root, from), join(root, named(to)));
    },
    async remove(name, identity) {
      try {
        const stat = await file(name);
        if (!same(stat, identity)) return false;
        await fs.unlink(join(root, name));
        return true;
      } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    },
    async readPolicy() {
      try {
        await ensureRoot();
        const read = await policy.read();
        return read.status === 'present' ? JSON.parse(Buffer.from(read.value).toString('utf8')) : undefined;
      } catch { return undefined; }
    },
    async writePolicy(value) {
      try {
        await ensureRoot();
        return await policy.write(Buffer.from(JSON.stringify(value), 'utf8')) === 'confirmed';
      } catch { return false; }
    },
    async exportTo(destination, produce, stillValid) {
      if (!isAbsolute(destination) || destination.includes('\0') || Buffer.byteLength(destination) > 4096) return 'failed';
      const stage = join(dirname(destination), `.ssterm-export-${randomUUID()}.part`);
      let handle: native.FileHandle | undefined;
      let staged: Stats | undefined;
      let outcome: 'saved' | 'aborted' | 'failed' = 'failed';
      try {
        handle = await fs.open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        staged = await handle.stat();
        const opened = handle;
        const finished = await produce(async (bytes) => {
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await opened.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new Error('short write');
            offset += bytesWritten;
          }
        });
        if (!finished) { outcome = 'aborted'; return outcome; }
        await handle.sync();
        await handle.close();
        handle = undefined;
        const current = await fs.lstat(stage);
        if (!same(current, staged)) return outcome;
        if (!stillValid()) { outcome = 'aborted'; return outcome; }
        await fs.rename(stage, destination);
        staged = undefined;
        outcome = 'saved';
        return outcome;
      } catch { return outcome; } finally {
        await handle?.close().catch(() => undefined);
        // Plaintext never stays behind: the stage goes on abort, failure or a lock.
        if (staged) {
          const current = await fs.lstat(stage).catch(() => undefined);
          if (current && same(current, staged)) await fs.unlink(stage).catch(() => undefined);
        }
      }
    },
  };
}
