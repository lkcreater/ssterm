import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createLocalTransferFiles } from "../../packages/adapters/src/local-transfers.ts";
import type { RemoteReader, RemoteWriter, RemoteAttributes } from "../../packages/domain/src/index.ts";
import { createTransferEngine, type TransferFileProvider, type TransferInput, type TransferJob, type TransferResult } from "../../packages/services/src/transfers.ts";

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  assert(check());
}
const done = (job: TransferJob) => ["completed", "cancelled", "failed", "skipped"].includes(job.state);
function fixture(data = "abcdef", size: number | null = data.length) {
  const written: Buffer[] = [];
  let reads = 0, closes = 0, opens = 0;
  const reader: RemoteReader = { read: async (at, length) => { reads++; return ok(at >= data.length ? null : Buffer.from(data).subarray(at, at + Math.min(length, 2))); }, close: async () => { closes++; return ok(undefined); } };
  const writer: RemoteWriter = { write: async (_at, bytes) => { written.push(Buffer.from(bytes)); return ok(undefined); }, close: async () => { closes++; return ok(undefined); } };
  const source: TransferFileProvider = { maxRead: 20, maxWrite: 20, lstat: async () => ok({ type: "file", size, mtime: null, permissions: null }), openRead: async () => { opens++; return ok(reader); }, openWrite: async () => ok(writer) };
  const destination: TransferFileProvider = { ...source, maxWrite: 3, atomicReplace: true, lstat: async () => ({ ok: false, code: "not-found" }), publish: async () => ok({ retainedPartial: false }) };
  const input: TransferInput = { direction: "upload", sourcePath: "/source", destinationPath: "/destination", target: { label: "Owned", endpointHost: "127.0.0.1", endpointPort: 22, username: "fixture", environment: "DEV" }, sessionId: "session", generation: 1, source, destination, onStall() {} };
  return { input, source, destination, reader, writer, written, get reads() { return reads; }, get closes() { return closes; }, get opens() { return opens; } };
}

test("transfer short reads continue until EOF; acknowledged bytes and close gates determine completion", async () => {
  const f = fixture();
  const close = defer<Awaited<ReturnType<RemoteWriter["close"]>>>();
  f.writer.close = () => close.promise;
  const engine = createTransferEngine();
  engine.enqueue("owner", [f.input]);
  await until(() => engine.snapshot("owner")[0]!.bytes === 6);
  assert.equal(engine.snapshot("owner")[0]!.state, "running");
  assert.equal(Buffer.concat(f.written).toString(), "abcdef");
  assert.equal(f.reads, 4);
  close.resolve(ok(undefined));
  await until(() => done(engine.snapshot("owner")[0]!));
  assert.equal(engine.snapshot("owner")[0]!.state, "completed");
  assert.equal(engine.snapshot("owner")[0]!.partial, false);
  engine.dispose();
});

test("transfer size mismatch, unknown and zero sizes are represented accurately", async () => {
  for (const [data, size, total] of [["abc", 8, null], ["abc", 1, null], ["abc", null, null], ["", 0, 0]] as const) {
    const engine = createTransferEngine(); const f = fixture(data, size);
    engine.enqueue("owner", [f.input]);
    await until(() => done(engine.snapshot("owner")[0]!));
    assert.equal(engine.snapshot("owner")[0]!.total, total);
    assert.equal(engine.snapshot("owner")[0]!.bytes, data.length);
    engine.dispose();
  }
});

