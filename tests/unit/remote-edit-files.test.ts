import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRemoteEditFiles } from "../../packages/adapters/src/remote-edit-files.ts";
import { createRemoteEditEditor } from "../../packages/adapters/src/remote-edit-editor.ts";
import { MAX_REMOTE_EDIT_BYTES, type RemoteEditWorkspace, type RemoteEditIOResult } from "@ssterm/domain";

function value<T>(result: RemoteEditIOResult<T>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "ssterm-edit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, root: join(dir, "remote-edit-temp") };
}
async function write(workspace: RemoteEditWorkspace, text: string | Uint8Array) {
  const writer = value(await workspace.openWrite());
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  for (let offset = 0; offset < bytes.length; offset += 65_536) assert((await writer.write(offset, bytes.subarray(offset, offset + 65_536))).ok);
  assert((await writer.close()).ok);
}
async function text(workspace: RemoteEditWorkspace) {
  const snapshot = value(await workspace.snapshot());
  const reader = value(await snapshot.openRead());
  const chunks: Uint8Array[] = [];
  for (let position = 0; ; ) {
    const chunk = value(await reader.read(position, 65_536));
    if (!chunk) break;
    chunks.push(chunk); position += chunk.length;
  }
  assert((await reader.close()).ok);
  assert((await snapshot.dispose()).ok);
  return Buffer.concat(chunks).toString("utf8");
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("remote editing creates private marked copies, bounded exclusive writer and immutable UTF8 snapshot", async (t) => {
  const { root } = await fixture(t);
  const files = createRemoteEditFiles({ root });
  const workspace = value(await files.create());
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(dirname(workspace.documentPath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(dirname(workspace.documentPath), ".ssterm-remote-edit"))).mode & 0o777, 0o600);
  const writer = value(await workspace.openWrite());
  assert.equal((await fs.stat(workspace.documentPath)).mode & 0o777, 0o600);
  assert(!(await workspace.openWrite()).ok);
  assert.deepEqual(await writer.write(0, new Uint8Array(65_537)), { ok: false, code: "invalid-request" });
  assert.deepEqual(await writer.write(MAX_REMOTE_EDIT_BYTES, new Uint8Array([1])), { ok: false, code: "invalid-request" });
  assert((await writer.write(0, Buffer.from("ไทย\noriginal"))).ok);
  assert((await writer.close()).ok);
  assert((await writer.close()).ok);
  const snapshot = value(await workspace.snapshot());
  assert.equal(snapshot.sha256, createHash("sha256").update("ไทย\noriginal").digest("hex"));
  const snapshotFile = (await fs.readdir(dirname(workspace.documentPath))).find((name) => name.startsWith("snapshot-"))!;
  assert.equal((await fs.stat(join(dirname(workspace.documentPath), snapshotFile))).mode & 0o777, 0o400);
  await fs.writeFile(workspace.documentPath, "new save");
  const reader = value(await snapshot.openRead());
  const first = value(await reader.read(0, 65_536)); assert(first);
  assert.equal(Buffer.from(first).toString(), "ไทย\noriginal");
  assert.deepEqual(await reader.read(0, 65_537), { ok: false, code: "invalid-request" });
  assert((await reader.close()).ok);
  assert((await snapshot.dispose()).ok);
  assert((await snapshot.dispose()).ok);
  assert.deepEqual(await snapshot.openRead(), { ok: false, code: "closed" });
  assert((await workspace.cleanup()).ok);
  assert((await workspace.cleanup()).ok);
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "closed" });
});

test("stable atomic editor replacement is accepted and a snapshot preserves its exact bytes", async (t) => {
  const { root, dir } = await fixture(t);
  const workspace = value(await createRemoteEditFiles({ root }).create());
  await write(workspace, "old");
  const replacement = join(dir, "replacement");
  await fs.writeFile(replacement, "saved atomically ไทย", { mode: 0o600 });
  await fs.rename(replacement, workspace.documentPath);
  assert.equal(await text(workspace), "saved atomically ไทย");
  assert((await workspace.cleanup()).ok);
});

test("text validation handles UTF8 split across chunks and rejects malformed, NUL and oversized documents", async (t) => {
  const { root } = await fixture(t);
  const workspace = value(await createRemoteEditFiles({ root }).create());
  await write(workspace, `${"a".repeat(65_535)}ไทย`);
  assert.equal((await text(workspace)).length, 65_538);
  for (const bytes of [Buffer.from([0xc3]), Buffer.from("binary\0text"), Buffer.from([0xff])]) {
    await fs.writeFile(workspace.documentPath, bytes);
    assert.deepEqual(await workspace.snapshot(), { ok: false, code: "invalid-text" });
    assert.equal((await fs.readdir(dirname(workspace.documentPath))).filter((name) => name.startsWith("snapshot-")).length, 0);
  }
  await fs.truncate(workspace.documentPath, MAX_REMOTE_EDIT_BYTES + 1);
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "too-large" });
  assert((await workspace.cleanup()).ok);
});

