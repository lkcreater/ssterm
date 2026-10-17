import assert from "node:assert/strict";
import { test } from "node:test";
import { access, link, lstat, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createLocalTransferFiles } from "../../packages/adapters/src/local-transfers.ts";

async function stage(files: ReturnType<typeof createLocalTransferFiles>, path: string, data: string) {
  const opened = await files.openWrite(path, { mode: 0o600 }); assert(opened.ok);
  assert((await opened.value.write(0, Buffer.from(data))).ok);
  assert((await opened.value.close()).ok);
}

test("local transfer files preserve existing destinations and use private exclusive writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-transfer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles();
  const path = join(dir, "new");
  const opened = await files.openWrite(path, { mode: 0o600 });
  assert(opened.ok);
  assert.deepEqual(await opened.value.write(0, Buffer.from("ไทย")), { ok: true, value: undefined });
  assert.deepEqual(await opened.value.close(), { ok: true, value: undefined });
  assert.deepEqual(await opened.value.close(), { ok: true, value: undefined });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await files.openWrite(path, { mode: 0o600 }), { ok: false, code: "destination-exists" });
  assert.equal(await readFile(path, "utf8"), "ไทย");
  assert.deepEqual(await files.openWrite(join(dir, "bad-mode"), { mode: 0o777 }), { ok: false, code: "invalid-request" });
});

test("local transfer reads stop at actual EOF, reject selected links/directories/FIFOs, and honor cancellation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-transfer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles();
  const path = join(dir, "source");
  await writeFile(path, "abc");
  await symlink(path, join(dir, "link"));
  await mkdir(join(dir, "folder"));
  execFileSync("mkfifo", [join(dir, "pipe")]);
  for (const name of ["link", "folder", "pipe"]) assert.deepEqual(await files.openRead(join(dir, name)), { ok: false, code: "not-file" });
  const opened = await files.openRead(path);
  assert(opened.ok);
  const read = await opened.value.read(0, 10);
  assert(read.ok && read.value);
  assert.equal(Buffer.from(read.value).toString(), "abc");
  assert.deepEqual(await opened.value.read(3, 10), { ok: true, value: null });
  assert.deepEqual(await opened.value.read(0, 65_537), { ok: false, code: "invalid-request" });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await files.openRead(path, controller.signal), { ok: false, code: "cancelled" });
  assert.deepEqual(await opened.value.read(0, 10, controller.signal), { ok: false, code: "cancelled" });
  await opened.value.close();
  assert.deepEqual(await opened.value.read(0, 10), { ok: false, code: "closed" });
});

test("local publication never replaces a new target without consent and atomically replaces with consent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles();
  assert.equal(files.atomicReplace, true);
  const staged = join(dir, ".ssterm-owned.part"), final = join(dir, "final");
  await stage(files, staged, "new full data");
  await writeFile(final, "old unrelated data");
  assert.deepEqual(await files.publish(staged, final, { replace: false }), { ok: false, code: "destination-exists" });
  assert.equal(await readFile(final, "utf8"), "old unrelated data");
  assert.equal(await readFile(staged, "utf8"), "new full data");
  assert.deepEqual(await files.publish(staged, final, { replace: true }), { ok: true, value: { retainedPartial: false } });
  assert.equal(await readFile(final, "utf8"), "new full data");
  await assert.rejects(access(staged));
  await stage(files, staged, "fresh data");
  assert.deepEqual(await files.publish(staged, join(dir, "fresh"), { replace: false }), { ok: true, value: { retainedPartial: false } });
  assert.equal(await readFile(join(dir, "fresh"), "utf8"), "fresh data");
  await assert.rejects(access(staged));
});

test("local publication refuses special targets, selected stage symlinks, invalid paths and pre-dispatch abort", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles();
  const staged = join(dir, "stage"), final = join(dir, "final");
  await stage(files, staged, "new");
  await writeFile(final, "old");
  await symlink(final, join(dir, "link"));
  assert.deepEqual(await files.publish(staged, join(dir, "link"), { replace: true }), { ok: false, code: "not-file" });
  assert.deepEqual(await files.publish(join(dir, "link"), join(dir, "fresh"), { replace: false }), { ok: false, code: "invalid-request" });
  assert.deepEqual(await files.publish(staged, join(dir, "folder", "other"), { replace: false }), { ok: false, code: "invalid-request" });
  assert.deepEqual(await files.publish(staged, staged, { replace: true }), { ok: false, code: "invalid-request" });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await files.publish(staged, final, { replace: true }, abort.signal), { ok: false, code: "cancelled" });
  assert.equal(await readFile(final, "utf8"), "old");
  assert.equal(await readFile(staged, "utf8"), "new");
});

test("local publication refuses a substituted staging inode and never removes the substitute", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles();
  const staged = join(dir, "stage"), final = join(dir, "final");
  await stage(files, staged, "owned new data");
  await writeFile(final, "old unrelated data");
  await rename(staged, join(dir, "original-stage"));
  await writeFile(staged, "foreign substitute");
  for (const replace of [true, false]) assert.deepEqual(await files.publish(staged, final, { replace }), { ok: false, code: "invalid-request" });
  assert.equal(await readFile(final, "utf8"), "old unrelated data");
  assert.equal(await readFile(staged, "utf8"), "foreign substitute");
  assert.equal(await readFile(join(dir, "original-stage"), "utf8"), "owned new data");
});

test("local publication reports unknown if final is replaced or disappears after linking", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-publish-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const replacement of [false, true]) {
    const folder = join(dir, replacement ? "replaced" : "missing"); await mkdir(folder);
    const staged = join(folder, "stage"), final = join(folder, "final");
    let attemptedCleanup = false;
    const files = createLocalTransferFiles({ lstat, rename,
      link: async (source, destination) => {
        await link(source, destination);
        // Real filesystem race: the final pathname is removed or substituted after exclusive link.
        await unlink(destination);
        if (replacement) await writeFile(destination, "foreign final bytes");
      },
      unlink: async () => { attemptedCleanup = true; assert.fail("unknown publication must not remove any pathname"); },
    });
    await stage(files, staged, "owned staged bytes");
    assert.deepEqual(await files.publish(staged, final, { replace: false }), { ok: false, code: "publication-unknown" });
    assert.equal(attemptedCleanup, false);
    assert.equal(await readFile(staged, "utf8"), "owned staged bytes");
    if (replacement) assert.equal(await readFile(final, "utf8"), "foreign final bytes");
    else await assert.rejects(access(final));
  }
});

test("local publication succeeds with retained alias only when final still identifies the owned inode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-publish-stage-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const staged = join(dir, "stage"), final = join(dir, "final");
  const files = createLocalTransferFiles({ lstat, rename,
    link: async (source, destination) => {
      await link(source, destination);
      await unlink(source);
      await writeFile(source, "foreign stage bytes");
    },
    unlink: async () => assert.fail("a substituted stage must be retained"),
  });
  await stage(files, staged, "owned staged bytes");
  assert.deepEqual(await files.publish(staged, final, { replace: false }), { ok: true, value: { retainedPartial: true } });
  assert.equal(await readFile(final, "utf8"), "owned staged bytes");
  assert.equal(await readFile(staged, "utf8"), "foreign stage bytes");
});