test("two global permits, owner isolation, retained-job cap and queued cancellation", async () => {
  const held = defer<TransferResult<RemoteAttributes>>();
  const f = fixture(); f.source.lstat = () => held.promise;
  const engine = createTransferEngine({ maxJobs: 4 });
  const first = engine.enqueue("a", [f.input, f.input, f.input]); assert(first.ok);
  const second = engine.enqueue("b", [f.input]); assert(second.ok);
  assert.deepEqual(engine.snapshot("a").map((j) => j.state), ["running", "running", "queued"]);
  assert.equal(engine.snapshot("b")[0]!.state, "queued");
  assert.deepEqual(engine.enqueue("a", [f.input]), { ok: false, code: "resource-limit" });
  assert.equal(engine.cancel("b", first.value[0]!.id), false);
  assert.equal(engine.cancel("a", first.value[2]!.id), true);
  assert.equal(engine.snapshot("a")[2]!.state, "cancelled");
  assert.deepEqual(engine.enqueue("a", [f.input]), { ok: false, code: "resource-limit" });
  engine.clearFinished("a");
  assert(engine.enqueue("a", [f.input]).ok);
  engine.dispose(); held.resolve(ok({ type: "file", size: 6, mtime: null, permissions: null }));
});

test("cancelled late native opens close and retain permits after history is cleared", async () => {
  const held = defer<TransferResult<RemoteReader>>();
  const f = fixture(); f.source.openRead = () => held.promise;
  const engine = createTransferEngine({ concurrency: 1 });
  engine.enqueue("a", [f.input]);
  await until(() => engine.snapshot("a")[0]!.total === 6);
  await new Promise((r) => setTimeout(r, 5));
  engine.cancel("a", engine.snapshot("a")[0]!.id);
  await until(() => done(engine.snapshot("a")[0]!));
  engine.clearFinished("a");
  const other = fixture(); engine.enqueue("b", [other.input]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(engine.snapshot("b")[0]!.state, "queued");
  held.resolve(ok(f.reader));
  await until(() => done(engine.snapshot("b")[0]!));
  assert.equal(f.closes, 1);
  engine.dispose();
});

test("cancel during read and write retains partial destination and prevents stale progress", async () => {
  for (const phase of ["read", "write"] as const) {
    const f = fixture();
    const held = defer<any>(); let entered = false;
    if (phase === "read") f.reader.read = () => { entered = true; return held.promise; };
    else f.writer.write = () => { entered = true; return held.promise; };
    const engine = createTransferEngine(); engine.enqueue("a", [f.input]);
    await until(() => entered);
    engine.cancel("a", engine.snapshot("a")[0]!.id);
    await until(() => done(engine.snapshot("a")[0]!));
    assert.equal(engine.snapshot("a")[0]!.state, "cancelled");
    assert.equal(engine.snapshot("a")[0]!.partial, true);
    held.resolve(phase === "read" ? ok(Buffer.from("late")) : ok(undefined));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(engine.snapshot("a")[0]!.bytes, 0);
    assert.equal(f.closes, 2);
    engine.dispose();
  }
});

test("timeout invalidates exact session, cleanup failure is not success, and unrelated jobs continue", async () => {
  const stalled = fixture(); let stalls = 0;
  stalled.input.direction = "download";
  const held = defer<TransferResult<RemoteAttributes>>(); stalled.source.lstat = () => held.promise;
  stalled.input.onStall = () => { stalls++; };
  const broken = fixture(); broken.writer.close = async () => ({ ok: false, code: "failure" });
  const good = fixture();
  const engine = createTransferEngine({ operationTimeoutMs: 15 });
  engine.enqueue("a", [stalled.input, broken.input, good.input]);
  await until(() => engine.snapshot("a").every(done));
  assert.deepEqual(engine.snapshot("a").map((j) => j.state), ["failed", "failed", "completed"]);
  assert.equal(engine.snapshot("a")[0]!.error, "timeout"); assert.equal(stalls, 1);
  assert.equal(engine.snapshot("a")[1]!.partial, true);
  held.resolve({ ok: false, code: "closed" }); engine.dispose();
});

test("generation cancellation and owner revoke fence queued work before I/O", async () => {
  const f = fixture(); const held = defer<TransferResult<RemoteAttributes>>(); f.source.lstat = () => held.promise;
  const engine = createTransferEngine({ concurrency: 1 });
  engine.enqueue("a", [f.input, { ...f.input, generation: 2 }]);
  engine.cancelSession("a", "session", 1, "connection-lost");
  await until(() => engine.snapshot("a")[0]!.state === "failed");
  assert.equal(engine.snapshot("a")[1]!.state, "queued");
  engine.revokeOwner("a"); assert.deepEqual(engine.snapshot("a"), []);
  held.resolve({ ok: false, code: "closed" });
  const good = fixture(); good.input.validate = () => false;
  engine.enqueue("b", [good.input]);
  await until(() => done(engine.snapshot("b")[0]!));
  assert.equal(engine.snapshot("b")[0]!.error, "closed"); assert.equal(good.opens, 0);
  engine.dispose();
});

test("local timeout quarantines a permit without closing the healthy SSH generation", async () => {
  const f = fixture(); let stalls = 0;
  const held = defer<TransferResult<RemoteAttributes>>();
  f.source.lstat = () => held.promise;
  f.input.onStall = () => { stalls++; };
  const engine = createTransferEngine({ concurrency: 1, operationTimeoutMs: 10, cleanupTimeoutMs: 10 });
  engine.enqueue("a", [f.input, fixture().input]);
  await until(() => done(engine.snapshot("a")[0]!));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(stalls, 0);
  assert.equal(engine.snapshot("a")[1]!.state, "queued");
  held.resolve({ ok: false, code: "cancelled" });
  await until(() => done(engine.snapshot("a")[1]!));
  engine.dispose();
});

test("remote close timeout fails the job and invalidates the captured generation", async () => {
  const f = fixture(); let stalls = 0;
  const held = defer<Awaited<ReturnType<RemoteWriter["close"]>>>();
  f.writer.close = () => held.promise;
  f.input.onStall = () => { stalls++; held.resolve({ ok: false, code: "closed" }); };
  const engine = createTransferEngine({ cleanupTimeoutMs: 10 });
  engine.enqueue("a", [f.input]);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(stalls, 1);
  assert.equal(engine.snapshot("a")[0]!.state, "failed");
  engine.dispose();
});

test("transfer chunks respect the 64KiB cap and negotiated destination limit", async () => {
  for (const maxWrite of [131_072, 7_000]) {
    const f = fixture("x".repeat(140_000));
    f.input.source = { ...f.source, maxRead: 131_072 };
    f.input.destination = { ...f.destination, maxWrite };
    const lengths: number[] = [];
    f.reader.read = async (at, length) => { lengths.push(length); return ok(at >= 140_000 ? null : Buffer.alloc(Math.min(length, 140_000 - at))); };
    const engine = createTransferEngine(); engine.enqueue("a", [f.input]);
    await until(() => done(engine.snapshot("a")[0]!));
    assert(lengths.every((length) => length === Math.min(65_536, maxWrite)));
    assert.equal(engine.snapshot("a")[0]!.bytes, 140_000);
    engine.dispose();
  }
});

test("preflight refuses nonfiles, existing targets wait for consent, and exceptions stay private", async () => {
  const directory = fixture(); directory.source.lstat = async () => ok({ type: "directory", size: null, mtime: null, permissions: null });
  const existing = fixture(); existing.destination.lstat = existing.source.lstat;
  const thrown = fixture(); thrown.input.validate = () => { throw "SECRET unexpected provider text"; };
  const engine = createTransferEngine(); engine.enqueue("a", [directory.input, existing.input, thrown.input]);
  await until(() => engine.snapshot("a")[1]!.state === "conflict");
  const conflict = engine.snapshot("a")[1]!;
  assert(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "skip", null).ok);
  await until(() => engine.snapshot("a").every(done));
  assert.deepEqual(engine.snapshot("a").map((j) => j.error), ["not-file", null, "failure"]);
  assert.equal(directory.opens + existing.opens + thrown.opens, 0);
  assert(!JSON.stringify(engine.snapshot("a")).includes("SECRET"));
  engine.dispose();
});