test("working file symlinks, directories and hard links are refused without following outside paths", async (t) => {
  const { root, dir } = await fixture(t);
  const workspace = value(await createRemoteEditFiles({ root }).create());
  const outside = join(dir, "outside"); await fs.writeFile(outside, "preserve me");
  await fs.symlink(outside, workspace.documentPath);
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "not-file" });
  assert.equal(await fs.readFile(outside, "utf8"), "preserve me");
  await fs.unlink(workspace.documentPath);
  await fs.mkdir(workspace.documentPath);
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "not-file" });
  await fs.rmdir(workspace.documentPath);
  await fs.link(outside, workspace.documentPath);
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "not-file" });
  await fs.unlink(workspace.documentPath);
  assert((await workspace.cleanup()).ok);
});

test("snapshot detects atomic replacement during a read and refuses approval of stale bytes", async (t) => {
  const { root, dir } = await fixture(t);
  let documentPath = "", mutated = false;
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] === documentPath) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (!mutated) {
            mutated = true;
            const replacement = join(dir, "atomic-save");
            await fs.writeFile(replacement, "after save", { mode: 0o600 });
            await fs.rename(replacement, documentPath);
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.open,
  };
  const workspace = value(await createRemoteEditFiles({ root, io }).create()); documentPath = workspace.documentPath;
  await write(workspace, "before save");
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "local-changed" });
  assert.equal(await fs.readFile(documentPath, "utf8"), "after save");
  assert((await workspace.cleanup()).ok);
});

test("cleanup waits for a late native open, closes the handle and prevents writes after cancellation", async (t) => {
  const { root } = await fixture(t);
  const entered = gate(), finish = gate();
  const controller = new AbortController();
  let observedHandle: fs.FileHandle | undefined;
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/document.txt")) {
        entered.release(); await finish.promise;
        observedHandle = await fs.open(...args); return observedHandle;
      }
      return fs.open(...args);
    }) as typeof fs.open,
  };
  const workspace = value(await createRemoteEditFiles({ root, io }).create());
  const opening = workspace.openWrite(controller.signal);
  await entered.promise; controller.abort();
  let settled = false;
  const cleaning = workspace.cleanup().then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  finish.release();
  assert.deepEqual(await opening, { ok: false, code: "cancelled" });
  assert((await cleaning).ok);
  assert(observedHandle); await assert.rejects(observedHandle.stat());
  assert.deepEqual(await fs.readdir(root), []);
});

test("aborted operations do no native work, cleanup errors remain retriable and unknown files are preserved", async (t) => {
  const { root } = await fixture(t);
  const files = createRemoteEditFiles({ root });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await files.create(abort.signal), { ok: false, code: "cancelled" });
  await assert.rejects(fs.stat(root));
  const workspace = value(await files.create());
  assert.deepEqual(await workspace.openWrite(abort.signal), { ok: false, code: "cancelled" });
  await write(workspace, "private");
  assert.deepEqual(await workspace.snapshot(abort.signal), { ok: false, code: "cancelled" });
  const unrelated = join(dirname(workspace.documentPath), "user-keeps-this"); await fs.writeFile(unrelated, "keep");
  assert.deepEqual(await workspace.cleanup(), { ok: false, code: "cleanup-failed" });
  assert.equal(await fs.readFile(unrelated, "utf8"), "keep");
  assert.equal(await fs.readFile(workspace.documentPath, "utf8"), "private");
  await fs.unlink(unrelated);
  assert((await workspace.cleanup()).ok);
});

