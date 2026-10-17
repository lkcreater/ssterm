import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteReader, RemoteWriter, RemoteAttributes } from "../../packages/domain/src/index.ts";
import { createTransferEngine, type TransferFileProvider, type TransferInput, type TransferJob, type TransferResult } from "../../packages/services/src/transfers.ts";

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  assert(check());
}
const done = (job: TransferJob) => ["completed", "cancelled", "failed"].includes(job.state);
function fixture(data = "abcdef", size: number | null = data.length) {
  const written: Buffer[] = [];
  let reads = 0, closes = 0, opens = 0;
  const reader: RemoteReader = { read: async (at, length) => { reads++; return ok(at >= data.length ? null : Buffer.from(data).subarray(at, at + Math.min(length, 2))); }, close: async () => { closes++; return ok(undefined); } };
  const writer: RemoteWriter = { write: async (_at, bytes) => { written.push(Buffer.from(bytes)); return ok(undefined); }, close: async () => { closes++; return ok(undefined); } };
  const source: TransferFileProvider = { maxRead: 20, maxWrite: 20, lstat: async () => ok({ type: "file", size, mtime: null, permissions: null }), openRead: async () => { opens++; return ok(reader); }, openWrite: async () => ok(writer) };
  const destination: TransferFileProvider = { ...source, maxWrite: 3, lstat: async () => ({ ok: false, code: "not-found" }) };
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

test("preflight refuses nonfiles and existing targets without opening, and exceptions stay private", async () => {
  const directory = fixture(); directory.source.lstat = async () => ok({ type: "directory", size: null, mtime: null, permissions: null });
  const existing = fixture(); existing.destination.lstat = existing.source.lstat;
  const thrown = fixture(); thrown.input.validate = () => { throw "SECRET unexpected provider text"; };
  const engine = createTransferEngine(); engine.enqueue("a", [directory.input, existing.input, thrown.input]);
  await until(() => engine.snapshot("a").every(done));
  assert.deepEqual(engine.snapshot("a").map((j) => j.error), ["not-file", "destination-exists", "failure"]);
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