test("synchronous session invalidation preserves the originating timeout cause", async () => {
  const f = fixture(); const held = defer<TransferResult<RemoteAttributes>>();
  f.input.direction = "download"; f.source.lstat = () => held.promise;
  const engine = createTransferEngine({ operationTimeoutMs: 10 });
  f.input.onStall = () => { engine.cancelSession("a", "session", 1, "closed"); held.resolve({ ok: false, code: "closed" }); };
  engine.enqueue("a", [f.input]);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(engine.snapshot("a")[0]!.error, "timeout");
  engine.dispose();
});

test("pending count includes quarantined native work after timeout and history clear", async () => {
  const f = fixture(); const held = defer<TransferResult<RemoteAttributes>>();
  f.source.lstat = () => held.promise;
  const engine = createTransferEngine({ operationTimeoutMs: 10 });
  engine.enqueue("a", [f.input]);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(engine.pendingCount("a"), 1);
  assert.equal(engine.pendingCount("b"), 0);
  engine.clearFinished("a");
  assert.equal(engine.pendingCount("a"), 1);
  assert.deepEqual(engine.snapshot("a"), []);
  held.resolve({ ok: false, code: "cancelled" });
  await until(() => engine.pendingCount("a") === 0);
  engine.dispose();
});

test("conflicts release permits; owner, nonce and decision fence overwrite, skip and renamed basename", async () => {
  const f = fixture();
  f.destination.lstat = async (path) => path === "/destination" ? ok({ type: "file", size: 3, mtime: null, permissions: null }) : { ok: false, code: "not-found" };
  const publications: { staged: string; final: string; replace: boolean }[] = [];
  f.destination.publish = async (staged, final, { replace }) => { publications.push({ staged, final, replace }); return ok({ retainedPartial: false }); };
  const engine = createTransferEngine({ concurrency: 1 });
  engine.enqueue("a", [f.input, fixture().input]);
  await until(() => engine.snapshot("a")[0]!.state === "conflict" && done(engine.snapshot("a")[1]!));
  const conflict = engine.snapshot("a")[0]!;
  assert.equal(engine.pendingCount("a"), 1);
  assert.equal(f.opens, 0);
  assert.deepEqual(engine.resolveConflict("foreign", conflict.id, conflict.conflictId!, "overwrite", null), { ok: false, code: "invalid-request" });
  assert.deepEqual(engine.resolveConflict("a", conflict.id, "stale", "overwrite", null), { ok: false, code: "invalid-request" });
  for (const name of ["..", ".", "a/b", "", "bad\0", "\uFFFD", "x".repeat(1_025)])
    assert.deepEqual(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "rename", name), { ok: false, code: "invalid-path" });
  assert(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "rename", "ใหม่.txt").ok);
  assert.deepEqual(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "overwrite", null), { ok: false, code: "invalid-request" });
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(publications.length, 1);
  assert.equal(publications[0]!.final, "/ใหม่.txt");
  assert.equal(publications[0]!.replace, false);
  assert.match(publications[0]!.staged, /^\/\.ssterm-[a-f0-9-]+\.part$/);
  engine.dispose();
});