test("startup prune removes only private marked orphan namespaces and leaves live/unmarked/symlink entries intact", async (t) => {
  const { root, dir } = await fixture(t);
  const files = createRemoteEditFiles({ root });
  const orphan = value(await files.create()); await write(orphan, "orphan"); value(await orphan.snapshot());
  const live = value(await files.create()); await write(live, "live");
  assert((await files.prune()).ok);
  assert.equal(await fs.readFile(live.documentPath, "utf8"), "live");
  const outside = join(dir, "outside"); await fs.mkdir(outside); await fs.writeFile(join(outside, "keep"), "safe");
  const other = "edit-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await fs.mkdir(join(root, other), { mode: 0o700 });
  await fs.symlink(outside, join(root, "edit-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  const restarted = createRemoteEditFiles({ root });
  assert.deepEqual(await restarted.prune(), { ok: false, code: "cleanup-failed" });
  await assert.rejects(fs.stat(orphan.documentPath));
  await assert.rejects(fs.stat(live.documentPath));
  assert((await fs.stat(join(root, other))).isDirectory());
  assert.equal(await fs.readFile(join(outside, "keep"), "utf8"), "safe");
});

test("snapshot read rejects a substituted snapshot pathname and cleanup refuses a substituted workspace", async (t) => {
  const { root, dir } = await fixture(t);
  const workspace = value(await createRemoteEditFiles({ root }).create()); await write(workspace, "approved");
  const snapshot = value(await workspace.snapshot());
  const directory = dirname(workspace.documentPath);
  const snapshotFile = (await fs.readdir(directory)).find((name) => name.startsWith("snapshot-"))!;
  await fs.rename(join(directory, snapshotFile), join(dir, "original"));
  await fs.writeFile(join(directory, snapshotFile), "substitute");
  assert.deepEqual(await snapshot.openRead(), { ok: false, code: "local-changed" });
  assert.deepEqual(await snapshot.dispose(), { ok: false, code: "cleanup-failed" });
  await fs.rename(directory, join(dir, "original-workspace"));
  await fs.mkdir(directory, { mode: 0o700 }); await fs.writeFile(join(directory, "keep"), "unrelated");
  assert.deepEqual(await workspace.cleanup(), { ok: false, code: "cleanup-failed" });
  assert.equal(await fs.readFile(join(directory, "keep"), "utf8"), "unrelated");
});

test("root symlinks and roots accessible to other users are refused", async (t) => {
  const { root, dir } = await fixture(t);
  const outside = join(dir, "outside"); await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, root);
  assert(!(await createRemoteEditFiles({ root }).create()).ok);
  await fs.unlink(root); await fs.mkdir(root, { mode: 0o755 }); await fs.chmod(root, 0o755);
  assert(!(await createRemoteEditFiles({ root }).create()).ok);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("editor launches only fixed TextEdit argv through an injected owned process, redacts errors and cancels", async (t) => {
  const { root } = await fixture(t);
  const workspace = value(await createRemoteEditFiles({ root }).create()); await write(workspace, "before");
  let count = 0;
  const editor = createRemoteEditEditor({ platform: "darwin", async launch(binary, args, options) {
    count++;
    assert.equal(binary, "/usr/bin/open"); assert.deepEqual(args, ["-e", workspace.documentPath]); assert.equal(options.timeout, 10_000);
    // This owned child models an external editor save; it never opens the user's TextEdit.
    await new Promise<void>((resolve, reject) => execFile(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'fixture saved ไทย')", args[1]!],
      { signal: options.signal }, (error) => error ? reject(error) : resolve()));
  } });
  assert((await editor.open(workspace.documentPath)).ok);
  assert.equal(await text(workspace), "fixture saved ไทย");
  assert.deepEqual(await editor.open("/tmp/untrusted.sh"), { ok: false, code: "invalid-request" });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await editor.open(workspace.documentPath, controller.signal), { ok: false, code: "cancelled" });
  assert.equal(count, 1);
  assert.deepEqual(await createRemoteEditEditor({ platform: "linux", launch: async () => { throw new Error("must not launch"); } }).open(workspace.documentPath), { ok: false, code: "unsupported" });
  assert.deepEqual(await createRemoteEditEditor({ platform: "darwin", launch: async () => { throw new Error("SECRET contents or local path"); } }).open(workspace.documentPath), { ok: false, code: "editor-unavailable" });
  assert((await workspace.cleanup()).ok);
});

test("in-place editor mutation with restored mtime is detected by content-copy ownership checks", async (t) => {
  const { root } = await fixture(t);
  let documentPath = "", mutated = false;
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] === documentPath) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (!mutated) {
            mutated = true;
            const before = await fs.stat(documentPath);
            await fs.writeFile(documentPath, "changed bytes");
            await fs.utimes(documentPath, before.atime, before.mtime);
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.open,
  };
  const workspace = value(await createRemoteEditFiles({ root, io }).create()); documentPath = workspace.documentPath;
  await write(workspace, "initial bytes");
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "local-changed" });
  assert((await workspace.cleanup()).ok);
});

test("only one native snapshot runs per workspace and cleanup waits for a cancelled copy", async (t) => {
  const { root } = await fixture(t);
  const entered = gate(), release = gate();
  let documentPath = "";
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] === documentPath) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          entered.release(); await release.promise;
          return read(...readArgs);
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.open,
  };
  const workspace = value(await createRemoteEditFiles({ root, io }).create()); documentPath = workspace.documentPath;
  await write(workspace, "cancel this copy");
  const controller = new AbortController();
  const copying = workspace.snapshot(controller.signal); await entered.promise;
  assert.deepEqual(await workspace.snapshot(), { ok: false, code: "resource-limit" });
  controller.abort();
  let cleaned = false;
  const cleanup = workspace.cleanup().then((result) => { cleaned = true; return result; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(cleaned, false);
  release.release();
  assert.deepEqual(await copying, { ok: false, code: "cancelled" });
  assert((await cleanup).ok);
  assert.deepEqual(await fs.readdir(root), []);
});

