import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalFiles } from "../../packages/adapters/src/local-files.ts";
import { attributes } from "../../packages/adapters/src/sftp.ts";
import type { SftpResult } from "../../packages/domain/src/index.ts";

let raw = "", root = "";
before(async () => {
  raw = await mkdtemp(join(tmpdir(), "ssterm-local-files-"));
  root = await realpath(raw);
});
after(async () => {
  await chmod(join(root, "locked"), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});
const value = <T>(result: SftpResult<T>): T => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };
const code = (result: SftpResult<unknown>) => (result.ok ? "ok" : result.code);

test("NFD, odd-order Thai and emoji names list verbatim and are stat-able by the listed name", async () => {
  const files = createLocalFiles(root);
  const dir = join(root, "unicode");
  await mkdir(dir);
  const nfd = "café";
  const thai = "กุ่"; // mai ek before sara u: not canonical order, so NFC would reorder it
  const emoji = "👩‍💻 notes";
  assert.notEqual(thai.normalize("NFC"), thai);
  for (const name of [nfd, thai, emoji]) await writeFile(join(dir, name), "x");
  const listing = value(await files.list(dir));
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), [nfd, thai, emoji].sort());
  assert.deepEqual([listing.truncated, listing.skipped], [false, 0]);
  for (const entry of listing.entries) {
    assert.deepEqual([entry.addressable, entry.type, entry.size, entry.permissions !== null], [true, "file", 1, true]);
    assert.ok(Number.isSafeInteger(entry.mtime));
    assert.equal(value(await files.stat(join(dir, entry.name))).type, "file", entry.name);
  }
});

test("symlinks list as links; stat follows them and broken or looping links are not-found", async () => {
  const files = createLocalFiles(root);
  const dir = join(root, "links");
  await mkdir(join(dir, "target"), { recursive: true });
  await writeFile(join(dir, "file.txt"), "abc");
  await symlink("target", join(dir, "link-dir"));
  await symlink("file.txt", join(dir, "link-file"));
  await symlink("missing", join(dir, "dangling"));
  await symlink("loop-b", join(dir, "loop-a"));
  await symlink("loop-a", join(dir, "loop-b"));
  const types = Object.fromEntries(value(await files.list(dir)).entries.map((entry) => [entry.name, entry.type]));
  assert.deepEqual(types, { target: "directory", "file.txt": "file", "link-dir": "symlink", "link-file": "symlink",
    dangling: "symlink", "loop-a": "symlink", "loop-b": "symlink" });
  assert.equal(value(await files.stat(join(dir, "link-dir"))).type, "directory");
  assert.equal(value(await files.stat(join(dir, "link-file"))).size, 3);
  assert.equal(value(await files.lstat(join(dir, "link-file"))).type, "symlink");
  assert.equal(code(await files.stat(join(dir, "dangling"))), "not-found");
  assert.equal(code(await files.stat(join(dir, "loop-a"))), "not-found");
  assert.equal(code(await files.list(join(dir, "loop-a"))), "not-found");
  assert.equal(value(await files.realpath(join(dir, "link-dir"))), join(dir, "target"));
  assert.equal(value(await files.list(join(dir, "link-dir"))).entries.length, 0, "a link to a directory lists its target");
});

test("errno maps to fixed codes: ENOTDIR, ENAMETOOLONG, over-long paths and permissions", async (t) => {
  const files = createLocalFiles(root);
  await writeFile(join(root, "plain"), "");
  assert.equal(code(await files.list(join(root, "plain"))), "not-found", "ENOTDIR");
  assert.equal(code(await files.stat(join(root, "plain", "child"))), "not-found", "ENOTDIR");
  assert.equal(code(await files.stat(join(root, "missing"))), "not-found");
  assert.equal(code(await files.stat(join(root, "a".repeat(256)))), "invalid-path", "ENAMETOOLONG");
  assert.equal(code(await files.stat("/" + "ก".repeat(2_000))), "invalid-request", "over 4,096 UTF-8 bytes never reaches the filesystem");
  for (const path of ["relative", "", "/a\0b"]) assert.equal(code(await files.list(path)), "invalid-request");
  const aborted = AbortSignal.abort();
  assert.equal(code(await files.list(root, aborted)), "cancelled");

  if (process.getuid?.() === 0) { t.skip("root ignores permission bits"); return; }
  await mkdir(join(root, "locked"));
  await writeFile(join(root, "locked", "inside"), "");
  await chmod(join(root, "locked"), 0o000);
  assert.equal(code(await files.list(join(root, "locked"))), "permission-denied");
  assert.equal(code(await files.stat(join(root, "locked", "inside"))), "permission-denied");
  assert.equal(value(await files.lstat(join(root, "locked"))).permissions, 0, "the directory itself is still visible");
});

test("a FIFO lists as other and unsafe numbers become null", async () => {
  const files = createLocalFiles(root);
  const dir = join(root, "special");
  await mkdir(dir);
  execFileSync("mkfifo", [join(dir, "pipe")]);
  assert.deepEqual(value(await files.list(dir)).entries.map((entry) => entry.type), ["other"]);
  assert.deepEqual(attributes({ mode: 0o100644, size: 2 ** 53, mtime: -1 }), { type: "file", size: null, mtime: null, permissions: 0o644 });
});

test("listing stops at 10,000 names and reports truncation", async () => {
  const files = createLocalFiles(root);
  const dir = join(root, "big");
  await mkdir(dir);
  for (let start = 0; start < 10_050; start += 500)
    await Promise.all(Array.from({ length: Math.min(500, 10_050 - start) }, (_, i) => writeFile(join(dir, `file-${String(start + i).padStart(5, "0")}`), "")));
  const listing = value(await files.list(dir));
  assert.equal(listing.entries.length, 10_000);
  assert.equal(listing.truncated, true);
  assert.equal(listing.skipped, 0);
  assert.ok(listing.entries.every((entry) => entry.type === "file"));
  assert.equal(new Set(listing.entries.map((entry) => entry.name)).size, 10_000, "the lstat workers fill every slot once");

  // Main aborts a timed-out operation: the listing stops between steps instead of finishing its lstats.
  const abort = new AbortController();
  const pending = files.list(dir, abort.signal);
  abort.abort();
  assert.equal(code(await pending), "cancelled");
});

test("home defaults to the user's home directory; realpath resolves through /tmp-style links", async () => {
  assert.equal(createLocalFiles().home, homedir());
  assert.equal(createLocalFiles("relative").home, "/", "an unusable home falls back to /");
  const files = createLocalFiles(root);
  assert.equal(files.home, root);
  assert.equal(value(await files.realpath(join(raw, ".", "unicode", ".."))), root);
});