test("overwrite requires atomic replacement, skip does no I/O, and fresh overwrite rechecks target type", async () => {
  const unsupported = fixture(); unsupported.input.destination = { ...unsupported.destination, atomicReplace: false, lstat: unsupported.source.lstat };
  const engine = createTransferEngine(); engine.enqueue("a", [unsupported.input]);
  await until(() => engine.snapshot("a")[0]!.state === "conflict");
  const conflict = engine.snapshot("a")[0]!;
  assert.equal(conflict.atomicReplace, false);
  assert.deepEqual(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "overwrite", null), { ok: false, code: "unsupported" });
  assert(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "skip", null).ok);
  assert.equal(engine.snapshot("a")[0]!.state, "skipped");
  assert.equal(unsupported.opens, 0);
  const replaced = fixture(); let calls = 0, published = 0;
  replaced.destination.lstat = async () => ok({ type: ++calls >= 3 ? "symlink" : "file", size: 3, mtime: null, permissions: null });
  replaced.destination.publish = async () => { published++; return ok({ retainedPartial: false }); };
  engine.enqueue("b", [replaced.input]);
  await until(() => engine.snapshot("b")[0]!.state === "conflict");
  const other = engine.snapshot("b")[0]!;
  assert(engine.resolveConflict("b", other.id, other.conflictId!, "overwrite", null).ok);
  await until(() => done(engine.snapshot("b")[0]!));
  assert.equal(engine.snapshot("b")[0]!.error, "not-file");
  assert.equal(engine.snapshot("b")[0]!.partial, true);
  assert.equal(published, 0);
  engine.dispose();
});