test("startup cleanup does not traverse a valid-looking edit directory with an untrusted marker", async (t) => {
  const { root, dir } = await fixture(t);
  await fs.mkdir(root, { mode: 0o700 });
  const edit = join(root, "edit-cccccccc-cccc-4ccc-8ccc-cccccccccccc"); await fs.mkdir(edit, { mode: 0o700 });
  const outside = join(dir, "outside"); await fs.writeFile(outside, "preserve marker target");
  await fs.symlink(outside, join(edit, ".ssterm-remote-edit"));
  await fs.writeFile(join(edit, "document.txt"), "preserve document");
  assert.deepEqual(await createRemoteEditFiles({ root }).prune(), { ok: false, code: "cleanup-failed" });
  assert.equal(await fs.readFile(outside, "utf8"), "preserve marker target");
  assert.equal(await fs.readFile(join(edit, "document.txt"), "utf8"), "preserve document");
});

test("failed marker initialization retains an inert cleanup capability when unlink initially fails", async (t) => {
  const { root } = await fixture(t);
  let blockCleanup = true;
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith("/.ssterm-remote-edit")) {
        handle.writeFile = async () => { throw Object.assign(new Error("marker initialization failed"), { code: "ENOSPC" }); };
      }
      return handle;
    }) as typeof fs.open,
    unlink: async (path) => {
      if (blockCleanup) throw Object.assign(new Error("cleanup blocked"), { code: "EACCES" });
      return fs.unlink(path);
    },
  };
  const files = createRemoteEditFiles({ root, io });
  const retained = value(await files.create());
  assert.deepEqual(await retained.openWrite(), { ok: false, code: "no-space" });
  assert.deepEqual(await retained.snapshot(), { ok: false, code: "no-space" });
  assert.deepEqual(await retained.cleanup(), { ok: false, code: "cleanup-failed" });
  assert.equal((await fs.readdir(root)).length, 1);
  // Prune cannot claim this live initialization failure; the service retains its exact capability.
  assert((await files.prune()).ok);
  blockCleanup = false;
  assert((await retained.cleanup()).ok);
  assert.deepEqual(await fs.readdir(root), []);
  assert((await retained.cleanup()).ok);
});

test("failed initializer retains directory ownership after marker unlink but failed rmdir", async (t) => {
  const { root } = await fixture(t);
  let blockCleanup = true;
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith("/.ssterm-remote-edit")) {
        handle.writeFile = async () => { throw Object.assign(new Error("marker failed"), { code: "ENOSPC" }); };
      }
      return handle;
    }) as typeof fs.open,
    rmdir: (async (...args: Parameters<typeof fs.rmdir>) => {
      if (blockCleanup) throw Object.assign(new Error("directory removal blocked"), { code: "EACCES" });
      return fs.rmdir(...args);
    }) as typeof fs.rmdir,
  };
  const retained = value(await createRemoteEditFiles({ root, io }).create());
  assert.deepEqual(await retained.openWrite(), { ok: false, code: "no-space" });
  assert.deepEqual(await fs.readdir(dirname(retained.documentPath)), []);
  assert.deepEqual(await retained.cleanup(), { ok: false, code: "cleanup-failed" });
  blockCleanup = false;
  assert((await retained.cleanup()).ok);
  assert.deepEqual(await fs.readdir(root), []);
});

test("cancelled creation retains a cleanup-only workspace when inline cleanup fails", async (t) => {
  const { root } = await fixture(t);
  const controller = new AbortController();
  let blockCleanup = true;
  const io: Partial<typeof fs> = {
    open: (async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith("/.ssterm-remote-edit")) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); controller.abort(); };
      }
      return handle;
    }) as typeof fs.open,
    unlink: async (path) => {
      if (blockCleanup) throw Object.assign(new Error("cleanup blocked"), { code: "EACCES" });
      return fs.unlink(path);
    },
  };
  const retained = value(await createRemoteEditFiles({ root, io }).create(controller.signal));
  assert.deepEqual(await retained.openWrite(), { ok: false, code: "cancelled" });
  assert.deepEqual(await retained.snapshot(), { ok: false, code: "cancelled" });
  assert.deepEqual(await retained.cleanup(), { ok: false, code: "cleanup-failed" });
  blockCleanup = false;
  assert((await retained.cleanup()).ok);
  assert.deepEqual(await fs.readdir(root), []);
});
