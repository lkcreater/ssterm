import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createLocalTransferFiles } from "../../packages/adapters/src/local-transfers.ts";

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