test("publication follows successful closes, retains raced stages, and reports retained aliases", async () => {
  for (const retainedPartial of [false, true]) {
    const f = fixture(); let stage = "";
    f.destination.publish = async (staged) => { assert.equal(f.closes, 2); stage = staged; return ok({ retainedPartial }); };
    const engine = createTransferEngine(); engine.enqueue("a", [f.input]);
    await until(() => done(engine.snapshot("a")[0]!));
    const job = engine.snapshot("a")[0]!;
    assert.equal(job.state, "completed"); assert.equal(job.partial, retainedPartial);
    assert.equal(job.partialPath, retainedPartial ? stage : null);
    engine.dispose();
  }
  const raced = fixture(); let lstat = 0;
  raced.destination.lstat = async () => ++lstat > 1 ? ok({ type: "file", size: 99, mtime: null, permissions: null }) : { ok: false, code: "not-found" };
  raced.destination.publish = async () => ({ ok: false, code: "failure" });
  const engine = createTransferEngine(); engine.enqueue("a", [raced.input]);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(engine.snapshot("a")[0]!.error, "destination-exists");
  assert.equal(engine.snapshot("a")[0]!.partial, true);
  assert.match(engine.snapshot("a")[0]!.partialPath!, /^\/\.ssterm-.*\.part$/);
  engine.dispose();
});

test("publication cancel is refused; acknowledged success wins lifecycle close, lost reply is unknown", async () => {
  for (const acknowledged of [true, false]) {
    const f = fixture(); const held = defer<TransferResult<{ retainedPartial: boolean }>>(); let entered = false;
    f.destination.publish = () => { entered = true; return held.promise; };
    const engine = createTransferEngine(); engine.enqueue("a", [f.input]);
    await until(() => entered);
    const id = engine.snapshot("a")[0]!.id;
    assert.equal(engine.snapshot("a")[0]!.state, "publishing");
    assert.equal(engine.cancel("a", id), false);
    engine.cancelSession("a", "session", 1, "connection-lost");
    held.resolve(acknowledged ? ok({ retainedPartial: false }) : { ok: false, code: "closed" });
    await until(() => done(engine.snapshot("a")[0]!));
    assert.equal(engine.snapshot("a")[0]!.state, acknowledged ? "completed" : "failed");
    assert.equal(engine.snapshot("a")[0]!.error, acknowledged ? null : "publication-unknown");
    if (!acknowledged) assert.deepEqual(engine.retry("a", id), { ok: false, code: "invalid-request" });
    engine.dispose();
  }
});

test("timeout after dispatch is unknown; lifecycle abort before dispatch suppresses publication", async () => {
  const f = fixture(); const held = defer<TransferResult<{ retainedPartial: boolean }>>();
  f.destination.publish = () => held.promise;
  const engine = createTransferEngine({ operationTimeoutMs: 10 }); engine.enqueue("a", [f.input]);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(engine.snapshot("a")[0]!.error, "publication-unknown");
  held.resolve(ok({ retainedPartial: false }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.snapshot("a")[0]!.error, "publication-unknown");
  const before = fixture(); let publications = 0;
  before.destination.publish = async () => { publications++; return ok({ retainedPartial: false }); };
  engine.subscribe("b", (jobs) => { if (jobs[0]?.state === "publishing") engine.cancelSession("b", "session", 1, "closed"); });
  engine.enqueue("b", [before.input]);
  await until(() => done(engine.snapshot("b")[0]!));
  assert.equal(publications, 0);
  assert.equal(engine.snapshot("b")[0]!.error, "closed");
  engine.dispose();
});

test("retry uses a fresh stage and conflict nonce, requires same live generation, and keeps prior partial", async () => {
  const f = fixture(); f.destination.lstat = f.source.lstat;
  let live = true;
  f.input.validate = () => live;
  const stages: string[] = []; let failWrite = true;
  f.destination.openWrite = async (path) => { stages.push(path); return ok(f.writer); };
  f.writer.write = async () => failWrite ? { ok: false, code: "quota-exceeded" } : ok(undefined);
  const engine = createTransferEngine(); engine.enqueue("a", [f.input]);
  await until(() => engine.snapshot("a")[0]!.state === "conflict");
  const original = engine.snapshot("a")[0]!;
  assert(engine.resolveConflict("a", original.id, original.conflictId!, "overwrite", null).ok);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(engine.snapshot("a")[0]!.error, "quota-exceeded");
  await until(() => engine.pendingCount("a") === 0);
  live = false;
  assert.deepEqual(engine.retry("a", original.id), { ok: false, code: "closed" });
  live = true;
  const retry = engine.retry("a", original.id); assert(retry.ok);
  await until(() => engine.snapshot("a")[1]!.state === "conflict");
  const fresh = engine.snapshot("a")[1]!;
  assert.notEqual(fresh.id, original.id); assert.notEqual(fresh.conflictId, original.conflictId);
  assert.deepEqual(engine.resolveConflict("a", fresh.id, original.conflictId!, "overwrite", null), { ok: false, code: "invalid-request" });
  failWrite = false;
  assert(engine.resolveConflict("a", fresh.id, fresh.conflictId!, "overwrite", null).ok);
  await until(() => done(engine.snapshot("a")[1]!));
  assert.equal(engine.snapshot("a")[1]!.state, "completed");
  assert.notEqual(stages[0], stages[1]);
  assert.equal(engine.snapshot("a")[0]!.partialPath, stages[0]);
  engine.dispose();
});

test("real local old hashes survive failed/cancelled overwrite, then approved publish replaces fully", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-overwrite-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles();
  const sourcePath = join(dir, "source"), destinationPath = join(dir, "destination");
  await writeFile(sourcePath, "owned new content".repeat(10_000));
  await writeFile(destinationPath, "unrelated old content");
  const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const oldHash = await hash(destinationPath);
  for (const failure of ["permission-denied", "no-space", "quota-exceeded", "cancelled", null] as const) {
    const f = fixture();
    const input: TransferInput = { ...f.input, direction: "download", sourcePath, destinationPath, source: files, destination: failure ? { ...files, publish: async () => ({ ok: false, code: failure }) } : files };
    const engine = createTransferEngine(); engine.enqueue("a", [input]);
    await until(() => engine.snapshot("a")[0]!.state === "conflict");
    const conflict = engine.snapshot("a")[0]!;
    assert(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "overwrite", null).ok);
    await until(() => done(engine.snapshot("a")[0]!));
    assert.equal(await hash(destinationPath), failure ? oldHash : await hash(sourcePath));
    if (failure) {
      assert.equal(engine.snapshot("a")[0]!.partial, true);
      assert.equal(await hash(engine.snapshot("a")[0]!.partialPath!), await hash(sourcePath));
    }
    engine.dispose();
  }
});

test("approved transfer onto its source closes the reader before replacing that path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ssterm-self-copy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createLocalTransferFiles(), path = join(dir, "same");
  const content = "source remains whole".repeat(10_000);
  await writeFile(path, content);
  const f = fixture();
  const engine = createTransferEngine();
  engine.enqueue("a", [{ ...f.input, direction: "download", sourcePath: path, destinationPath: path, source: files, destination: files }]);
  await until(() => engine.snapshot("a")[0]!.state === "conflict");
  const conflict = engine.snapshot("a")[0]!;
  assert(engine.resolveConflict("a", conflict.id, conflict.conflictId!, "overwrite", null).ok);
  await until(() => done(engine.snapshot("a")[0]!));
  assert.equal(engine.snapshot("a")[0]!.state, "completed");
  assert.equal(await readFile(path, "utf8"), content);
  engine.dispose();
});
